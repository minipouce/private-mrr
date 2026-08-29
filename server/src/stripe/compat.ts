import type Stripe from 'stripe';

/**
 * Accès aux champs dont Stripe a changé l'emplacement entre versions d'API.
 *
 * Vérifié sur l'API 2026-08-26.dahlia : `Invoice.subscription`,
 * `Invoice.charge`, `Invoice.payment_intent` et `Charge.invoice` ont tous
 * disparu. S'appuyer dessus produit un import silencieusement faux — des
 * paiements non rattachés à leur abonnement, et comptés deux fois.
 */

/** Identifiant d'abonnement porté par une facture. */
export function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const raw = invoice as unknown as {
    subscription?: string | { id?: string } | null;
    parent?: { subscription_details?: { subscription?: string | { id?: string } | null } | null } | null;
  };

  // Emplacement actuel, puis repli sur l'ancien.
  const candidates = [raw.parent?.subscription_details?.subscription, raw.subscription];
  for (const value of candidates) {
    if (!value) continue;
    const id = typeof value === 'string' ? value : (value.id ?? null);
    if (id) return id;
  }
  return null;
}

/**
 * Payment intents ayant réglé une facture.
 *
 * Nécessite `expand: ['data.payments']` à la lecture : sans cette expansion le
 * champ est absent et le lien facture/charge devient introuvable.
 */
export function invoicePaymentIntents(invoice: Stripe.Invoice): string[] {
  const raw = invoice as unknown as {
    payments?: { data?: Array<{ payment?: { payment_intent?: string | { id?: string } | null } | null }> } | null;
  };

  const out: string[] = [];
  for (const entry of raw.payments?.data ?? []) {
    const value = entry?.payment?.payment_intent;
    if (!value) continue;
    const id = typeof value === 'string' ? value : (value.id ?? null);
    if (id) out.push(id);
  }
  return out;
}

/** Payment intent d'une charge. */
export function chargePaymentIntent(charge: Stripe.Charge): string | null {
  const raw = charge as unknown as { payment_intent?: string | { id?: string } | null };
  const value = raw.payment_intent;
  if (!value) return null;
  return typeof value === 'string' ? value : (value.id ?? null);
}
