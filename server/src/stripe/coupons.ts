import type Stripe from 'stripe';

/**
 * Résolution des remises applicables à un abonnement.
 *
 * Deux difficultés cumulées sur les versions récentes de l'API :
 *
 * 1. Une remise peut être portée par le **client** et non par l'abonnement ;
 *    elle s'applique alors à toutes ses factures sans figurer sur l'abonnement.
 * 2. L'objet remise n'embarque plus le coupon : il n'en donne que
 *    l'identifiant, dans `source.coupon`. Le taux doit être récupéré à part.
 *
 * Ignorer l'un ou l'autre fait compter en MRR des comptes offerts que Stripe
 * ne facturera jamais.
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

/** Identifiants de coupon portés par un objet remise, toutes formes confondues. */
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
    if (typeof d === 'string') continue; // remise non étendue : inexploitable
    const disc = d as {
      coupon?: { id?: string; percent_off?: number | null; amount_off?: number | null; currency?: string | null } | string | null;
      source?: { coupon?: string | null } | null;
    };

    // Forme récente : l'identifiant du coupon est dans `source`.
    if (typeof disc.source?.coupon === 'string') {
      out.push(disc.source.coupon);
      continue;
    }
    // Forme historique : le coupon est embarqué, ou réduit à un identifiant.
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
    // Coupon supprimé ou inaccessible : on n'applique aucune remise plutôt que
    // d'interrompre l'import.
    entries.set(id, null);
    return null;
  }
}

/**
 * Facteur multiplicatif à appliquer au montant récurrent, entre 0 et 1.
 * Retourne 1 si aucune remise exploitable n'est trouvée.
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
