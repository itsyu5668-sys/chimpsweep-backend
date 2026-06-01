const express = require('express');
const axios = require('axios');
const router = express.Router();
const supabase = require('../lib/supabase');
const { getWorkflowRedirect } = require('../middleware/auth');

const MAILCHIMP_AUTH_URL = 'https://login.mailchimp.com/oauth2/authorize';
const MAILCHIMP_TOKEN_URL = 'https://login.mailchimp.com/oauth2/token';
const MAILCHIMP_METADATA_URL = 'https://login.mailchimp.com/oauth2/metadata';

// ─────────────────────────────────────────────
// GET /api/auth/mailchimp
// Step 1: Redirect user to Mailchimp OAuth
// ─────────────────────────────────────────────
router.get('/mailchimp', (req, res) => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.MAILCHIMP_CLIENT_ID,
    redirect_uri: process.env.MAILCHIMP_REDIRECT_URI,
  });

  res.redirect(`${MAILCHIMP_AUTH_URL}?${params.toString()}`);
});

// ─────────────────────────────────────────────
// GET /api/auth/mailchimp/callback
// Step 2: Mailchimp redirects here with a code
// Exchange code for access token, upsert user, redirect to correct step
// ─────────────────────────────────────────────
router.get('/mailchimp/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.redirect(`${process.env.FRONTEND_URL}/auth/error?reason=mailchimp_denied`);
  }

  try {
    // Exchange code for access token
    const tokenResponse = await axios.post(
      MAILCHIMP_TOKEN_URL,
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.MAILCHIMP_CLIENT_ID,
        client_secret: process.env.MAILCHIMP_CLIENT_SECRET,
        redirect_uri: process.env.MAILCHIMP_REDIRECT_URI,
        code,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token } = tokenResponse.data;

    // Get user metadata (dc = server prefix like "us1")
    const metaResponse = await axios.get(MAILCHIMP_METADATA_URL, {
      headers: { Authorization: `OAuth ${access_token}` },
    });

    const { login, dc: serverPrefix, accountname } = metaResponse.data;
    const mailchimpUserId = login.login_id?.toString() || login.email;

    // Upsert user — if they exist, update the token; if not, create them
    const { data: user, error: upsertError } = await supabase
      .from('users')
      .upsert(
        {
          mailchimp_user_id: mailchimpUserId,
          mailchimp_login: login.email || accountname,
          mailchimp_access_token: access_token,
          mailchimp_server_prefix: serverPrefix,
          // Only set onboarding_step if this is a brand new user
          // For existing users, keep whatever step they're on
        },
        {
          onConflict: 'mailchimp_user_id',
          ignoreDuplicates: false,
        }
      )
      .select()
      .single();

    if (upsertError) throw upsertError;

    // Determine where to send this user based on their workflow step
    const { redirect } = getWorkflowRedirect(user);

    // Send them to the frontend with their user ID as the session token
    // (simple approach — user ID in URL, frontend stores it)
    res.redirect(`${process.env.FRONTEND_URL}/auth/success?token=${user.id}&redirect=${redirect}`);
  } catch (err) {
    console.error('Mailchimp OAuth error:', err.message);
    res.redirect(`${process.env.FRONTEND_URL}/auth/error?reason=oauth_failed`);
  }
});

// ─────────────────────────────────────────────
// GET /api/auth/me
// Returns the current user's info and where they should be in the workflow
// Frontend calls this on load to check session
// ─────────────────────────────────────────────
router.get('/me', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'No token' });
  }

  const { data: user, error } = await supabase
    .from('users')
    .select('id, mailchimp_login, onboarding_step, plan, subscription_status, subscription_current_period_end, created_at')
    .eq('id', token)
    .single();

  if (error || !user) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  const workflowState = getWorkflowRedirect(user);

  res.json({
    user: {
      id: user.id,
      email: user.mailchimp_login,
      plan: user.plan,
      subscription_status: user.subscription_status,
      onboarding_step: user.onboarding_step,
      subscription_current_period_end: user.subscription_current_period_end,
    },
    workflow: workflowState,
  });
});

// ─────────────────────────────────────────────
// POST /api/auth/logout
// Client just deletes their token, but we can use this for cleanup
// ─────────────────────────────────────────────
router.post('/logout', (req, res) => {
  // Stateless — client deletes token from localStorage
  res.json({ success: true });
});

module.exports = router;
