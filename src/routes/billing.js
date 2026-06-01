const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const supabase = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');

const PLANS = {
  basic: {
    price_id: process.env.STRIPE_BASIC_PRICE_ID,
    name: 'Basic',
    amount_cents: 1000, // $10/month
  },
  pro: {
    price_id: process.env.STRIPE_PRO_PRICE_ID,
    name: 'Pro',
    amount_cents: 2500, // $25/month
  },
};

// ─────────────────────────────────────────────
// GET /api/billing/plans
// Returns available plans (used on pricing page)
// ─────────────────────────────────────────────
router.get('/plans', (req, res) => {
  res.json({
    plans: [
      {
        id: 'basic',
        name: 'Basic',
        price_cents: 1000,
        price_display: '$10/month',
        features: [
          'One-click archive cleanup',
          'Waste summary & savings estimate',
          'Health score',
          'Manual cleanup only',
        ],
      },
      {
        id: 'pro',
        name: 'Pro',
        price_cents: 2500,
        price_display: '$25/month',
        features: [
          'Everything in Basic',
          'Weekly automatic cleanup (set it & forget it)',
          '30-day undo / contact restore',
          'Cleanup history',
        ],
      },
    ],
  });
});

// ─────────────────────────────────────────────
// POST /api/billing/checkout
// Creates a Stripe Checkout session
// Body: { plan: 'basic' | 'pro' }
// ─────────────────────────────────────────────
router.post('/checkout', requireAuth, async (req, res) => {
  const { plan } = req.body;
  const user = req.user;

  if (!PLANS[plan]) {
    return res.status(400).json({ error: 'Invalid plan. Must be basic or pro.' });
  }

  try {
    // Create or retrieve Stripe customer
    let customerId = user.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.mailchimp_login,
        metadata: { user_id: user.id },
      });
      customerId = customer.id;

      await supabase
        .from('users')
        .update({ stripe_customer_id: customerId })
        .eq('id', user.id);
    }

    // Mark that user has selected a plan (workflow step)
    await supabase
      .from('users')
      .update({ onboarding_step: 'plan_selected', plan })
      .eq('id', user.id);

    // Create Stripe Checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [
        {
          price: PLANS[plan].price_id,
          quantity: 1,
        },
      ],
      success_url: `${process.env.FRONTEND_URL}/dashboard?payment=success`,
      cancel_url: `${process.env.FRONTEND_URL}/pricing?payment=canceled`,
      metadata: {
        user_id: user.id,
        plan,
      },
      subscription_data: {
        metadata: {
          user_id: user.id,
          plan,
        },
      },
    });

    res.json({ checkout_url: session.url, session_id: session.id });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// ─────────────────────────────────────────────
// POST /api/billing/portal
// Creates a Stripe Customer Portal session (to manage/cancel subscription)
// ─────────────────────────────────────────────
router.post('/portal', requireAuth, async (req, res) => {
  const user = req.user;

  if (!user.stripe_customer_id) {
    return res.status(400).json({ error: 'No billing account found' });
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}/dashboard`,
    });

    res.json({ portal_url: session.url });
  } catch (err) {
    console.error('Stripe portal error:', err.message);
    res.status(500).json({ error: 'Failed to open billing portal' });
  }
});

// ─────────────────────────────────────────────
// GET /api/billing/status
// Returns the user's current subscription status
// ─────────────────────────────────────────────
router.get('/status', requireAuth, async (req, res) => {
  const user = req.user;
  res.json({
    plan: user.plan,
    subscription_status: user.subscription_status,
    subscription_current_period_end: user.subscription_current_period_end,
    is_active: user.subscription_status === 'active',
  });
});

// ─────────────────────────────────────────────
// POST /api/billing/webhook
// Stripe sends events here (payment success, cancellation, etc.)
// IMPORTANT: This route must use raw body (not JSON parsed)
// ─────────────────────────────────────────────
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).json({ error: 'Webhook signature verification failed' });
  }

  try {
    switch (event.type) {

      // ── Payment succeeded / subscription activated ──
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.user_id;
        const plan = session.metadata?.plan;

        if (userId) {
          // Get subscription details from Stripe
          const subscription = await stripe.subscriptions.retrieve(session.subscription);

          await supabase
            .from('users')
            .update({
              onboarding_step: 'active',
              plan: plan || 'basic',
              subscription_status: 'active',
              stripe_subscription_id: subscription.id,
              subscription_current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
            })
            .eq('id', userId);
        }
        break;
      }

      // ── Subscription renewed ──
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
          const userId = subscription.metadata?.user_id;

          if (userId) {
            await supabase
              .from('users')
              .update({
                subscription_status: 'active',
                subscription_current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
              })
              .eq('id', userId);
          }
        }
        break;
      }

      // ── Payment failed ──
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
          const userId = subscription.metadata?.user_id;

          if (userId) {
            await supabase
              .from('users')
              .update({ subscription_status: 'past_due' })
              .eq('id', userId);
          }
        }
        break;
      }

      // ── Subscription canceled ──
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const userId = subscription.metadata?.user_id;

        if (userId) {
          await supabase
            .from('users')
            .update({
              subscription_status: 'canceled',
              plan: 'free',
              onboarding_step: 'connected', // Send them back to pricing if they log in again
            })
            .eq('id', userId);
        }
        break;
      }

      // ── Subscription updated (plan change) ──
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const userId = subscription.metadata?.user_id;

        if (userId) {
          await supabase
            .from('users')
            .update({
              subscription_status: subscription.status,
              subscription_current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
            })
            .eq('id', userId);
        }
        break;
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook processing error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
