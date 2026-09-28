import { config, type ProjectConfig } from '../config.js';
import { hasRate, monthlyNormalized, toBaseCents, toInternalCents } from '../lib/money.js';
import type { NewEvent, NewSubscription, SubscriptionRow } from '../db/repo.js';

/**
 * Turning a RevenueCat webhook into ledger rows.
 *
 * The difference with Stripe is not the shape of the events, it is the money.
 * Stripe bills an amount and hands it over. A store bills an amount, keeps its
 * commission, remits the tax, and pays the rest much later. Counting the price
 * the customer saw would overstate this revenue by 15 to 30%, so everything
 * here is net: what actually reaches the bank.
 */

/** Events that open or extend access — the subscription is alive after them. */
export const GRANTING = new Set([
  'INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'PRODUCT_CHANGE',
  'NON_RENEWING_PURCHASE', 'SUBSCRIPTION_EXTENDED', 'TEMPORARY_ENTITLEMENT_GRANT',
  'REFUND_REVERSED', 'BILLING_ISSUE',
]);

/** Events that move money, and therefore belong in the cash ledger. */
export const BILLING = new Set([
  'INITIAL_PURCHASE', 'RENEWAL', 'NON_RENEWING_PURCHASE', 'PRODUCT_CHANGE', 'REFUND_REVERSED',
]);

/** Commission assumed when neither the event nor the project configuration says. */
const DEFAULT_COMMISSION_PCT = 30;

export interface RevenueCatEvent {
  id?: string;
  type?: string;
  environment?: string;
  app_user_id?: string;
  original_app_user_id?: string;
  aliases?: string[];
  product_id?: string;
  store?: string;
  period_type?: string;
  price?: number | null;
  price_in_purchased_currency?: number | null;
  currency?: string | null;
  country_code?: string;
  commission_percentage?: number | null;
  tax_percentage?: number | null;
  purchased_at_ms?: number | null;
  expiration_at_ms?: number | null;
  event_timestamp_ms?: number | null;
  cancel_reason?: string | null;
  is_trial_conversion?: boolean;
  transaction_id?: string;
  original_transaction_id?: string;
}

export interface Money {
  /** What the customer paid, in the base currency. */
  grossBaseCents: number;
  /** What is left once the store has taken its share. */
  netBaseCents: number;
  /** Currency the purchase was actually made in. */
  currency: string;
  /** True when the commission had to be assumed rather than read. */
  commissionAssumed: boolean;
}

/**
 * What a transaction is worth, net of the store's cut.
 *
 * The amount in the purchase currency is preferred over RevenueCat's
 * USD-normalised `price`: it is the figure the customer was actually charged,
 * and converting it ourselves keeps one exchange-rate convention across both
 * sources. When the currency is one we hold no rate for, the USD figure is the
 * safer of the two — converting the other at a rate of 1 would be a silent
 * error of a factor of a hundred on a yen.
 */
export function moneyOf(event: RevenueCatEvent, project: ProjectConfig): Money | null {
  const local = event.price_in_purchased_currency;
  const currency = (event.currency ?? 'usd').toLowerCase();

  let grossCents: number;
  let sourceCurrency: string;

  if (typeof local === 'number' && hasRate(currency)) {
    grossCents = toInternalCents(Math.round(local * 100), currency);
    sourceCurrency = currency;
  } else if (typeof event.price === 'number') {
    grossCents = toInternalCents(Math.round(event.price * 100), 'usd');
    sourceCurrency = 'usd';
  } else {
    // Price unknown: RevenueCat leaves it null on some historical transactions.
    return null;
  }

  const fromEvent =
    typeof event.commission_percentage === 'number' ? event.commission_percentage : null;
  const commissionPct = fromEvent ?? project.revenuecat?.commissionPct ?? DEFAULT_COMMISSION_PCT;
  const taxPct = typeof event.tax_percentage === 'number' ? event.tax_percentage : 0;

  // Both percentages apply to the price, not to one another: the store's own
  // formula is price − price×commission − price×tax.
  const kept = Math.max(0, 1 - commissionPct / 100 - taxPct / 100);

  return {
    grossBaseCents: toBaseCents(grossCents, sourceCurrency),
    netBaseCents: toBaseCents(Math.round(grossCents * kept), sourceCurrency),
    currency: sourceCurrency,
    commissionAssumed: fromEvent === null,
  };
}

/**
 * Billing period of a subscription, read from the period it just bought.
 *
 * A webhook says when the period started and when it ends, never "monthly" or
 * "yearly". The gap between the two is the only thing there is to go on, so the
 * boundaries are drawn wide enough that a few days of grace, a leap year or a
 * store's rounding do not change the answer.
 */
export function cadenceOf(event: RevenueCatEvent): { interval: string; count: number } {
  const from = event.purchased_at_ms ?? null;
  const to = event.expiration_at_ms ?? null;
  if (!from || !to || to <= from) return { interval: 'month', count: 1 };

  const days = (to - from) / 86_400_000;
  if (days <= 10) return { interval: 'week', count: 1 };
  if (days <= 45) return { interval: 'month', count: 1 };
  if (days <= 115) return { interval: 'month', count: 3 };
  if (days <= 220) return { interval: 'month', count: 6 };
  return { interval: 'year', count: 1 };
}

const seconds = (ms: number | null | undefined) =>
  ms ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000);

/**
 * Stable subscription id.
 *
 * The store's original transaction id is the one thing that survives every
 * renewal of the same subscription; without it, each renewal would look like a
 * new subscriber. The pair customer + product is the fallback, which holds as
 * long as nobody buys the same product twice.
 */
export function subscriptionIdOf(event: RevenueCatEvent): string {
  if (event.original_transaction_id) return event.original_transaction_id;
  if (event.app_user_id && event.product_id) return `${event.app_user_id}:${event.product_id}`;
  return event.app_user_id ?? event.transaction_id ?? 'inconnu';
}

function baseEvent(
  project: ProjectConfig,
  event: RevenueCatEvent,
  kind: NewEvent['kind'],
): NewEvent {
  const object = event.transaction_id ?? subscriptionIdOf(event);
  return {
    project_id: project.id,
    source: 'revenuecat',
    stripe_event_id: event.id ?? `rc:${kind}:${object}`,
    stripe_object_id: object,
    kind,
    amount_cents: 0,
    currency: config.baseCurrency,
    amount_base_cents: 0,
    gross_base_cents: null,
    mrr_delta_cents: 0,
    customer_id: event.app_user_id ?? null,
    customer_email: null,
    customer_name: null,
    subscription_id: subscriptionIdOf(event),
    payment_intent: null,
    billing_reason: event.type ?? null,
    description: event.product_id ?? null,
    occurred_at: seconds(event.event_timestamp_ms ?? event.purchased_at_ms),
  };
}

/** A purchase or a renewal, booked net of the store's commission. */
export function paymentFrom(
  project: ProjectConfig,
  event: RevenueCatEvent,
  money: Money,
): NewEvent {
  const refund = money.netBaseCents < 0;
  return {
    ...baseEvent(project, event, refund ? 'refund' : 'payment'),
    amount_cents: money.netBaseCents,
    currency: money.currency,
    amount_base_cents: money.netBaseCents,
    gross_base_cents: money.grossBaseCents,
  };
}

/** A lifecycle movement, carrying the MRR it adds or removes. */
export function movementFrom(
  project: ProjectConfig,
  event: RevenueCatEvent,
  kind: 'subscription_created' | 'subscription_canceled' | 'trial_started',
  mrrDeltaCents: number,
): NewEvent {
  return {
    ...baseEvent(project, event, kind),
    stripe_event_id: `${event.id ?? subscriptionIdOf(event)}:${kind}`,
    mrr_delta_cents: mrrDeltaCents,
  };
}

/**
 * State of the subscription after this event.
 *
 * A trial weighs nothing: it is tracked, like a Stripe trial, but it is not
 * revenue until it converts. A billing issue keeps the subscription in MRR and
 * marks it at risk, which is what `past_due` already means on the Stripe side —
 * the store is retrying, and most of them come back.
 */
export function subscriptionFrom(
  project: ProjectConfig,
  event: RevenueCatEvent,
  money: Money | null,
  previous: SubscriptionRow | undefined,
): NewSubscription {
  const trial = event.period_type === 'TRIAL';
  const ended = event.type === 'EXPIRATION';
  const status = ended
    ? 'canceled'
    : trial
      ? 'trialing'
      : event.type === 'BILLING_ISSUE'
        ? 'past_due'
        : 'active';

  // Only an event that actually charged something may re-price the
  // subscription. A billing issue, a cancellation or an expiry carries no
  // price, and taking their silence for zero would wipe the MRR of a
  // subscription that is merely having trouble collecting.
  const priced = money !== null && money.netBaseCents > 0 && BILLING.has(event.type ?? '');
  const amount = priced ? money.netBaseCents : (previous?.amount_cents ?? 0);
  const { interval, count } = priced
    ? cadenceOf(event)
    : { interval: previous?.interval ?? 'month', count: previous?.interval_count ?? 1 };

  const billing = status === 'active' || status === 'past_due';
  // Never below zero: a refund is a ledger entry, not a negative subscription.
  const monthly = billing ? Math.max(0, monthlyNormalized(amount, interval, count, 1)) : 0;

  return {
    id: subscriptionIdOf(event),
    project_id: project.id,
    source: 'revenuecat',
    customer_id: event.app_user_id ?? null,
    customer_email: null,
    customer_name: null,
    status,
    currency: config.baseCurrency,
    amount_cents: billing ? amount : 0,
    interval,
    interval_count: count,
    quantity: 1,
    mrr_cents: monthly,
    mrr_base_cents: monthly,
    // A store intro or promotional price is a temporary rate, but the webhook
    // never carries the standard one to compare it with. The two are reported
    // equal rather than inventing a discount that cannot be measured.
    mrr_current_base_cents: monthly,
    product_name: event.product_id ?? null,
    started_at: seconds(event.purchased_at_ms),
    canceled_at: event.type === 'CANCELLATION' ? seconds(event.event_timestamp_ms) : null,
    current_period_end: event.expiration_at_ms ? Math.floor(event.expiration_at_ms / 1000) : null,
  };
}
