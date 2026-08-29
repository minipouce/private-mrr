import type Stripe from 'stripe';

/**
 * Résolution des noms de produits, mémoïsée par projet.
 *
 * L'API Stripe limite l'expansion à quatre niveaux : demander
 * `data.items.data.price.product` sur une liste d'abonnements en fait cinq et
 * se solde par une erreur. On récupère donc les produits séparément, une seule
 * fois chacun, ce qui reste peu coûteux — un catalogue compte quelques dizaines
 * de produits, pas des milliers.
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

  // Déjà étendu par l'appelant : rien à récupérer.
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
    // Un produit supprimé ou inaccessible ne doit pas interrompre le backfill.
    entries.set(ref, null);
    return null;
  }
}

/** Premier produit référencé par un abonnement, pour l'affichage. */
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
