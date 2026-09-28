import type { ProjectConfig } from '../config.js';
import { insertEvent, getSubscription, upsertSubscription, type EventRow } from '../db/repo.js';
import { MRR_STATUSES } from '../stripe/normalize.js';
import { notifyEvent } from '../push/index.js';
import {
  BILLING,
  moneyOf,
  movementFrom,
  paymentFrom,
  subscriptionFrom,
  subscriptionIdOf,
  type RevenueCatEvent,
} from './normalize.js';

/**
 * Handles one RevenueCat webhook.
 *
 * Deliberately shaped like the Stripe one, and writing to the same two tables,
 * so everything downstream — MRR, movements, forecast, notifications, the app —
 * treats a subscription bought on the App Store exactly like one bought by
 * card. Nothing past this module knows which is which.
 */
export async function ingestRevenueCat(
  project: ProjectConfig,
  event: RevenueCatEvent,
  opts: { notify?: boolean } = {},
): Promise<EventRow | null> {
  // A sandbox purchase is a developer testing a paywall. Booking it would put
  // imaginary revenue in the totals, and it is the kind of error that only
  // shows up once the figures are already being trusted.
  if (event.environment === 'SANDBOX') return null;

  const money = moneyOf(event, project);
  const subId = subscriptionIdOf(event);
  const previous = getSubscription(project.id, subId);

  // A refund is money going back, nothing more. It says nothing about whether
  // the subscription is still running — the store sends an EXPIRATION for that
  // — so it is booked in the ledger and the subscription is left alone.
  if (money && money.netBaseCents < 0) {
    const refunded = insertEvent(paymentFrom(project, event, money));
    if (refunded && opts.notify !== false) await notifyEvent(refunded, project.name);
    return refunded;
  }

  const next = subscriptionFrom(project, event, money, previous);
  const before = previous?.mrr_base_cents ?? 0;
  upsertSubscription(next);

  const wasBilling = previous ? MRR_STATUSES.includes(previous.status) : false;
  const isBilling = MRR_STATUSES.includes(next.status);

  let row: EventRow | null = null;

  // The cash ledger first: it is what "what did I earn today" reads from.
  if (BILLING.has(event.type ?? '') && money && money.netBaseCents !== 0) {
    row = insertEvent(paymentFrom(project, event, money));
    if (money.commissionAssumed) {
      console.warn(
        `[revenuecat] ${project.id}: no commission on event ${event.id ?? '?'}, ` +
          `assumed ${project.revenuecat?.commissionPct ?? 30}%`,
      );
    }
  }

  // Then the movement, so the MRR history reads like the Stripe one.
  const movement = !previous && next.status === 'trialing'
    ? movementFrom(project, event, 'trial_started', 0)
    : !wasBilling && isBilling
      ? movementFrom(project, event, 'subscription_created', next.mrr_base_cents)
      : wasBilling && !isBilling
        ? movementFrom(project, event, 'subscription_canceled', -before)
        : null;

  if (movement) {
    const inserted = insertEvent(movement);
    row = row ?? inserted;
  }

  if (row && opts.notify !== false) await notifyEvent(row, project.name);
  return row;
}
