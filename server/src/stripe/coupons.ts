import type Stripe from 'stripe';

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
