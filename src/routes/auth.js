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
  const clientId = process.env.MAILCHIMP_CLIENT_ID;
  const redirectUri = process.env.MAILCHIMP_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    console.error('Missing MAILCHIMP_CLIENT_ID or MAILCHIMP_REDIRECT_URI');
    return res.status(500).send('OAuth misconfigured');
  }

  const mailchimpAuthUrl = `${MAILCHIMP_AUTH_URL}?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}`;

  console.log('🔐 OAuth redirect URL:', mailchimpAuthUrl);
  res.redirect(mailchimpAuthUrl);
});

// ─────────────────────────────────────────────
// GET /api/auth/mailchimp/callback
// Step 2: Mailchimp redirects here with a code
// Exchange code for access token, upsert user, redirect to correct step
// ─────────────────────────────────────────────
router.get('/mailchimp/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    console.error('Mailchimp OAuth error param:', error);
    return res.redirect(`${process.env.FRONTEND_URL}/auth/error?reason=mailchimp_denied`);
  }

  if (!code) {
    console.error('No code provided in callback');
    return res.redirect(`${process.env.FRONTEND_URL}/auth/error?reason=no_code`);
  }

  try {
    // 1. Exchange code for access token
    console.log('📝 Exchanging code for access token...');
    console.log('   Token URL:', MAILCHIMP_TOKEN_URL);
    console.log('   Client ID:', process.env.MAILCHIMP_CLIENT_ID);
    console.log('   Redirect URI:', process.env.MAILCHIMP_REDIRECT_URI);

    const tokenResponse = await axios.post(
      MAILCHIMP_TOKEN_URL,
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.MAILCHIMP_CLIENT_ID,
        client_secret: process.env.MAILCHIMP_CLIENT_SECRET,
        redirect_uri: process.env.MAILCHIMP_REDIRECT_URI,
        code,
      }),
      { 
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        validateStatus: () => true, // Don't throw on any status code
      }
    );

    console.log('✅ Token response status:', tokenResponse.status);
    console.log('📄 Token response body:', JSON.stringify(tokenResponse.data, null, 2));

    if (tokenResponse.status !== 200 || !tokenResponse.data.access_token) {
      console.error('❌ Token exchange failed:', tokenResponse.data);
      return res.redirect(`${process.env.FRONTEND_URL}/auth/error?reason=token_exchange_failed`);
    }

    const { access_token } = tokenResponse.data;
    console.log('✨ Access token received (first 20 chars):', access_token.substring(0, 20) + '...');

    // 2. Get metadata using the access token
    console.log('🔍 Fetching metadata with access token...');
    const metadataResponse = await axios.get(MAILCHIMP_METADATA_URL, {
      headers: { Authorization: `OAuth ${access_token}` },
      validateStatus: () => true, // Don't throw on any status code
    });

    console.log('✅ Metadata response status:', metadataResponse.status);
    console.log('📄 Metadata body:', JSON.stringify(metadataResponse.data, null, 2));

    if (metadataResponse.status !== 200 || !metadataResponse.data.dc) {
      console.error('❌ Metadata fetch failed:', metadataResponse.data);
      return res.redirect(`${process.env.FRONTEND_URL}/auth/error?reason=metadata_fetch_failed`);
    }

    const { login, dc: serverPrefix, accountname } = metadataResponse.data;
    const mailchimpUserId = login.login_id?.toString() || login.email;

    console.log('👤 User ID:', mailchimpUserId);
    console.log('🗺️ Server prefix:', serverPrefix);

    // 3. Check if user already exists
    const { data: existingUser } = await supabase
      .from('users')
      .select('id, onboarding_step, plan, subscription_status')
      .eq('mailchimp_user_id', mailchimpUserId)
      .single();

    let user;
    
    if (existingUser) {
      console.log('📝 Updating existing user:', existingUser.id);
      // Existing user - update token but keep their onboarding step
      const { data: updatedUser, error: updateError } = await supabase
        .from('users')
        .update({
          mailchimp_login: login.email || accountname,
          mailchimp_access_token: access_token,
          mailchimp_server_prefix: serverPrefix,
        })
        .eq('mailchimp_user_id', mailchimpUserId)
        .select()
        .single();
      
      if (updateError) {
        console.error('❌ Supabase update error:', updateError);
        throw updateError;
      }
      user = updatedUser;
    } else {
      console.log('🆕 Creating new user');
      // Brand new user - set onboarding_step to 'connected'
      const { data: newUser, error: insertError } = await supabase
        .from('users')
        .insert({
          mailchimp_user_id: mailchimpUserId,
          mailchimp_login: login.email || accountname,
          mailchimp_access_token: access_token,
          mailchimp_server_prefix: serverPrefix,
          onboarding_step: 'connected',
          plan: 'free',
          subscription_status: 'none',
        })
        .select()
        .single();
      
      if (insertError) {
        console.error('❌ Supabase insert error:', insertError);
        throw insertError;
      }
      user = newUser;
    }

    console.log('✅ User stored in Supabase:', user.id);

    // Determine where to send this user based on their workflow step
    const { redirect } = getWorkflowRedirect(user);
    console.log('🎯 Workflow redirect:', redirect);

    // Send them to the frontend with their user ID as the session token
    const redirectUrl = `${process.env.FRONTEND_URL}/auth/success?token=${user.id}&redirect=${redirect}`;
    console.log('🚀 Final redirect URL:', redirectUrl);
    res.redirect(redirectUrl);

  } catch (err) {
    console.error('❌ Callback error:', err.message);
    console.error('   Stack:', err.stack);
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
