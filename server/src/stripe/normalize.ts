import type Stripe from 'stripe';
import { monthlyNormalized, toBaseCents, toInternalCents } from '../lib/money.js';
import { invoiceSubscriptionId, invoicePaymentIntents, chargePaymentIntent } from './compat.js';
import type { NewEvent, NewSubscription, EventKind } from '../db/repo.js';

/** Statuts qui contribuent au MRR facturé. */
export const MRR_STATUSES = ['active', 'past_due'];
/** Statuts en essai : suivis à part, ils ne génèrent pas encore de revenu. */
export const TRIAL_STATUSES = ['trialing'];

type MaybeExpanded<T> = string | T | null | undefined;

/**
 * Forme minimale d'une remise. Le SDK a fait évoluer `Stripe.Discount` entre
 * versions d'API ; on ne dépend que des champs réellement utilisés.
 */
interface DiscountLike {
  coupon?: {
    percent_off?: number | null;
    amount_off?: number | null;
    currency?: string | null;
  } | null;
}

function idOf<T extends { id: string }>(ref: MaybeExpanded<T>): string | null {
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.id;
}

function customerFields(ref: MaybeExpanded<Stripe.Customer | Stripe.DeletedCustomer>) {
  const id = idOf(ref);
  if (!ref || typeof ref === 'string' || ref.deleted) {
    return { customer_id: id, customer_email: null, customer_name: null };
  }
  const customer = ref as Stripe.Customer;
  return {
    customer_id: id,
    customer_email: customer.email ?? null,
    customer_name: customer.name ?? null,
  };
}

/** Extrait les remises exploitables d'un porteur (abonnement ou client). */
function collectDiscounts(holder: unknown): DiscountLike[] {
  const raw = holder as {
    discount?: DiscountLike | null;
    discounts?: Array<DiscountLike | string> | null;
  } | null | undefined;
  if (!raw) return [];

  const out: DiscountLike[] = [];
  if (raw.discount) out.push(raw.discount);
  for (const d of raw.discounts ?? []) {
    // Une remise non étendue n'est qu'un identifiant : inexploitable ici.
    if (typeof d !== 'string' && d) out.push(d);
  }
  return out;
}

/**
 * Applique les remises à un montant brut.
 *
 * Deux niveaux cumulables : la remise portée par l'abonnement, et celle portée
 * par le client — cette dernière s'applique à toutes ses factures sans figurer
 * sur l'abonnement. L'ignorer fait compter en MRR des comptes offerts dont
 * Stripe ne facturera jamais rien.
 *
 * La remise client n'est lisible que si le client a été étendu à la lecture.
 */
function applyDiscounts(sub: Stripe.Subscription, amountCents: number): number {
  const discounts = [
    ...collectDiscounts(sub),
    ...(typeof sub.customer === 'object' ? collectDiscounts(sub.customer) : []),
  ];

  let result = amountCents;
  for (const discount of discounts) {
    const coupon = discount.coupon;
    if (!coupon) continue;
    if (coupon.percent_off) {
      result = Math.round(result * (1 - coupon.percent_off / 100));
    } else if (coupon.amount_off) {
      result = Math.max(0, result - toInternalCents(coupon.amount_off, coupon.currency ?? 'eur'));
    }
  }
  return result;
}

export interface SubscriptionEconomics {
  currency: string;
  amountCents: number;
  interval: string;
  intervalCount: number;
  quantity: number;
  mrrCents: number;
  mrrBaseCents: number;
  productName: string | null;
}

/**
 * Calcule le MRR d'un abonnement en sommant ses lignes, chacune ramenée au mois.
 * Un abonnement peut mêler des périodicités différentes (mensuel + annuel).
 */
export function subscriptionEconomics(sub: Stripe.Subscription): SubscriptionEconomics {
  const items = sub.items?.data ?? [];
  let currency = sub.currency ?? 'eur';
  let grossCents = 0;
  let monthlyCents = 0;
  let interval = 'month';
  let intervalCount = 1;
  let quantity = 1;
  let productName: string | null = null;

  for (const item of items) {
    const price = item.price;
    if (!price) continue;

    currency = price.currency ?? currency;
    const qty = item.quantity ?? 1;
    const unit = toInternalCents(price.unit_amount ?? 0, currency);
    const recurring = price.recurring;

    grossCents += unit * qty;

    if (recurring) {
      interval = recurring.interval;
      intervalCount = recurring.interval_count ?? 1;
      quantity = qty;
      monthlyCents += monthlyNormalized(unit, recurring.interval, intervalCount, qty);
    }

    if (!productName) {
      const product = price.product;
      productName =
        typeof product === 'object' && product && !('deleted' in product && product.deleted)
          ? ((product as Stripe.Product).name ?? null)
          : (price.nickname ?? null);
    }
  }

  const mrrCents = applyDiscounts(sub, monthlyCents);
  return {
    currency,
    amountCents: applyDiscounts(sub, grossCents),
    interval,
    intervalCount,
    quantity,
    mrrCents,
    mrrBaseCents: toBaseCents(mrrCents, currency),
    productName,
  };
}

/** `current_period_end` a migré au niveau des items sur les API récentes. */
function periodEnd(sub: Stripe.Subscription): number | null {
  const raw = sub as unknown as { current_period_end?: number };
  if (typeof raw.current_period_end === 'number') return raw.current_period_end;
  const item = sub.items?.data?.[0] as unknown as { current_period_end?: number } | undefined;
  return typeof item?.current_period_end === 'number' ? item.current_period_end : null;
}

export function normalizeSubscription(
  projectId: string,
  sub: Stripe.Subscription,
): NewSubscription {
  const econ = subscriptionEconomics(sub);
  const isBilling = MRR_STATUSES.includes(sub.status);

  return {
    id: sub.id,
    project_id: projectId,
    ...customerFields(sub.customer),
    status: sub.status,
    currency: econ.currency,
    amount_cents: econ.amountCents,
    interval: econ.interval,
    interval_count: econ.intervalCount,
    quantity: econ.quantity,
    // Un abonnement annulé ou en essai est conservé en base mais pèse 0 dans le MRR.
    mrr_cents: isBilling ? econ.mrrCents : 0,
    mrr_base_cents: isBilling ? econ.mrrBaseCents : 0,
    product_name: econ.productName,
    started_at: sub.start_date ?? sub.created ?? null,
    canceled_at: sub.canceled_at ?? null,
    current_period_end: periodEnd(sub),
  };
}

function baseEvent(
  projectId: string,
  kind: EventKind,
  objectId: string,
  occurredAt: number,
  stripeEventId: string | null,
): NewEvent {
  return {
    project_id: projectId,
    stripe_event_id: stripeEventId ?? `${kind}:${objectId}`,
    stripe_object_id: objectId,
    kind,
    amount_cents: 0,
    currency: 'eur',
    amount_base_cents: 0,
    mrr_delta_cents: 0,
    customer_id: null,
    customer_email: null,
    customer_name: null,
    subscription_id: null,
    payment_intent: null,
    description: null,
    occurred_at: occurredAt,
  };
}

export function eventFromInvoice(
  projectId: string,
  invoice: Stripe.Invoice,
  kind: 'payment' | 'payment_failed',
  stripeEventId: string | null,
): NewEvent {
  const currency = invoice.currency ?? 'eur';
  // `amount_paid` reflète l'encaissement réel ; on retombe sur `amount_due`
  // pour les échecs de paiement, où rien n'a été encaissé.
  const gross = kind === 'payment' ? (invoice.amount_paid ?? 0) : (invoice.amount_due ?? 0);
  const cents = toInternalCents(gross, currency);

  return {
    ...baseEvent(projectId, kind, invoice.id ?? 'invoice', invoice.created, stripeEventId),
    amount_cents: cents,
    currency,
    amount_base_cents: toBaseCents(cents, currency),
    ...customerFields(invoice.customer),
    customer_email: invoice.customer_email ?? customerFields(invoice.customer).customer_email,
    subscription_id: invoiceSubscriptionId(invoice),
    // Renseigné uniquement si la facture a été lue avec `expand: ['data.payments']`.
    payment_intent: invoicePaymentIntents(invoice)[0] ?? null,
    description: invoice.lines?.data?.[0]?.description ?? invoice.number ?? null,
    occurred_at: invoice.status_transitions?.paid_at ?? invoice.created,
  };
}

export function eventFromCharge(
  projectId: string,
  charge: Stripe.Charge,
  stripeEventId: string | null,
): NewEvent {
  const currency = charge.currency ?? 'eur';
  const cents = toInternalCents(charge.amount, currency);
  return {
    ...baseEvent(projectId, 'payment', charge.id, charge.created, stripeEventId),
    amount_cents: cents,
    currency,
    amount_base_cents: toBaseCents(cents, currency),
    ...customerFields(charge.customer),
    customer_email: charge.billing_details?.email ?? null,
    customer_name: charge.billing_details?.name ?? null,
    payment_intent: chargePaymentIntent(charge),
    description: charge.description ?? null,
  };
}

export function eventFromRefund(
  projectId: string,
  charge: Stripe.Charge,
  stripeEventId: string | null,
): NewEvent {
  const currency = charge.currency ?? 'eur';
  const cents = toInternalCents(charge.amount_refunded ?? 0, currency);
  return {
    ...baseEvent(projectId, 'refund', charge.id, charge.created, stripeEventId),
    // Montant négatif : le ledger reste sommable sans traitement particulier.
    amount_cents: -cents,
    currency,
    amount_base_cents: -toBaseCents(cents, currency),
    ...customerFields(charge.customer),
    customer_email: charge.billing_details?.email ?? null,
    payment_intent: chargePaymentIntent(charge),
    description: charge.description ?? 'Remboursement',
    occurred_at: Math.floor(Date.now() / 1000),
  };
}

export function eventFromSubscription(
  projectId: string,
  sub: Stripe.Subscription,
  kind: 'subscription_created' | 'subscription_updated' | 'subscription_canceled' | 'trial_started',
  mrrDeltaCents: number,
  stripeEventId: string | null,
): NewEvent {
  const econ = subscriptionEconomics(sub);
  const occurredAt =
    kind === 'subscription_canceled'
      ? (sub.canceled_at ?? Math.floor(Date.now() / 1000))
      : (sub.created ?? Math.floor(Date.now() / 1000));

  return {
    ...baseEvent(projectId, kind, sub.id, occurredAt, stripeEventId),
    amount_cents: econ.amountCents,
    currency: econ.currency,
    amount_base_cents: toBaseCents(econ.amountCents, econ.currency),
    mrr_delta_cents: mrrDeltaCents,
    ...customerFields(sub.customer),
    subscription_id: sub.id,
    description: econ.productName,
  };
}
