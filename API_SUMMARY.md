# BillingSaver — Backend API Summary
# Give this to Google AI Studio to build the frontend

## Base URL
Development: http://localhost:3000
Production: https://your-render-app.onrender.com

## Authentication
Every protected route requires this header:
  Authorization: Bearer <user_id>

The user_id is returned after Mailchimp OAuth login and should be stored in localStorage.

---

## AUTH ROUTES

### 1. Start Mailchimp Login
GET /api/auth/mailchimp
- No auth required
- Redirects browser to Mailchimp OAuth consent screen
- Usage: window.location.href = `${BASE_URL}/api/auth/mailchimp`

### 2. OAuth Callback (handled by backend)
GET /api/auth/mailchimp/callback?code=...
- Mailchimp redirects here automatically
- Backend exchanges code for token, upserts user
- Redirects to: FRONTEND_URL/auth/success?token=USER_ID&redirect=/dashboard (or /pricing)
- Frontend must: grab token from URL, save to localStorage, then redirect to the `redirect` param

### 3. Get Current User
GET /api/auth/me
Headers: Authorization: Bearer <token>
Response:
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "plan": "basic" | "pro" | "free",
    "subscription_status": "active" | "inactive" | "canceled" | "past_due",
    "onboarding_step": "connected" | "plan_selected" | "active",
    "subscription_current_period_end": "2024-02-01T00:00:00Z"
  },
  "workflow": {
    "redirect": "/dashboard" | "/pricing",
    "reason": "complete" | "plan_not_selected" | "payment_incomplete" | ...
  }
}
- Call this on every app load. Use workflow.redirect to send user to the right page.

### 4. Logout
POST /api/auth/logout
- Just delete token from localStorage on frontend (stateless)

---

## BILLING ROUTES

### 5. Get Plans
GET /api/billing/plans
- No auth required
- Shows on pricing page
Response:
{
  "plans": [
    {
      "id": "basic",
      "name": "Basic",
      "price_cents": 1000,
      "price_display": "$10/month",
      "features": ["One-click archive cleanup", "Waste summary & savings estimate", "Health score", "Manual cleanup only"]
    },
    {
      "id": "pro",
      "name": "Pro",
      "price_cents": 2500,
      "price_display": "$25/month",
      "features": ["Everything in Basic", "Weekly automatic cleanup (set it & forget it)", "30-day undo / contact restore", "Cleanup history"]
    }
  ]
}

### 6. Create Checkout Session
POST /api/billing/checkout
Headers: Authorization: Bearer <token>
Body: { "plan": "basic" | "pro" }
Response: { "checkout_url": "https://checkout.stripe.com/...", "session_id": "cs_..." }
- Redirect user to checkout_url to complete payment
- On success, Stripe redirects to /dashboard?payment=success
- On cancel, Stripe redirects to /pricing?payment=canceled

### 7. Open Billing Portal (manage/cancel subscription)
POST /api/billing/portal
Headers: Authorization: Bearer <token>
Response: { "portal_url": "https://billing.stripe.com/..." }
- Redirect user to portal_url

### 8. Get Subscription Status
GET /api/billing/status
Headers: Authorization: Bearer <token>
Response:
{
  "plan": "pro",
  "subscription_status": "active",
  "subscription_current_period_end": "2024-02-01T00:00:00Z",
  "is_active": true
}

---

## DASHBOARD ROUTES
(All require active subscription)

### 9. Get Waste Summary
GET /api/dashboard/summary
Headers: Authorization: Bearer <token>
- Hits Mailchimp live — may take 3-10 seconds for large lists
- Show a loading spinner
Response:
{
  "summary": {
    "audience_id": "abc123",
    "audience_name": "My Newsletter",
    "total_contacts": 5000,
    "subscribed_count": 3200,
    "unsubscribed_count": 1200,
    "bounced_count": 400,
    "duplicate_count": 200,
    "billable_contact_count": 5000,
    "current_plan_price_cents": 4500,
    "estimated_savings_cents": 3000,
    "health_score": 64
  },
  "savings_note": "Archiving today will reduce your NEXT Mailchimp bill. Savings appear after your current billing cycle."
}

### 10. Run Cleanup (One-Click Archive)
POST /api/dashboard/cleanup
Headers: Authorization: Bearer <token>
- May take 10-60 seconds for large lists
- Show loading state, disable button while running
Response:
{
  "run_id": "uuid",
  "total_archived": 1800,
  "unsubscribed_archived": 1200,
  "bounced_archived": 400,
  "duplicates_archived": 200,
  "estimated_savings_cents": 3000,
  "message": "Archived 1800 contacts. Your next Mailchimp bill will be ~$30.00 lower.",
  "savings_note": "Archive this month → save next month. Estimated savings on your next bill: $30.00"
}

### 11. Get Cleanup History
GET /api/dashboard/history
Headers: Authorization: Bearer <token>
Response:
{
  "runs": [
    {
      "id": "uuid",
      "triggered_by": "manual" | "cron",
      "status": "completed" | "failed" | "running",
      "total_archived": 1800,
      "unsubscribed_archived": 1200,
      "bounced_archived": 400,
      "duplicates_archived": 200,
      "estimated_savings_cents": 3000,
      "started_at": "2024-01-15T10:30:00Z",
      "completed_at": "2024-01-15T10:30:45Z"
    }
  ]
}

### 12. Undo Cleanup Run (Pro only)
POST /api/dashboard/undo/:runId
Headers: Authorization: Bearer <token>
- Pro plan only
- Only works within 30 days of the run
Response:
{
  "restored": 1800,
  "message": "Restored 1800 contacts back to their original status."
}
Error if not Pro:
{
  "error": "Undo is a Pro feature. Upgrade to restore contacts.",
  "code": "PRO_REQUIRED"
}

### 13. Get Health Score
GET /api/dashboard/health
Headers: Authorization: Bearer <token>
Response:
{
  "health_score": 64,
  "health_label": "Good",  // "Poor" | "Fair" | "Good" | "Excellent"
  "breakdown": {
    "total_contacts": 5000,
    "subscribed": 3200,
    "unsubscribed": 1200,
    "bounced": 400,
    "duplicates": 200
  },
  "last_updated": "2024-01-15T10:30:00Z"
}

---

## ERROR RESPONSES
All errors follow this format:
{ "error": "Human readable message", "code": "OPTIONAL_ERROR_CODE" }

Common HTTP codes:
- 401 → Not logged in / bad token → redirect to /
- 403 + code SUBSCRIPTION_REQUIRED → redirect to /pricing
- 403 + code PRO_REQUIRED → show upgrade prompt
- 500 → Server error → show generic error message

---

## PAGES THE FRONTEND NEEDS

1. / (Landing Page)
   - CTA button: "Connect Mailchimp" → hits GET /api/auth/mailchimp

2. /auth/success
   - Grabs ?token and ?redirect from URL
   - Saves token to localStorage as 'bs_token'
   - Redirects to the redirect param

3. /auth/error
   - Shows error message based on ?reason param

4. /pricing
   - Calls GET /api/billing/plans
   - Shows plan cards
   - "Get Started" button → POST /api/billing/checkout → redirect to checkout_url

5. /dashboard
   - On load: check localStorage for token, then GET /api/auth/me to verify
   - If no token or 401 → redirect to /
   - If workflow.redirect !== '/dashboard' → redirect there
   - Calls GET /api/dashboard/summary (show loader)
   - Shows: waste breakdown, savings estimate, health score
   - "Clean Up Now" button → POST /api/dashboard/cleanup
   - Shows cleanup history → GET /api/dashboard/history
   - Undo button (Pro only) → POST /api/dashboard/undo/:runId

---

## IMPORTANT UX NOTES FOR FRONTEND

1. SAVINGS MESSAGING — always say "next bill" not "your bill":
   - "Estimated savings on your NEXT bill: $30.00"
   - "Archive this month → save next month"
   - Never imply instant savings

2. CLEANUP LOADING — cleanup can take 10-60 seconds:
   - Disable the button while running
   - Show progress text like "Archiving contacts... this may take a minute"

3. SUMMARY LOADING — summary also hits Mailchimp live:
   - Show skeleton loader while fetching

4. SESSION CHECK — on every page load:
   - Read localStorage('bs_token')
   - Call GET /api/auth/me
   - Follow workflow.redirect if it doesn't match current page
