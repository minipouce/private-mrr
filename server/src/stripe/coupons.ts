import type Stripe from 'stripe';
import { toBaseCents } from '../lib/money.js';
import { subscriptionEconomics } from './normalize.js';

/**
 * Resolves the discounts that apply to a subscription.
 *
 * Two compounding difficulties on recent API versions:
 *
 * 1. A discount can be attached to the **customer** rather than the
 *    subscription, in which case it applies to every invoice without appearing
 *    on the subscription at all.
 * 2. The discount object no longer embeds its coupon: it carries only the id,
 *    under `source.coupon`. The rate has to be fetched separately.
 *
 * Missing either one counts comped accounts towards MRR, for money Stripe will
 * never bill.
 */

interface CouponValue {
  percentOff: number | null;
  amountOff: number | null;
  currency: string | null;
}

const cache = new Map<string, Map<string, CouponValue | null>>();

function cacheFor(projectId: string): Map<string, CouponValue | null> {
  let entry = cache.get(projectId);
  if (!entry) {
    entry = new Map();
    cache.set(projectId, entry);
  }
  return entry;
}

/** Coupon references carried by a discount object, in any of its shapes. */
function couponRefs(holder: unknown): Array<string | CouponValue> {
  const raw = holder as {
    discount?: unknown;
    discounts?: unknown[];
  } | null | undefined;
  if (!raw) return [];

  const discounts: unknown[] = [];
  if (raw.discount) discounts.push(raw.discount);
  for (const d of raw.discounts ?? []) if (d) discounts.push(d);

  const out: Array<string | CouponValue> = [];
  for (const d of discounts) {
    if (typeof d === 'string') continue; // unexpanded discount: unusable
    const disc = d as {
      coupon?: { id?: string; percent_off?: number | null; amount_off?: number | null; currency?: string | null } | string | null;
      source?: { coupon?: string | null } | null;
    };

    // Recent shape: the coupon id lives under `source`.
    if (typeof disc.source?.coupon === 'string') {
      out.push(disc.source.coupon);
      continue;
    }
    // Legacy shape: the coupon is embedded, or reduced to an id.
    if (typeof disc.coupon === 'string') out.push(disc.coupon);
    else if (disc.coupon) {
      out.push({
        percentOff: disc.coupon.percent_off ?? null,
        amountOff: disc.coupon.amount_off ?? null,
        currency: disc.coupon.currency ?? null,
      });
    }
  }
  return out;
}

async function resolve(
  stripe: Stripe,
  projectId: string,
  id: string,
): Promise<CouponValue | null> {
  const entries = cacheFor(projectId);
  if (entries.has(id)) return entries.get(id) ?? null;

  try {
    const coupon = await stripe.coupons.retrieve(id);
    const value: CouponValue = {
      percentOff: coupon.percent_off ?? null,
      amountOff: coupon.amount_off ?? null,
      currency: coupon.currency ?? null,
    };
    entries.set(id, value);
    return value;
  } catch {
    // Deleted or inaccessible coupon: apply no discount rather than aborting
    // the import.
    entries.set(id, null);
    return null;
  }
}

/**
 * Multiplier to apply to the recurring amount, between 0 and 1.
 * Returns 1 when no usable discount is found.
 */
export async function discountFactor(
  stripe: Stripe,
  projectId: string,
  sub: Stripe.Subscription,
  monthlyCents: number,
): Promise<number> {
  const refs = [
    ...couponRefs(sub),
    ...(typeof sub.customer === 'object' ? couponRefs(sub.customer) : []),
  ];
  if (refs.length === 0 || monthlyCents <= 0) return 1;

  let remaining = monthlyCents;
  for (const ref of refs) {
    const coupon = typeof ref === 'string' ? await resolve(stripe, projectId, ref) : ref;
    if (!coupon) continue;

    if (coupon.percentOff) remaining = remaining * (1 - coupon.percentOff / 100);
    else if (coupon.amountOff) remaining = Math.max(0, remaining - coupon.amountOff);
  }

  return Math.max(0, Math.min(1, remaining / monthlyCents));
}

/**
 * Applies the resolved discounts to an already normalised subscription.
 *
 * `normalizeSubscription` only sees the discounts the object itself carries,
 * which recent API versions reduce to an id — and a webhook payload leaves the
 * customer unexpanded, hiding a customer-level discount entirely. Without this
 * second pass a comped account enters MRR at list price.
 */
export async function applyResolvedDiscount(
  stripe: Stripe,
  projectId: string,
  sub: Stripe.Subscription,
  normalized: { mrr_cents: number; mrr_base_cents: number; amount_cents: number },
): Promise<void> {
  const factor = await discountFactor(stripe, projectId, sub, normalized.mrr_cents);
  if (factor === 1) return;

  normalized.mrr_cents = Math.round(normalized.mrr_cents * factor);
  normalized.mrr_base_cents = Math.round(normalized.mrr_base_cents * factor);
  normalized.amount_cents = Math.round(normalized.amount_cents * factor);
}

/** Statuses under which a subscription has never billed a cent. */
const NEVER_BILLED = ['trialing', 'incomplete', 'incomplete_expired'];

/**
 * What a subscription weighs in an MRR movement event, in the base currency:
 * its discounted monthly amount, whatever its status today.
 *
 * Zero while it has never billed. Booking a trial or an abandoned checkout at
 * list price invents new business the account never had, and its cancellation
 * then invents the churn that offsets it — in another month, so the two never
 * cancel out on screen.
 *
 * Deliberately recomputed rather than read from the stored subscription: that
 * one is zeroed the moment the subscription stops billing, while a cancellation
 * event has to carry the MRR being lost.
 */
export async function movementMrrBaseCents(
  stripe: Stripe,
  projectId: string,
  sub: Stripe.Subscription,
): Promise<number> {
  if (NEVER_BILLED.includes(sub.status)) return 0;

  const econ = subscriptionEconomics(sub);
  const factor = await discountFactor(stripe, projectId, sub, econ.mrrCents);
  return toBaseCents(Math.round(econ.mrrCents * factor), econ.currency);
}
