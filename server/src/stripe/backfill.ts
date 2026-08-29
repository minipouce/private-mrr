import type Stripe from 'stripe';
import type { ProjectConfig } from '../config.js';
import { stripeFor } from './client.js';
import { db } from '../db/index.js';
import { insertEvent, upsertSubscription } from '../db/repo.js';
import {
  eventFromCharge,
  eventFromInvoice,
  eventFromSubscription,
  normalizeSubscription,
  subscriptionEconomics,
  MRR_STATUSES,
} from './normalize.js';
import { toBaseCents, toInternalCents } from '../lib/money.js';
import { markSyncError } from './ingest.js';
import { subscriptionProductName } from './products.js';
import { discountFactor } from './coupons.js';

/**
 * Applies resolved discounts to a normalised subscription's MRR.
 * Coupons are not readable from the subscription object alone: they need a
 * separate resolution, memoised by `coupons.ts`.
 */
async function applyDiscount(
  stripe: import('stripe').default,
  projectId: string,
  sub: import('stripe').default.Subscription,
  normalized: { mrr_cents: number; mrr_base_cents: number; amount_cents: number },
): Promise<void> {
  const factor = await discountFactor(stripe, projectId, sub, normalized.mrr_cents);
  if (factor === 1) return;

  normalized.mrr_cents = Math.round(normalized.mrr_cents * factor);
  normalized.mrr_base_cents = Math.round(normalized.mrr_base_cents * factor);
  normalized.amount_cents = Math.round(normalized.amount_cents * factor);
}

/**
 * Fills in an existing event with columns added after it was imported.
 *
 * Insertion is idempotent and ignores duplicates, which protects against Stripe
 * redeliveries but also leaves older rows without columns introduced since.
 * They are completed here, never overwriting an existing value and never
 * deleting anything.
 */
function repairEvent(projectId: string, row: { stripe_object_id: string; billing_reason: string | null; subscription_id: string | null; payment_intent: string | null }): number {
  if (!row.billing_reason && !row.subscription_id && !row.payment_intent) return 0;

  const result = db
    .prepare(
      `UPDATE events SET
         billing_reason  = COALESCE(billing_reason, @billing_reason),
         subscription_id = COALESCE(subscription_id, @subscription_id),
         payment_intent  = COALESCE(payment_intent, @payment_intent)
       WHERE project_id = @project_id
         AND stripe_object_id = @stripe_object_id
         AND (billing_reason IS NULL OR subscription_id IS NULL OR payment_intent IS NULL)`,
    )
    .run({
      project_id: projectId,
      stripe_object_id: row.stripe_object_id,
      billing_reason: row.billing_reason,
      subscription_id: row.subscription_id,
      payment_intent: row.payment_intent,
    });

  return result.changes;
}

/** History depth imported, in months. 24 allows year-over-year comparison. */
const BACKFILL_MONTHS = Number(process.env.BACKFILL_MONTHS ?? 24);

function since(): number {
  const d = new Date();
  d.setMonth(d.getMonth() - BACKFILL_MONTHS);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/**
 * Imports one Stripe account's history.
 *
 * Stripe's Events API only retains 30 days, so long history is rebuilt from the
 * objects themselves (invoices, charges, subscriptions) rather than from the
 * event stream.
 *
 * The operation is idempotent: synthetic ids are deterministic, so replaying a
 * backfill introduces no duplicates.
 */
export async function backfillProject(
  project: ProjectConfig,
  opts: { force?: boolean } = {},
): Promise<{ subscriptions: number; events: number }> {
  const stripe = stripeFor(project);
  if (!stripe) return { subscriptions: 0, events: 0 };

  const state = db
    .prepare('SELECT backfill_done FROM sync_state WHERE project_id = ?')
    .get(project.id) as { backfill_done: number } | undefined;

  if (state?.backfill_done === 1 && !opts.force) {
    return { subscriptions: 0, events: 0 };
  }

  const from = since();
  let subCount = 0;
  let eventCount = 0;
  let repaired = 0;

  console.log(`[backfill] ${project.id}: importing since ${new Date(from * 1000).toISOString().slice(0, 10)}`);

  try {
    // ---- Subscriptions: current state plus synthetic lifecycle events
    for await (const sub of stripe.subscriptions.list({
      status: 'all',
      limit: 100,
      expand: ['data.customer'],
    })) {
      const normalized = normalizeSubscription(project.id, sub);
      normalized.product_name =
        normalized.product_name ?? (await subscriptionProductName(stripe, project.id, sub));
      await applyDiscount(stripe, project.id, sub, normalized);
      upsertSubscription(normalized);
      subCount++;

      const econ = subscriptionEconomics(sub);
      const mrrBase = toBaseCents(econ.mrrCents, econ.currency);

      if ((sub.start_date ?? sub.created) >= from) {
        const created = eventFromSubscription(
          project.id,
          sub,
          'subscription_created',
          mrrBase,
          `backfill:sub_created:${sub.id}`,
        );
        if (insertEvent(created, { publish: false })) eventCount++;
      }

      if (sub.canceled_at && sub.canceled_at >= from) {
        const canceled = eventFromSubscription(
          project.id,
          sub,
          'subscription_canceled',
          -mrrBase,
          `backfill:sub_canceled:${sub.id}`,
        );
        if (insertEvent(canceled, { publish: false })) eventCount++;
      }
    }

    // ---- Paid invoices: the source of truth for recurring revenue
    // `data.payments` is essential: it is the only way to obtain an invoice's
    // payment intent, and therefore to deduplicate it against its charge.
    for await (const invoice of stripe.invoices.list({
      status: 'paid',
      created: { gte: from },
      limit: 100,
      expand: ['data.customer', 'data.payments'],
    })) {
      if ((invoice.amount_paid ?? 0) <= 0) continue;
      const row = eventFromInvoice(
        project.id,
        invoice,
        'payment',
        `backfill:invoice:${invoice.id}`,
      );
      if (insertEvent(row, { publish: false })) eventCount++;
      else repaired += repairEvent(project.id, row);
    }

    // ---- Charges outside invoices: one-off payments, and refunds
    for await (const charge of stripe.charges.list({
      created: { gte: from },
      limit: 100,
      expand: ['data.customer'],
    })) {
      if (!charge.paid || charge.status !== 'succeeded') continue;

      // Charges backing an invoice are discarded by the unique index on the
      // payment intent. Filtering here would be redundant, and impossible to do
      // reliably now that `Charge.invoice` no longer exists.
      const row = eventFromCharge(project.id, charge, `backfill:charge:${charge.id}`);
      if (insertEvent(row, { publish: false })) eventCount++;

      if ((charge.amount_refunded ?? 0) > 0) {
        const currency = charge.currency ?? 'eur';
        const cents = toInternalCents(charge.amount_refunded, currency);
        const refund = {
          project_id: project.id,
          stripe_event_id: `backfill:refund:${charge.id}`,
          stripe_object_id: charge.id,
          kind: 'refund' as const,
          amount_cents: -cents,
          currency,
          amount_base_cents: -toBaseCents(cents, currency),
          mrr_delta_cents: 0,
          customer_id: typeof charge.customer === 'string' ? charge.customer : (charge.customer?.id ?? null),
          customer_email: charge.billing_details?.email ?? null,
          customer_name: charge.billing_details?.name ?? null,
          subscription_id: null,
          payment_intent: null,
          billing_reason: null,
          description: charge.description ?? 'Remboursement',
          occurred_at: charge.created,
        };
        if (insertEvent(refund, { publish: false })) eventCount++;
      }
    }

    db.prepare(
      `UPDATE sync_state SET backfill_done = 1, last_backfill_at = ?, last_error = NULL WHERE project_id = ?`,
    ).run(Math.floor(Date.now() / 1000), project.id);

    console.log(
      `[backfill] ${project.id}: ${subCount} subscriptions, ${eventCount} events imported` +
        (repaired ? `, ${repaired} completed` : ''),
    );
  } catch (err) {
    const message = (err as Error).message;
    markSyncError(project.id, message);
    console.error(`[backfill] ${project.id}: failed, ${message}`);
  }

  return { subscriptions: subCount, events: eventCount };
}

/**
 * Reconciliation: resyncs the state of active subscriptions.
 * Catches up webhooks possibly lost during an outage or a deployment.
 */
export async function reconcileProject(project: ProjectConfig): Promise<number> {
  const stripe = stripeFor(project);
  if (!stripe) return 0;

  let count = 0;
  try {
    for (const status of MRR_STATUSES) {
      for await (const sub of stripe.subscriptions.list({
        status: status as Stripe.SubscriptionListParams.Status,
        limit: 100,
        expand: ['data.customer'],
      })) {
        const normalized = normalizeSubscription(project.id, sub);
        normalized.product_name =
          normalized.product_name ?? (await subscriptionProductName(stripe, project.id, sub));
        await applyDiscount(stripe, project.id, sub, normalized);
        upsertSubscription(normalized);
        count++;
      }
    }
    markSyncError(project.id, null);
  } catch (err) {
    markSyncError(project.id, (err as Error).message);
    console.error(`[reconcile] ${project.id}: ${(err as Error).message}`);
  }
  return count;
}
