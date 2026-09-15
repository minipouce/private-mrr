import type Stripe from 'stripe';
import { monthlyNormalized, toBaseCents } from '../lib/money.js';
import { applyResolvedDiscount } from './coupons.js';
import { MRR_STATUSES } from './normalize.js';

/**
 * What a subscription is actually going to be billed, asked of Stripe.
 *
 * The price list is not the revenue. A 100% coupon, a partial one, a customer
 * credit balance, a tiered quantity — each makes the amount collected differ
 * from `unit_amount`, and reading the discounts off the subscription object is
 * not enough: recent API versions return them as bare ids unless expanded, and
 * some reductions never appear on the subscription at all.
 *
 * So the question is put to the only authority on it: the invoices Stripe has
 * actually issued for this subscription, with the preview of the next one as a
 * fallback for a subscription too young to have been billed yet.
 */

/**
 * Net of an invoice line: its amount, less only the discounts that will still
 * be there next period.
 *
 * A coupon good for the first invoice only, or one whose window has closed,
 * says nothing about what the subscription is worth from now on. Subtracting it
 * would book a one-off welcome offer as a permanent price cut.
 */
function lineNet(
  line: Stripe.InvoiceLineItem,
  durable: Set<string>,
): { recurring: number; current: number } {
  const raw = line as unknown as {
    amount?: number;
    discount_amounts?: { amount?: number; discount?: string | { id?: string } }[] | null;
  };

  let all = 0;
  let lasting = 0;
  for (const entry of raw.discount_amounts ?? []) {
    const amount = entry.amount ?? 0;
    all += amount;
    const id = typeof entry.discount === 'string' ? entry.discount : entry.discount?.id;
    if (id && durable.has(id)) lasting += amount;
  }

  const amount = raw.amount ?? 0;
  return { recurring: amount - lasting, current: amount - all };
}

/**
 * Which of an invoice's discounts will apply again next period.
 *
 * `forever` always will. `once` never will — it was spent on this invoice.
 * `repeating` will as long as its window is still open.
 */
async function durableDiscountIds(
  stripe: Stripe,
  invoice: Stripe.Invoice,
): Promise<Set<string>> {
  const out = new Set<string>();
  const ids = (invoice.discounts ?? []).map((d) => (typeof d === 'string' ? d : d.id));
  if (ids.length === 0) return out;

  let expanded: Stripe.Discount[] = [];
  try {
    const full = await stripe.invoices.retrieve(invoice.id!, { expand: ['discounts'] });
    expanded = (full.discounts ?? []).filter((d): d is Stripe.Discount => typeof d !== 'string');
  } catch {
    // Cannot tell whether they recur. Treating them as durable keeps the
    // behaviour of trusting the invoice, rather than inventing revenue.
    for (const id of ids) if (id) out.add(id);
    return out;
  }

  const now = Math.floor(Date.now() / 1000);
  for (const discount of expanded) {
    const raw = discount as unknown as {
      id?: string;
      end?: number | null;
      coupon?: { id?: string; duration?: string } | string | null;
      source?: { coupon?: string | null } | null;
    };
    if (!raw.id) continue;

    const couponId =
      raw.source?.coupon ?? (typeof raw.coupon === 'string' ? raw.coupon : raw.coupon?.id);
    const duration = await couponDuration(stripe, couponId, raw.coupon);

    const recurs =
      duration === 'forever' ||
      (duration === 'repeating' && (raw.end == null || raw.end > now)) ||
      // Unknown duration: trust the invoice rather than guess a price rise.
      duration === null;

    if (recurs) out.add(raw.id);
  }
  return out;
}

const COUPON_DURATIONS = new Map<string, string | null>();

/** A coupon's duration, fetched once. `null` when it cannot be established. */
async function couponDuration(
  stripe: Stripe,
  couponId: string | null | undefined,
  embedded: { duration?: string } | string | null | undefined,
): Promise<string | null> {
  if (embedded && typeof embedded !== 'string' && embedded.duration) return embedded.duration;
  if (!couponId) return null;
  if (COUPON_DURATIONS.has(couponId)) return COUPON_DURATIONS.get(couponId) ?? null;

  try {
    const coupon = await stripe.coupons.retrieve(couponId);
    COUPON_DURATIONS.set(couponId, coupon.duration ?? null);
    return coupon.duration ?? null;
  } catch {
    COUPON_DURATIONS.set(couponId, null);
    return null;
  }
}

/**
 * Amount an invoice bills for a period, net of discounts and excluding tax.
 *
 * Summed line by line rather than taken from the invoice total, for two
 * reasons: a proration line from a mid-cycle plan change has nothing to do with
 * recurring revenue, and a line's own `discount_amounts` is the only place a
 * partial coupon is expressed per item.
 *
 * Returns `null` when the invoice says nothing about recurring revenue — it
 * carries only prorations — so the caller can look elsewhere instead of taking
 * a one-off adjustment for the subscription's worth.
 */
async function netForPeriod(
  stripe: Stripe,
  invoice: Stripe.Invoice,
): Promise<{ recurring: number; current: number } | null> {
  const lines = invoice.lines?.data ?? [];

  if (lines.length === 0) {
    const raw = invoice as unknown as { total_excluding_tax?: number | null; total?: number };
    const total = raw.total_excluding_tax ?? raw.total;
    return total === undefined || total === null ? null : { recurring: total, current: total };
  }

  const recurring = lines.filter((line) => {
    const raw = line as unknown as { proration?: boolean; amount?: number };
    // A negative line is a credit for time already paid on a plan the customer
    // has left. Stripe does not always flag it as a proration, and summing it
    // would halve the rate of anyone who just changed plan mid-cycle.
    return !raw.proration && (raw.amount ?? 0) > 0;
  });
  if (recurring.length === 0) return null;

  const durable = await durableDiscountIds(stripe, invoice);
  return recurring.reduce(
    (total, line) => {
      const net = lineNet(line, durable);
      return { recurring: total.recurring + net.recurring, current: total.current + net.current };
    },
    { recurring: 0, current: 0 },
  );
}

/** Billing cadence of a subscription, read off its first recurring item. */
function cadence(sub: Stripe.Subscription): { interval: string; count: number } {
  for (const item of sub.items?.data ?? []) {
    const recurring = item.price?.recurring;
    if (recurring) {
      return { interval: recurring.interval, count: recurring.interval_count ?? 1 };
    }
  }
  return { interval: 'month', count: 1 };
}

export interface RealEconomics {
  /** Recurring amount per period, in the subscription's currency. */
  amountCents: number;
  /** That amount brought back to a month. */
  mrrCents: number;
  mrrBaseCents: number;
  /** What is billed right now: below `mrrBaseCents` while a temporary coupon runs. */
  mrrCurrentBaseCents: number;
  currency: string;
}

/**
 * Asks Stripe what the next invoice will come to, and derives MRR from it.
 *
 * Returns `null` when the preview cannot be obtained — a subscription ending at
 * period end, an incomplete one, a transient API failure. The caller then keeps
 * the price-based figure rather than losing the subscription's MRR entirely.
 */
export async function realEconomics(
  stripe: Stripe,
  sub: Stripe.Subscription,
): Promise<RealEconomics | null> {
  const source = await billedAmount(stripe, sub.id);
  if (source === null) return null;

  const currency = source.currency ?? sub.currency ?? 'eur';
  const amountCents = Math.max(0, source.net.recurring);
  const currentCents = Math.max(0, source.net.current);
  const { interval, count } = cadence(sub);

  // Quantity is already inside the invoiced amount, so it must not be applied
  // a second time here.
  const mrrCents = monthlyNormalized(amountCents, interval, count, 1);
  const currentMrrCents = monthlyNormalized(currentCents, interval, count, 1);

  return {
    amountCents,
    mrrCents,
    mrrBaseCents: toBaseCents(mrrCents, currency),
    mrrCurrentBaseCents: toBaseCents(currentMrrCents, currency),
    currency,
  };
}

/**
 * What the subscription is billed for the period it is in.
 *
 * The invoices already issued come first, and the preview of the next one only
 * as a fallback. The order matters: a coupon covering the first year of an
 * annual plan makes the invoices issued so far zero while the preview — the
 * invoice a year out, by then undiscounted — reads full price. Asking what the
 * customer has actually been billed answers "what do they pay"; asking what
 * they will be billed answers a different question.
 *
 * Drafts and voided invoices are skipped: neither is a bill anyone owes.
 */
async function billedAmount(
  stripe: Stripe,
  subscriptionId: string,
): Promise<{ net: { recurring: number; current: number }; currency: string } | null> {
  try {
    const invoices = await stripe.invoices.list({ subscription: subscriptionId, limit: 5 });
    for (const invoice of invoices.data) {
      if (invoice.status === 'draft' || invoice.status === 'void') continue;
      const net = await netForPeriod(stripe, invoice);
      if (net !== null) return { net, currency: invoice.currency ?? 'eur' };
    }
  } catch {
    // Unreadable invoice history: fall through to the preview.
  }

  const preview = await previewInvoice(stripe, subscriptionId);
  if (!preview) return null;

  const net = await netForPeriod(stripe, preview);
  return net === null ? null : { net, currency: preview.currency ?? 'eur' };
}

/** `retrieveUpcoming` became `createPreview`; whichever exists is used. */
async function previewInvoice(stripe: Stripe, subscriptionId: string): Promise<Stripe.Invoice | null> {
  const api = stripe.invoices as unknown as {
    createPreview?: (args: { subscription: string }) => Promise<Stripe.Invoice>;
    retrieveUpcoming?: (args: { subscription: string }) => Promise<Stripe.Invoice>;
  };

  try {
    if (api.createPreview) return await api.createPreview({ subscription: subscriptionId });
    if (api.retrieveUpcoming) return await api.retrieveUpcoming({ subscription: subscriptionId });
  } catch {
    // No preview available: Stripe refuses one for a subscription it will never
    // invoice again. The caller keeps what the price list says.
  }
  return null;
}

/**
 * Replaces a normalised subscription's price-based figures with what Stripe is
 * actually going to bill it.
 *
 * Falls back to resolving its coupons when no preview can be had, so a
 * subscription is never left weighing its list price by default. The status
 * rule survives either way: one that is not billing weighs zero, whatever the
 * preview says.
 */
export async function applyRealEconomics(
  stripe: Stripe,
  projectId: string,
  sub: Stripe.Subscription,
  normalized: {
    status: string;
    mrr_cents: number;
    mrr_base_cents: number;
    mrr_current_base_cents: number;
    amount_cents: number;
  },
): Promise<void> {
  const real = await realEconomics(stripe, sub);

  if (!real) {
    await applyResolvedDiscount(stripe, projectId, sub, normalized);
    return;
  }

  const billing = MRR_STATUSES.includes(normalized.status);
  normalized.amount_cents = real.amountCents;
  normalized.mrr_cents = billing ? real.mrrCents : 0;
  normalized.mrr_base_cents = billing ? real.mrrBaseCents : 0;
  normalized.mrr_current_base_cents = billing ? real.mrrCurrentBaseCents : 0;
}
