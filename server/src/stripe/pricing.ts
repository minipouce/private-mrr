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

/** Net of an invoice line: its amount less the discounts applied to it. */
function lineNet(line: Stripe.InvoiceLineItem): number {
  const raw = line as unknown as {
    amount?: number;
    discount_amounts?: { amount?: number }[] | null;
    proration?: boolean;
  };
  const discounts = (raw.discount_amounts ?? []).reduce((a, d) => a + (d.amount ?? 0), 0);
  return (raw.amount ?? 0) - discounts;
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
function netForPeriod(invoice: Stripe.Invoice): number | null {
  const lines = invoice.lines?.data ?? [];

  if (lines.length === 0) {
    const raw = invoice as unknown as { total_excluding_tax?: number | null; total?: number };
    return raw.total_excluding_tax ?? raw.total ?? null;
  }

  const recurring = lines.filter(
    (l) => !(l as unknown as { proration?: boolean }).proration,
  );
  if (recurring.length === 0) return null;

  return recurring.reduce((total, line) => total + lineNet(line), 0);
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
  /** Amount billed per period, in the subscription's currency. */
  amountCents: number;
  /** That amount brought back to a month. */
  mrrCents: number;
  mrrBaseCents: number;
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
  const amountCents = Math.max(0, source.net);
  const { interval, count } = cadence(sub);

  // Quantity is already inside the invoiced amount, so it must not be applied
  // a second time here.
  const mrrCents = monthlyNormalized(amountCents, interval, count, 1);

  return {
    amountCents,
    mrrCents,
    mrrBaseCents: toBaseCents(mrrCents, currency),
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
): Promise<{ net: number; currency: string } | null> {
  try {
    const invoices = await stripe.invoices.list({ subscription: subscriptionId, limit: 5 });
    for (const invoice of invoices.data) {
      if (invoice.status === 'draft' || invoice.status === 'void') continue;
      const net = netForPeriod(invoice);
      if (net !== null) return { net, currency: invoice.currency ?? 'eur' };
    }
  } catch {
    // Unreadable invoice history: fall through to the preview.
  }

  const preview = await previewInvoice(stripe, subscriptionId);
  if (!preview) return null;

  const net = netForPeriod(preview);
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
}
