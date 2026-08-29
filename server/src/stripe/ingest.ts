import type Stripe from 'stripe';
import type { ProjectConfig } from '../config.js';
import { stripeFor } from './client.js';
import { invoicePaymentIntents } from './compat.js';
import { insertEvent, getSubscription, upsertSubscription, type EventRow } from '../db/repo.js';
import {
  eventFromCharge,
  eventFromInvoice,
  eventFromRefund,
  eventFromSubscription,
  normalizeSubscription,
  MRR_STATUSES,
} from './normalize.js';
import { notifyEvent } from '../push/index.js';
import { db } from '../db/index.js';

/** Event types subscribed to on the Stripe side. */
export const SUBSCRIBED_EVENTS = [
  'invoice.paid',
  'invoice.payment_failed',
  'charge.succeeded',
  'charge.refunded',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
] as const;

/**
 * Handles a verified Stripe event.
 *
 * `notify` is disabled during a backfill: replaying two years of history must
 * not fire thousands of notifications.
 */
export async function ingestEvent(
  project: ProjectConfig,
  event: Stripe.Event,
  opts: { notify?: boolean } = {},
): Promise<EventRow | null> {
  const notify = opts.notify !== false;
  const row = await handle(project, event);
  if (!row) return null;

  if (notify) await notifyEvent(row, project.name);
  return row;
}

async function handle(project: ProjectConfig, event: Stripe.Event): Promise<EventRow | null> {
  const projectId = project.id;
  const object = event.data.object as unknown as Record<string, unknown>;

  switch (event.type) {
    case 'invoice.paid': {
      const invoice = object as unknown as Stripe.Invoice;
      // A zero-amount invoice (trial, full credit) is not a payment.
      if ((invoice.amount_paid ?? 0) <= 0) return null;

      // The webhook body carries no expanded payments, hence no payment intent,
      // which is precisely the key that keeps an invoice and its charge from
      // being counted twice. Re-reading the invoice costs one call per payment,
      // negligible against the risk of doubling reported revenue.
      let enriched = invoice;
      if (invoicePaymentIntents(invoice).length === 0 && invoice.id) {
        const stripe = stripeFor(project);
        if (stripe) {
          try {
            enriched = await stripe.invoices.retrieve(invoice.id, { expand: ['payments'] });
          } catch {
            // Re-read failed: insert without a deduplication key rather than
            // lose the payment. The hourly reconciliation will correct it.
          }
        }
      }

      return insertEvent(eventFromInvoice(projectId, enriched, 'payment', event.id));
    }

    case 'invoice.payment_failed': {
      const invoice = object as unknown as Stripe.Invoice;
      return insertEvent(eventFromInvoice(projectId, invoice, 'payment_failed', event.id));
    }

    case 'charge.succeeded': {
      const charge = object as unknown as Stripe.Charge;
      // No filtering: a charge backing an invoice shares its payment intent, and
      // the unique index discards whichever arrives second, regardless of the
      // order between `invoice.paid` and `charge.succeeded`.
      return insertEvent(eventFromCharge(projectId, charge, event.id));
    }

    case 'charge.refunded': {
      const charge = object as unknown as Stripe.Charge;
      return insertEvent(eventFromRefund(projectId, charge, event.id));
    }

    case 'customer.subscription.created': {
      const sub = object as unknown as Stripe.Subscription;
      const normalized = normalizeSubscription(projectId, sub);
      upsertSubscription(normalized);
      const kind = sub.status === 'trialing' ? 'trial_started' : 'subscription_created';
      return insertEvent(
        eventFromSubscription(projectId, sub, kind, normalized.mrr_base_cents, event.id),
      );
    }

    case 'customer.subscription.updated': {
      const sub = object as unknown as Stripe.Subscription;
      const previous = getSubscription(projectId, sub.id);
      const normalized = normalizeSubscription(projectId, sub);
      upsertSubscription(normalized);

      const before = previous?.mrr_base_cents ?? 0;
      const delta = normalized.mrr_base_cents - before;

      // Trial converting to paid is a conversion, not a plain update.
      const converted =
        previous && !MRR_STATUSES.includes(previous.status) && MRR_STATUSES.includes(sub.status);
      if (converted) {
        return insertEvent(
          eventFromSubscription(
            projectId,
            sub,
            'subscription_created',
            normalized.mrr_base_cents,
            event.id,
          ),
        );
      }

      if (delta === 0) return null;
      return insertEvent(
        eventFromSubscription(projectId, sub, 'subscription_updated', delta, event.id),
      );
    }

    case 'customer.subscription.deleted': {
      const sub = object as unknown as Stripe.Subscription;
      const previous = getSubscription(projectId, sub.id);
      const lost = previous?.mrr_base_cents ?? 0;

      const normalized = normalizeSubscription(projectId, sub);
      upsertSubscription({ ...normalized, status: 'canceled', mrr_cents: 0, mrr_base_cents: 0 });

      return insertEvent(
        eventFromSubscription(projectId, sub, 'subscription_canceled', -lost, event.id),
      );
    }

    default:
      return null;
  }
}

export function markSyncError(projectId: string, message: string | null): void {
  db.prepare('UPDATE sync_state SET last_error = ? WHERE project_id = ?').run(
    message,
    projectId,
  );
}
