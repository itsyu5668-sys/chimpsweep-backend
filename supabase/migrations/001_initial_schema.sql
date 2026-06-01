-- =============================================
-- BillingSaver Database Schema
-- Run this in Supabase SQL Editor
-- =============================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────────
-- USERS TABLE
-- Stores every user who has connected via Mailchimp OAuth
-- ─────────────────────────────────────────────
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  mailchimp_user_id TEXT UNIQUE NOT NULL,      -- Mailchimp's user ID
  mailchimp_login TEXT,                         -- Mailchimp username/email
  mailchimp_access_token TEXT NOT NULL,         -- OAuth access token
  mailchimp_server_prefix TEXT NOT NULL,        -- e.g. "us1", "us6" (for API base URL)
  
  -- Workflow step tracking (the most important part)
  -- Possible values: 'connected' | 'plan_selected' | 'active'
  onboarding_step TEXT NOT NULL DEFAULT 'connected',
  
  -- Plan info
  plan TEXT DEFAULT 'free',                     -- 'free' | 'basic' | 'pro'
  
  -- Stripe
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  subscription_status TEXT DEFAULT 'inactive',  -- 'active' | 'inactive' | 'canceled' | 'past_due'
  subscription_current_period_end TIMESTAMPTZ,
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- CLEANUP_RUNS TABLE
-- Every time a cleanup is performed (manual or auto)
-- ─────────────────────────────────────────────
CREATE TABLE cleanup_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  triggered_by TEXT NOT NULL,                   -- 'manual' | 'cron'
  status TEXT NOT NULL DEFAULT 'pending',       -- 'pending' | 'running' | 'completed' | 'failed'
  
  -- Results
  unsubscribed_archived INT DEFAULT 0,
  bounced_archived INT DEFAULT 0,
  duplicates_archived INT DEFAULT 0,
  total_archived INT DEFAULT 0,
  estimated_savings_cents INT DEFAULT 0,        -- savings in cents (e.g. 4700 = $47.00)
  
  error_message TEXT,
  
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- ─────────────────────────────────────────────
-- ARCHIVED_CONTACTS TABLE
-- Backup of every contact we archived so we can undo
-- Kept for 30 days then safe to delete
-- ─────────────────────────────────────────────
CREATE TABLE archived_contacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cleanup_run_id UUID NOT NULL REFERENCES cleanup_runs(id) ON DELETE CASCADE,
  
  mailchimp_contact_id TEXT NOT NULL,           -- Mailchimp's subscriber hash / contact ID
  email_address TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  original_status TEXT NOT NULL,               -- The status BEFORE we archived ('unsubscribed' | 'cleaned' etc)
  reason_archived TEXT NOT NULL,               -- 'unsubscribed' | 'bounced' | 'duplicate'
  
  -- For undo - has this been restored?
  restored_at TIMESTAMPTZ,
  
  archived_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days'
);

-- ─────────────────────────────────────────────
-- AUDIENCE_SNAPSHOTS TABLE
-- Stores the waste summary shown on the dashboard
-- Refreshed every time user loads dashboard or after a cleanup
-- ─────────────────────────────────────────────
CREATE TABLE audience_snapshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- Audience info
  audience_id TEXT NOT NULL,                   -- Mailchimp list/audience ID
  audience_name TEXT NOT NULL,
  
  -- Contact counts
  total_contacts INT DEFAULT 0,
  subscribed_count INT DEFAULT 0,
  unsubscribed_count INT DEFAULT 0,
  bounced_count INT DEFAULT 0,
  duplicate_count INT DEFAULT 0,
  
  -- Billing info
  billable_contact_count INT DEFAULT 0,        -- What Mailchimp is actually charging for
  current_plan_price_cents INT DEFAULT 0,       -- Current monthly cost in cents
  estimated_savings_cents INT DEFAULT 0,        -- How much they could save
  
  -- Health score (0-100)
  health_score INT DEFAULT 0,
  
  snapshot_taken_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────
CREATE INDEX idx_users_mailchimp_id ON users(mailchimp_user_id);
CREATE INDEX idx_users_stripe_customer ON users(stripe_customer_id);
CREATE INDEX idx_cleanup_runs_user_id ON cleanup_runs(user_id);
CREATE INDEX idx_archived_contacts_user_id ON archived_contacts(user_id);
CREATE INDEX idx_archived_contacts_cleanup_run ON archived_contacts(cleanup_run_id);
CREATE INDEX idx_archived_contacts_expires ON archived_contacts(expires_at);
CREATE INDEX idx_audience_snapshots_user_id ON audience_snapshots(user_id);

-- ─────────────────────────────────────────────
-- AUTO-UPDATE updated_at ON users
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ─────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- Service role key bypasses all RLS (backend uses this)
-- ─────────────────────────────────────────────
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE cleanup_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE archived_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE audience_snapshots ENABLE ROW LEVEL SECURITY;

-- Service role has full access (your backend)
-- No public access — all requests go through your API
