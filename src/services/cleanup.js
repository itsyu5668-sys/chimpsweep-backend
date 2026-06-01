const supabase = require('../lib/supabase');
const mailchimp = require('./mailchimp');

// ─────────────────────────────────────────────
// calculateHealthScore
// Returns a score 0-100 based on list hygiene
// Higher = healthier list
// ─────────────────────────────────────────────
function calculateHealthScore({ totalContacts, subscribedCount, unsubscribedCount, bouncedCount, duplicateCount }) {
  if (totalContacts === 0) return 100;

  const wasteCount = unsubscribedCount + bouncedCount + duplicateCount;
  const wasteRatio = wasteCount / totalContacts;

  // Score starts at 100 and gets deducted
  let score = 100;

  if (wasteRatio > 0.5) score -= 50;
  else if (wasteRatio > 0.3) score -= 30;
  else if (wasteRatio > 0.2) score -= 20;
  else if (wasteRatio > 0.1) score -= 10;
  else if (wasteRatio > 0.05) score -= 5;

  // Additional deductions for large absolute waste numbers
  if (bouncedCount > 500) score -= 10;
  else if (bouncedCount > 100) score -= 5;

  return Math.max(0, Math.min(100, score));
}

// ─────────────────────────────────────────────
// getAudienceSnapshot
// Scans a user's Mailchimp audience and returns a waste summary
// This is what populates the dashboard "waste report"
// ─────────────────────────────────────────────
async function getAudienceSnapshot(user) {
  const audiences = await mailchimp.getAllAudiences(user);

  if (!audiences.length) {
    return { error: 'No Mailchimp audiences found' };
  }

  // Use the first/primary audience
  // TODO: if users have multiple audiences, we could let them pick
  const audience = audiences[0];
  const audienceInfo = await mailchimp.getAudienceInfo(user, audience.id);

  // Fetch waste contacts
  const [unsubscribed, bounced, subscribed] = await Promise.all([
    mailchimp.getAllContactsByStatus(user, audience.id, 'unsubscribed'),
    mailchimp.getAllContactsByStatus(user, audience.id, 'cleaned'), // 'cleaned' = hard bounced
    mailchimp.getAllContactsByStatus(user, audience.id, 'subscribed'),
  ]);

  // Find duplicates across ALL contacts
  const allContacts = [...subscribed, ...unsubscribed, ...bounced];
  const duplicates = mailchimp.findDuplicates(allContacts);

  const totalContacts = audienceInfo.stats?.member_count || allContacts.length;
  const unsubscribedCount = unsubscribed.length;
  const bouncedCount = bounced.length;
  const duplicateCount = duplicates.length;
  const billableCount = audienceInfo.stats?.member_count || totalContacts;
  const wasteCount = unsubscribedCount + bouncedCount + duplicateCount;

  const savings = mailchimp.estimateMonthlySavings(billableCount, wasteCount);

  const healthScore = calculateHealthScore({
    totalContacts,
    subscribedCount: subscribed.length,
    unsubscribedCount,
    bouncedCount,
    duplicateCount,
  });

  const snapshot = {
    audience_id: audience.id,
    audience_name: audience.name,
    total_contacts: totalContacts,
    subscribed_count: subscribed.length,
    unsubscribed_count: unsubscribedCount,
    bounced_count: bouncedCount,
    duplicate_count: duplicateCount,
    billable_contact_count: billableCount,
    current_plan_price_cents: savings.current_price_cents,
    estimated_savings_cents: savings.savings_cents,
    health_score: healthScore,
  };

  // Save snapshot to DB
  await supabase.from('audience_snapshots').insert({
    user_id: user.id,
    ...snapshot,
  });

  return {
    ...snapshot,
    // Return the actual contact arrays for cleanup use
    _unsubscribed: unsubscribed,
    _bounced: bounced,
    _duplicates: duplicates,
  };
}

// ─────────────────────────────────────────────
// runCleanup
// Archives all waste contacts for a user
// Records every archived contact for potential undo
// ─────────────────────────────────────────────
async function runCleanup(user, triggeredBy = 'manual') {
  // Create a cleanup run record
  const { data: run, error: runError } = await supabase
    .from('cleanup_runs')
    .insert({
      user_id: user.id,
      triggered_by: triggeredBy,
      status: 'running',
    })
    .select()
    .single();

  if (runError) throw runError;

  try {
    // Get the audience snapshot with contact data
    const snapshot = await getAudienceSnapshot(user);

    if (snapshot.error) {
      await supabase
        .from('cleanup_runs')
        .update({ status: 'failed', error_message: snapshot.error, completed_at: new Date().toISOString() })
        .eq('id', run.id);
      return { error: snapshot.error };
    }

    const { audience_id } = snapshot;
    const toArchive = [
      ...snapshot._unsubscribed.map(c => ({ ...c, reason: 'unsubscribed' })),
      ...snapshot._bounced.map(c => ({ ...c, reason: 'bounced' })),
      ...snapshot._duplicates.map(c => ({ ...c, reason: 'duplicate' })),
    ];

    let archivedCount = 0;
    const archivedRecords = [];

    // Archive each contact and record it
    for (const contact of toArchive) {
      try {
        await mailchimp.archiveContact(user, audience_id, contact.id);

        archivedRecords.push({
          user_id: user.id,
          cleanup_run_id: run.id,
          mailchimp_contact_id: contact.id,
          email_address: contact.email_address,
          first_name: contact.merge_fields?.FNAME || null,
          last_name: contact.merge_fields?.LNAME || null,
          original_status: contact.status,
          reason_archived: contact.reason,
        });

        archivedCount++;
      } catch (err) {
        // If one contact fails, log it but keep going
        console.error(`Failed to archive contact ${contact.email_address}:`, err.message);
      }
    }

    // Bulk insert the archived contact records (for undo)
    if (archivedRecords.length > 0) {
      await supabase.from('archived_contacts').insert(archivedRecords);
    }

    // Update the cleanup run with results
    await supabase
      .from('cleanup_runs')
      .update({
        status: 'completed',
        unsubscribed_archived: snapshot._unsubscribed.length,
        bounced_archived: snapshot._bounced.length,
        duplicates_archived: snapshot._duplicates.length,
        total_archived: archivedCount,
        estimated_savings_cents: snapshot.estimated_savings_cents,
        completed_at: new Date().toISOString(),
      })
      .eq('id', run.id);

    return {
      run_id: run.id,
      total_archived: archivedCount,
      unsubscribed_archived: snapshot._unsubscribed.length,
      bounced_archived: snapshot._bounced.length,
      duplicates_archived: snapshot._duplicates.length,
      estimated_savings_cents: snapshot.estimated_savings_cents,
      message: `Archived ${archivedCount} contacts. Your next Mailchimp bill will be ~$${(snapshot.estimated_savings_cents / 100).toFixed(2)} lower.`,
    };
  } catch (err) {
    await supabase
      .from('cleanup_runs')
      .update({ status: 'failed', error_message: err.message, completed_at: new Date().toISOString() })
      .eq('id', run.id);

    throw err;
  }
}

// ─────────────────────────────────────────────
// undoCleanupRun
// Restores all contacts from a specific cleanup run back to original status
// Only available for Pro users, within 30 days
// ─────────────────────────────────────────────
async function undoCleanupRun(user, runId) {
  // Fetch all archived contacts from this run that haven't been restored yet
  const { data: contacts, error } = await supabase
    .from('archived_contacts')
    .select('*')
    .eq('cleanup_run_id', runId)
    .eq('user_id', user.id)
    .is('restored_at', null)
    .gt('expires_at', new Date().toISOString()); // Only within 30 days

  if (error) throw error;
  if (!contacts.length) {
    return { restored: 0, message: 'No contacts to restore (expired or already restored)' };
  }

  // Get audience ID from the snapshot
  const { data: snapshot } = await supabase
    .from('audience_snapshots')
    .select('audience_id')
    .eq('user_id', user.id)
    .order('snapshot_taken_at', { ascending: false })
    .limit(1)
    .single();

  const audienceId = snapshot?.audience_id;
  if (!audienceId) throw new Error('Could not determine audience ID for restore');

  let restoredCount = 0;

  for (const contact of contacts) {
    try {
      await mailchimp.restoreContact(user, audienceId, contact.mailchimp_contact_id, contact.original_status);

      await supabase
        .from('archived_contacts')
        .update({ restored_at: new Date().toISOString() })
        .eq('id', contact.id);

      restoredCount++;
    } catch (err) {
      console.error(`Failed to restore contact ${contact.email_address}:`, err.message);
    }
  }

  return {
    restored: restoredCount,
    message: `Restored ${restoredCount} contacts back to their original status.`,
  };
}

module.exports = { getAudienceSnapshot, runCleanup, undoCleanupRun, calculateHealthScore };
