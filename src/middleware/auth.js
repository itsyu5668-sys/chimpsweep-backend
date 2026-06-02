const supabase = require('../lib/supabase');

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });

  const { data: user, error } = await supabase
    .from('users').select('*').eq('id', token).single();

  if (error || !user) return res.status(401).json({ error: 'Invalid or expired session' });

  req.user = user;
  next();
}

async function requireActiveSubscription(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });

  const user = req.user;

  // ── Beta plan check ──
  if (user.plan === 'beta') {
    if (!user.beta_expires_at || new Date(user.beta_expires_at) < new Date()) {
      return res.status(403).json({
        error: 'Your beta access has expired.',
        code: 'BETA_EXPIRED',
        redirect: '/pricing'
      });
    }
    return next(); // Beta is valid — let them through
  }

  // ── Paid plan check ──
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

function getWorkflowRedirect(user) {
  const step = user.onboarding_step;
  const subStatus = user.subscription_status;

  // ── Beta users go straight to dashboard ──
  if (user.plan === 'beta') {
    if (user.beta_expires_at && new Date(user.beta_expires_at) < new Date()) {
      return { redirect: '/pricing', reason: 'beta_expired' };
    }
    return { redirect: '/dashboard', reason: 'complete' };
  }

  if (step === 'connected') {
    return { redirect: '/pricing', reason: 'plan_not_selected' };
  }

  if (step === 'plan_selected') {
    if (subStatus !== 'active') return { redirect: '/pricing', reason: 'payment_incomplete' };
    return { redirect: '/dashboard', reason: 'complete' };
  }

  if (step === 'active') {
    if (subStatus !== 'active') return { redirect: '/pricing', reason: 'subscription_inactive' };
    return { redirect: '/dashboard', reason: 'complete' };
  }

  return { redirect: '/pricing', reason: 'unknown' };
}

module.exports = { requireAuth, requireActiveSubscription, getWorkflowRedirect };
