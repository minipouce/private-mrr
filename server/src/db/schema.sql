-- Event ledger and subscription state.
-- Every amount is an integer in cents. `amount_cents` is expressed in the
-- original currency, `amount_base_cents` in the base currency.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#6366f1',
  -- Exclude a project from the consolidated total without ceasing to track it:
  -- useful for a test account, or a fully comped project that would skew it.
  include_in_totals INTEGER NOT NULL DEFAULT 1,
  -- Last time the brand logo was fetched from Stripe.
  logo_updated_at INTEGER,
  -- Revenue goal, in cents of the base currency.
  goal_cents      INTEGER,
  -- Goal kind: 'mrr' or 'arr'.
  goal_kind       TEXT NOT NULL DEFAULT 'mrr',
  created_at  INTEGER NOT NULL
);

-- Append-only ledger. `stripe_event_id` guarantees idempotence: Stripe may
-- redeliver a webhook several times, and only one row is inserted.
CREATE TABLE IF NOT EXISTS events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stripe_event_id    TEXT,
  stripe_object_id   TEXT NOT NULL,
  kind               TEXT NOT NULL,
  amount_cents       INTEGER NOT NULL DEFAULT 0,
  currency           TEXT NOT NULL,
  amount_base_cents  INTEGER NOT NULL DEFAULT 0,
  mrr_delta_cents    INTEGER NOT NULL DEFAULT 0,
  customer_id        TEXT,
  customer_email     TEXT,
  customer_name      TEXT,
  subscription_id    TEXT,
  payment_intent     TEXT,
  -- Stripe's billing reason: separates a first subscription from a renewal,
  -- which the collected amount alone cannot tell you.
  billing_reason     TEXT,
  description        TEXT,
  occurred_at        INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  UNIQUE (project_id, stripe_event_id)
);

CREATE INDEX IF NOT EXISTS idx_events_occurred     ON events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_project_time ON events (project_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind_time    ON events (kind, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_object       ON events (project_id, stripe_object_id);

-- A payment materialises as both an invoice and a charge. No field links them
-- on recent API versions: the payment intent is the only shared identifier.
-- This index guarantees one payment is counted once, whatever the arrival order.
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_payment_intent
  ON events (project_id, payment_intent)
  WHERE payment_intent IS NOT NULL AND kind = 'payment';

-- Current state of each subscription, rebuilt from Stripe then maintained by
-- webhooks. This is the source of truth for instantaneous MRR.
CREATE TABLE IF NOT EXISTS subscriptions (
  id                  TEXT NOT NULL,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  customer_id         TEXT,
  customer_email      TEXT,
  customer_name       TEXT,
  status              TEXT NOT NULL,
  currency            TEXT NOT NULL,
  amount_cents        INTEGER NOT NULL DEFAULT 0,
  interval            TEXT NOT NULL DEFAULT 'month',
  interval_count      INTEGER NOT NULL DEFAULT 1,
  quantity            INTEGER NOT NULL DEFAULT 1,
  mrr_cents           INTEGER NOT NULL DEFAULT 0,
  mrr_base_cents      INTEGER NOT NULL DEFAULT 0,
  product_name        TEXT,
  started_at          INTEGER,
  canceled_at         INTEGER,
  current_period_end  INTEGER,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_subs_status  ON subscriptions (status);
CREATE INDEX IF NOT EXISTS idx_subs_project ON subscriptions (project_id, status);

-- Device push tokens. One per device.
CREATE TABLE IF NOT EXISTS push_tokens (
  token        TEXT PRIMARY KEY,
  device_name  TEXT,
  -- Language the device asked for, so one server can notify a French phone and
  -- an English one differently. 'en' when the device never said.
  locale       TEXT NOT NULL DEFAULT 'en',
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

-- Per-project notification preferences. A missing row means everything is on.
CREATE TABLE IF NOT EXISTS notification_prefs (
  project_id         TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  notify_payments    INTEGER NOT NULL DEFAULT 1,
  notify_signups     INTEGER NOT NULL DEFAULT 1,
  notify_cancels     INTEGER NOT NULL DEFAULT 1,
  notify_failures    INTEGER NOT NULL DEFAULT 1,
  min_amount_cents   INTEGER NOT NULL DEFAULT 0
);

-- Backfill tracking, so history is replayed only once per project.
CREATE TABLE IF NOT EXISTS sync_state (
  project_id         TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  backfill_done      INTEGER NOT NULL DEFAULT 0,
  last_backfill_at   INTEGER,
  last_event_at      INTEGER,
  last_error         TEXT
);

-- Cached exchange rates, refreshed periodically.
CREATE TABLE IF NOT EXISTS fx_rates (
  currency    TEXT PRIMARY KEY,
  rate        REAL NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Global settings as key/value pairs: few and heterogeneous, a dedicated table
-- per setting would be disproportionate.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
