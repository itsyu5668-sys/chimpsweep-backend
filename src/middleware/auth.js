const supabase = require('../lib/supabase');

// ─────────────────────────────────────────────
// requireAuth
// Validates the session token from the request header
// and attaches the user to req.user
// ─────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', token)
    .single();

  if (error || !user) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  req.user = user;
  next();
}

// ─────────────────────────────────────────────
// requireActiveSubscription
// Used on routes that need a paid plan
// ─────────────────────────────────────────────
async function requireActiveSubscription(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const user = req.user;
  const isActive = user.subscription_status === 'active';
  const notExpired = user.subscription_current_period_end
    ? new Date(user.subscription_current_period_end) > new Date()
    : false;

  if (!isActive || !notExpired) {
    return res.status(403).json({
      error: 'Active subscription required',
      code: 'SUBSCRIPTION_REQUIRED',
      redirect: '/pricing'
    });
  }

  next();
}

// ─────────────────────────────────────────────
// getWorkflowRedirect
// Given a user object, returns where they should be redirected
// This is the core of the workflow guard logic
//
// Steps:
//   connected       → must select a plan   → /pricing
//   plan_selected   → subscription active? → /dashboard (or /pricing if not paid)
//   active          → /dashboard
// ─────────────────────────────────────────────
function getWorkflowRedirect(user) {
  const step = user.onboarding_step;
  const subStatus = user.subscription_status;

  if (step === 'connected') {
    // They connected Mailchimp but haven't picked a plan
    return { redirect: '/pricing', reason: 'plan_not_selected' };
  }

  if (step === 'plan_selected') {
    // They picked a plan but payment may not have completed
    if (subStatus !== 'active') {
      return { redirect: '/pricing', reason: 'payment_incomplete' };
    }
    // Payment done, mark as active
    return { redirect: '/dashboard', reason: 'complete' };
  }

  if (step === 'active') {
    if (subStatus !== 'active') {
      // Subscription lapsed - send back to pricing
      return { redirect: '/pricing', reason: 'subscription_inactive' };
    }
    return { redirect: '/dashboard', reason: 'complete' };
  }

  // Default fallback
  return { redirect: '/pricing', reason: 'unknown' };
}

module.exports = { requireAuth, requireActiveSubscription, getWorkflowRedirect };
