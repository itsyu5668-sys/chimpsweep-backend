const cron = require('node-cron');
const supabase = require('../lib/supabase');
const { runCleanup } = require('./cleanup');

// ─────────────────────────────────────────────
// Weekly Auto-Clean Cron
// Runs every Monday at 2:00 AM UTC
// Archives waste contacts for all active Pro users
// ─────────────────────────────────────────────
function startCronJobs() {
  cron.schedule('0 2 * * 1', async () => {
    console.log('[CRON] Starting weekly auto-clean...');

    // Fetch all active Pro users
    const { data: proUsers, error } = await supabase
      .from('users')
      .select('*')
      .eq('plan', 'pro')
      .eq('subscription_status', 'active');

    if (error) {
      console.error('[CRON] Failed to fetch Pro users:', error.message);
      return;
    }

    console.log(`[CRON] Running cleanup for ${proUsers.length} Pro users`);

    // Run cleanup for each user sequentially to avoid rate limit issues
    for (const user of proUsers) {
      try {
        const result = await runCleanup(user, 'cron');
        console.log(`[CRON] ✓ User ${user.id}: archived ${result.total_archived} contacts`);
      } catch (err) {
        console.error(`[CRON] ✗ User ${user.id} failed:`, err.message);
      }

      // Small delay between users to be kind to the Mailchimp API
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log('[CRON] Weekly auto-clean complete.');
  });

  // ─────────────────────────────────────────────
  // Expired archived contacts cleanup
  // Runs every day at 3:00 AM UTC
  // Deletes archived_contacts records older than 30 days
  // ─────────────────────────────────────────────
  cron.schedule('0 3 * * *', async () => {
    console.log('[CRON] Cleaning up expired archived contact records...');

    const { error, count } = await supabase
      .from('archived_contacts')
      .delete({ count: 'exact' })
      .lt('expires_at', new Date().toISOString());

    if (error) {
      console.error('[CRON] Failed to clean expired records:', error.message);
    } else {
      console.log(`[CRON] Deleted ${count} expired archived contact records`);
    }
  });

  console.log('[CRON] Cron jobs registered.');
}

module.exports = { startCronJobs };
