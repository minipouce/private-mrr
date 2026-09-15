import type Stripe from 'stripe';
import type { ProjectConfig } from '../config.js';
import { stripeFor } from './client.js';
import { db } from '../db/index.js';
import { insertEvent, upsertSubscription, refundedSoFar } from '../db/repo.js';
import {
  eventFromCharge,
  eventFromInvoice,
  eventFromRefund,
  eventFromSubscription,
  normalizeSubscription,
  MRR_STATUSES,
} from './normalize.js';
import { markSyncError } from './ingest.js';
import { subscriptionProductName } from './products.js';
import { movementMrrBaseCents } from './coupons.js';
import { applyRealEconomics } from './pricing.js';

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
      // Unexpanded, a discount comes back as a bare id and the coupon behind it
      // is invisible: a comped subscription would weigh its list price.
      expand: ['data.customer', 'data.discounts'],
    })) {
      const normalized = normalizeSubscription(project.id, sub);
      normalized.product_name =
        normalized.product_name ?? (await subscriptionProductName(stripe, project.id, sub));
      await applyRealEconomics(stripe, project.id, sub, normalized);
      upsertSubscription(normalized);
      subCount++;

      // Discounts resolved, and zero while the subscription has never billed:
      // the list price would otherwise be booked as new business for a comped
      // account or an abandoned checkout.
      const mrrBase = await movementMrrBaseCents(stripe, project.id, sub);

      if ((sub.start_date ?? sub.created) >= from) {
        const created = eventFromSubscription(
          project.id,
          sub,
          // Same distinction as the live path: a trial is not a signup.
          sub.status === 'trialing' ? 'trial_started' : 'subscription_created',
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
        // Same builder as the webhook, and the same guard: what a live
        // `charge.refunded` already booked must not be deducted a second time.
        const refund = eventFromRefund(project.id, charge, {
          alreadyRefundedCents: refundedSoFar(project.id, charge.id),
          occurredAt: charge.created,
        });
        if (refund && insertEvent(refund, { publish: false })) eventCount++;
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
        expand: ['data.customer', 'data.discounts'],
      })) {
        const normalized = normalizeSubscription(project.id, sub);
        normalized.product_name =
          normalized.product_name ?? (await subscriptionProductName(stripe, project.id, sub));
        await applyRealEconomics(stripe, project.id, sub, normalized);
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
