import { db } from './index.js';
import { bus } from '../lib/bus.js';

export type EventKind =
  | 'payment'
  | 'refund'
  | 'payment_failed'
  | 'subscription_created'
  | 'subscription_updated'
  | 'subscription_canceled'
  | 'trial_started';

export interface EventRow {
  id: number;
  project_id: string;
  stripe_event_id: string | null;
  stripe_object_id: string;
  kind: EventKind;
  amount_cents: number;
  currency: string;
  amount_base_cents: number;
  mrr_delta_cents: number;
  customer_id: string | null;
  customer_email: string | null;
  customer_name: string | null;
  subscription_id: string | null;
  /** Shared between an invoice and its charge: the deduplication key. */
  payment_intent: string | null;
  /** Stripe reason: `subscription_create`, `subscription_cycle`, `manual`… */
  billing_reason: string | null;
  description: string | null;
  occurred_at: number;
  created_at: number;
  /** Joined from `projects`, so the app can show it without another request. */
  project_name: string;
  project_color: string;
}

export type NewEvent = Omit<EventRow, 'id' | 'created_at' | 'project_name' | 'project_color'>;

// `INSERT OR IGNORE` rather than a targeted `ON CONFLICT`: two unique
// constraints guard this table, the Stripe event id and the payment intent that
// deduplicates invoice against charge. A targeted clause would cover only one,
// and the other would raise.
const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO events (
    project_id, stripe_event_id, stripe_object_id, kind,
    amount_cents, currency, amount_base_cents, mrr_delta_cents,
    customer_id, customer_email, customer_name, subscription_id,
    payment_intent, billing_reason, description, occurred_at, created_at
  ) VALUES (
    @project_id, @stripe_event_id, @stripe_object_id, @kind,
    @amount_cents, @currency, @amount_base_cents, @mrr_delta_cents,
    @customer_id, @customer_email, @customer_name, @subscription_id,
    @payment_intent, @billing_reason, @description, @occurred_at, @created_at
  )
`);

const byRowId = db.prepare(`
  SELECT e.*, p.name AS project_name, p.color AS project_color
  FROM events e JOIN projects p ON p.id = e.project_id
  WHERE e.id = ?
`);

/**
 * Inserts an event idempotently.
 * Returns the created row, or `null` when the event was already known, which is
 * normal when Stripe redelivers a webhook or a backfill overlaps live traffic.
 */
export function insertEvent(event: NewEvent, opts: { publish?: boolean } = {}): EventRow | null {
  const created_at = Math.floor(Date.now() / 1000);
  const result = insertStmt.run({ ...event, created_at });
  if (result.changes === 0) return null;

  const row = byRowId.get(result.lastInsertRowid as number) as EventRow;

  db.prepare(
    `UPDATE sync_state SET last_event_at = MAX(COALESCE(last_event_at, 0), ?) WHERE project_id = ?`,
  ).run(event.occurred_at, event.project_id);

  if (opts.publish !== false) {
    bus.publishEvent(row);
    bus.publishMetricsDirty();
  }
  return row;
}

export interface SubscriptionRow {
  id: string;
  project_id: string;
  customer_id: string | null;
  customer_email: string | null;
  customer_name: string | null;
  status: string;
  currency: string;
  amount_cents: number;
  interval: string;
  interval_count: number;
  quantity: number;
  mrr_cents: number;
  mrr_base_cents: number;
  product_name: string | null;
  started_at: number | null;
  canceled_at: number | null;
  current_period_end: number | null;
  updated_at: number;
}

export type NewSubscription = Omit<SubscriptionRow, 'updated_at'>;

const upsertSubStmt = db.prepare(`
  INSERT INTO subscriptions (
    id, project_id, customer_id, customer_email, customer_name, status,
    currency, amount_cents, interval, interval_count, quantity,
    mrr_cents, mrr_base_cents, product_name,
    started_at, canceled_at, current_period_end, updated_at
  ) VALUES (
    @id, @project_id, @customer_id, @customer_email, @customer_name, @status,
    @currency, @amount_cents, @interval, @interval_count, @quantity,
    @mrr_cents, @mrr_base_cents, @product_name,
    @started_at, @canceled_at, @current_period_end, @updated_at
  )
  ON CONFLICT (project_id, id) DO UPDATE SET
    customer_id        = excluded.customer_id,
    customer_email     = excluded.customer_email,
    customer_name      = excluded.customer_name,
    status             = excluded.status,
    currency           = excluded.currency,
    amount_cents       = excluded.amount_cents,
    interval           = excluded.interval,
    interval_count     = excluded.interval_count,
    quantity           = excluded.quantity,
    mrr_cents          = excluded.mrr_cents,
    mrr_base_cents     = excluded.mrr_base_cents,
    product_name       = excluded.product_name,
    started_at         = excluded.started_at,
    canceled_at        = excluded.canceled_at,
    current_period_end = excluded.current_period_end,
    updated_at         = excluded.updated_at
`);

export function getSubscription(
  projectId: string,
  id: string,
): SubscriptionRow | undefined {
  return db
    .prepare('SELECT * FROM subscriptions WHERE project_id = ? AND id = ?')
    .get(projectId, id) as SubscriptionRow | undefined;
}

export function upsertSubscription(sub: NewSubscription): void {
  upsertSubStmt.run({ ...sub, updated_at: Math.floor(Date.now() / 1000) });
}

/** Stripe statuses considered to contribute to MRR. */
export const ACTIVE_STATUSES = ['active', 'trialing', 'past_due'] as const;
