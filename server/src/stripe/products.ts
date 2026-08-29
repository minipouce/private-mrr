import type Stripe from 'stripe';

/**
 * Product name resolution, memoised per project.
 *
 * Stripe caps expansion at four levels: asking for
 * `data.items.data.price.product` on a subscription list makes five and fails.
 * Products are therefore fetched separately, once each, which stays cheap — a
 * catalogue holds dozens of products, not thousands.
 */
const cache = new Map<string, Map<string, string | null>>();

function cacheFor(projectId: string): Map<string, string | null> {
  let entry = cache.get(projectId);
  if (!entry) {
    entry = new Map();
    cache.set(projectId, entry);
  }
  return entry;
}

export async function productName(
  stripe: Stripe,
  projectId: string,
  ref: string | Stripe.Product | Stripe.DeletedProduct | null | undefined,
): Promise<string | null> {
  if (!ref) return null;

  // Already expanded by the caller: nothing to fetch.
  if (typeof ref !== 'string') {
    return 'deleted' in ref && ref.deleted ? null : ((ref as Stripe.Product).name ?? null);
  }

  const entries = cacheFor(projectId);
  if (entries.has(ref)) return entries.get(ref) ?? null;

  try {
    const product = await stripe.products.retrieve(ref);
    const name = product.deleted ? null : (product.name ?? null);
    entries.set(ref, name);
    return name;
  } catch {
    // A deleted or inaccessible product must not abort the backfill.
    entries.set(ref, null);
    return null;
  }
}

/** First product referenced by a subscription, for display. */
export async function subscriptionProductName(
  stripe: Stripe,
  projectId: string,
  sub: Stripe.Subscription,
): Promise<string | null> {
  for (const item of sub.items?.data ?? []) {
    const name = await productName(stripe, projectId, item.price?.product);
    if (name) return name;
  }
  return null;
}
