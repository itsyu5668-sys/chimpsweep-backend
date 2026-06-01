const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { requireAuth, requireActiveSubscription } = require('../middleware/auth');
const { getAudienceSnapshot, runCleanup, undoCleanupRun } = require('../services/cleanup');

// ─────────────────────────────────────────────
// GET /api/dashboard/summary
// Returns the waste summary for the dashboard
// Refreshes the snapshot from Mailchimp live
// ─────────────────────────────────────────────
router.get('/summary', requireAuth, requireActiveSubscription, async (req, res) => {
  try {
    const snapshot = await getAudienceSnapshot(req.user);

    if (snapshot.error) {
      return res.status(400).json({ error: snapshot.error });
    }

    // Strip internal arrays before returning
    const { _unsubscribed, _bounced, _duplicates, ...publicSnapshot } = snapshot;

    res.json({
      summary: publicSnapshot,
      savings_note: 'Archiving today will reduce your NEXT Mailchimp bill. Savings appear after your current billing cycle.',
    });
  } catch (err) {
    console.error('Dashboard summary error:', err.message);
    res.status(500).json({ error: 'Failed to load summary' });
  }
});

// ─────────────────────────────────────────────
// POST /api/dashboard/cleanup
// Triggers a manual one-click cleanup
// ─────────────────────────────────────────────
router.post('/cleanup', requireAuth, requireActiveSubscription, async (req, res) => {
  try {
    const result = await runCleanup(req.user, 'manual');

    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    res.json({
      ...result,
      savings_note: `Archive this month → save next month. Estimated savings on your next bill: $${(result.estimated_savings_cents / 100).toFixed(2)}`,
    });
  } catch (err) {
    console.error('Cleanup error:', err.message);
    res.status(500).json({ error: 'Cleanup failed. Please try again.' });
  }
});

// ─────────────────────────────────────────────
// GET /api/dashboard/history
// Returns all cleanup runs for this user
// ─────────────────────────────────────────────
router.get('/history', requireAuth, requireActiveSubscription, async (req, res) => {
  const { data: runs, error } = await supabase
    .from('cleanup_runs')
    .select('*')
    .eq('user_id', req.user.id)
    .order('started_at', { ascending: false })
    .limit(20);

  if (error) {
    return res.status(500).json({ error: 'Failed to load cleanup history' });
  }

  res.json({ runs });
});

// ─────────────────────────────────────────────
// POST /api/dashboard/undo/:runId
// Restores all contacts from a cleanup run
// Pro plan only + within 30 days
// ─────────────────────────────────────────────
router.post('/undo/:runId', requireAuth, requireActiveSubscription, async (req, res) => {
  // Only Pro users can undo
  if (req.user.plan !== 'pro') {
    return res.status(403).json({
      error: 'Undo is a Pro feature. Upgrade to restore contacts.',
      code: 'PRO_REQUIRED',
    });
  }

  try {
    const result = await undoCleanupRun(req.user, req.params.runId);
    res.json(result);
  } catch (err) {
    console.error('Undo error:', err.message);
    res.status(500).json({ error: 'Undo failed. Please try again.' });
  }
});

// ─────────────────────────────────────────────
// GET /api/dashboard/health
// Returns just the health score + breakdown (lightweight endpoint)
// ─────────────────────────────────────────────
router.get('/health', requireAuth, requireActiveSubscription, async (req, res) => {
  // Pull the most recent snapshot from DB (don't hit Mailchimp again)
  const { data: snapshot, error } = await supabase
    .from('audience_snapshots')
    .select('health_score, total_contacts, subscribed_count, unsubscribed_count, bounced_count, duplicate_count, snapshot_taken_at')
    .eq('user_id', req.user.id)
    .order('snapshot_taken_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !snapshot) {
    return res.status(404).json({ error: 'No health data yet. Run a summary first.' });
  }

  let healthLabel = 'Excellent';
  if (snapshot.health_score < 40) healthLabel = 'Poor';
  else if (snapshot.health_score < 60) healthLabel = 'Fair';
  else if (snapshot.health_score < 80) healthLabel = 'Good';

  res.json({
    health_score: snapshot.health_score,
    health_label: healthLabel,
    breakdown: {
      total_contacts: snapshot.total_contacts,
      subscribed: snapshot.subscribed_count,
      unsubscribed: snapshot.unsubscribed_count,
      bounced: snapshot.bounced_count,
      duplicates: snapshot.duplicate_count,
    },
    last_updated: snapshot.snapshot_taken_at,
  });
});

module.exports = router;
// Build command fix
