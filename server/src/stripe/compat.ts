import type Stripe from 'stripe';

/**
 * Access to fields Stripe has relocated between API versions.
 *
 * Verified against API 2026-08-26.dahlia: `Invoice.subscription`,
 * `Invoice.charge`, `Invoice.payment_intent` and `Charge.invoice` are all gone.
 * Relying on them produces a silently wrong import: payments detached from
 * their subscription, and counted twice.
 */

/** Subscription id carried by an invoice. */
export function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const raw = invoice as unknown as {
    subscription?: string | { id?: string } | null;
    parent?: { subscription_details?: { subscription?: string | { id?: string } | null } | null } | null;
  };

  // Current location first, then fall back to the legacy one.
  const candidates = [raw.parent?.subscription_details?.subscription, raw.subscription];
  for (const value of candidates) {
    if (!value) continue;
    const id = typeof value === 'string' ? value : (value.id ?? null);
    if (id) return id;
  }
  return null;
}

/**
 * Payment intents that settled an invoice.
 *
 * Requires `expand: ['data.payments']` when reading: without it the field is
 * absent and the invoice-to-charge link becomes impossible to establish.
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

/** Payment intent behind a charge. */
export function chargePaymentIntent(charge: Stripe.Charge): string | null {
  const raw = charge as unknown as { payment_intent?: string | { id?: string } | null };
  const value = raw.payment_intent;
  if (!value) return null;
  return typeof value === 'string' ? value : (value.id ?? null);
}
