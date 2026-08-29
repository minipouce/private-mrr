import type Stripe from 'stripe';
import type { ProjectConfig } from '../config.js';
import { stripeFor } from './client.js';
import { db } from '../db/index.js';
import { insertEvent, upsertSubscription } from '../db/repo.js';
import {
  eventFromCharge,
  eventFromInvoice,
  eventFromSubscription,
  normalizeSubscription,
  subscriptionEconomics,
  MRR_STATUSES,
} from './normalize.js';
import { toBaseCents, toInternalCents } from '../lib/money.js';
import { markSyncError } from './ingest.js';
import { subscriptionProductName } from './products.js';
import { discountFactor } from './coupons.js';

/**
 * Applique les remises résolues au MRR d'un abonnement normalisé.
 * Les coupons ne sont pas lisibles depuis l'objet abonnement seul : ils exigent
 * une résolution séparée, mémoïsée par `coupons.ts`.
 */
async function applyDiscount(
  stripe: import('stripe').default,
  projectId: string,
  sub: import('stripe').default.Subscription,
  normalized: { mrr_cents: number; mrr_base_cents: number; amount_cents: number },
): Promise<void> {
  const factor = await discountFactor(stripe, projectId, sub, normalized.mrr_cents);
  if (factor === 1) return;

  normalized.mrr_cents = Math.round(normalized.mrr_cents * factor);
  normalized.mrr_base_cents = Math.round(normalized.mrr_base_cents * factor);
  normalized.amount_cents = Math.round(normalized.amount_cents * factor);
}

/**
 * Complète un événement déjà présent avec les champs ajoutés après son import.
 *
 * L'insertion est idempotente et ignore les doublons, ce qui protège des
 * relivraisons — mais laisse aussi les anciennes lignes sans les colonnes
 * apparues depuis. On les renseigne ici, sans jamais écraser une valeur
 * existante ni supprimer quoi que ce soit.
 */
function repairEvent(projectId: string, row: { stripe_object_id: string; billing_reason: string | null; subscription_id: string | null; payment_intent: string | null }): number {
  if (!row.billing_reason && !row.subscription_id && !row.payment_intent) return 0;

  const result = db
    .prepare(
      `UPDATE events SET
         billing_reason  = COALESCE(billing_reason, @billing_reason),
         subscription_id = COALESCE(subscription_id, @subscription_id),
         payment_intent  = COALESCE(payment_intent, @payment_intent)
       WHERE project_id = @project_id
         AND stripe_object_id = @stripe_object_id
         AND (billing_reason IS NULL OR subscription_id IS NULL OR payment_intent IS NULL)`,
    )
    .run({
      project_id: projectId,
      stripe_object_id: row.stripe_object_id,
      billing_reason: row.billing_reason,
      subscription_id: row.subscription_id,
      payment_intent: row.payment_intent,
    });

  return result.changes;
}

/** Profondeur d'historique importée, en mois. 24 permet la comparaison N-1. */
const BACKFILL_MONTHS = Number(process.env.BACKFILL_MONTHS ?? 24);

function since(): number {
  const d = new Date();
  d.setMonth(d.getMonth() - BACKFILL_MONTHS);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/**
 * Importe l'historique d'un compte Stripe.
 *
 * L'API Events de Stripe ne conserve que 30 jours : l'historique long est donc
 * reconstruit depuis les objets eux-mêmes (factures, charges, abonnements)
 * plutôt que depuis le flux d'événements.
 *
 * L'opération est idempotente — les identifiants synthétiques sont déterministes,
 * donc un backfill rejoué n'introduit aucun doublon.
 */
export async function backfillProject(
  project: ProjectConfig,
  opts: { force?: boolean } = {},
): Promise<{ subscriptions: number; events: number }> {
  const stripe = stripeFor(project);
  if (!stripe) return { subscriptions: 0, events: 0 };

  const state = db
    .prepare('SELECT backfill_done FROM sync_state WHERE project_id = ?')
    .get(project.id) as { backfill_done: number } | undefined;

  if (state?.backfill_done === 1 && !opts.force) {
    return { subscriptions: 0, events: 0 };
  }

  const from = since();
  let subCount = 0;
  let eventCount = 0;
  let repaired = 0;

  console.log(`[backfill] ${project.id}: importing since ${new Date(from * 1000).toISOString().slice(0, 10)}`);

  try {
    // ---- Abonnements : état courant + événements de cycle de vie synthétiques
    for await (const sub of stripe.subscriptions.list({
      status: 'all',
      limit: 100,
      expand: ['data.customer'],
    })) {
      const normalized = normalizeSubscription(project.id, sub);
      normalized.product_name =
        normalized.product_name ?? (await subscriptionProductName(stripe, project.id, sub));
      await applyDiscount(stripe, project.id, sub, normalized);
      upsertSubscription(normalized);
      subCount++;

      const econ = subscriptionEconomics(sub);
      const mrrBase = toBaseCents(econ.mrrCents, econ.currency);

      if ((sub.start_date ?? sub.created) >= from) {
        const created = eventFromSubscription(
          project.id,
          sub,
          'subscription_created',
          mrrBase,
          `backfill:sub_created:${sub.id}`,
        );
        if (insertEvent(created, { publish: false })) eventCount++;
      }

      if (sub.canceled_at && sub.canceled_at >= from) {
        const canceled = eventFromSubscription(
          project.id,
          sub,
          'subscription_canceled',
          -mrrBase,
          `backfill:sub_canceled:${sub.id}`,
        );
        if (insertEvent(canceled, { publish: false })) eventCount++;
      }
    }

    // ---- Factures payées : la source de vérité du chiffre d'affaires récurrent
    // `data.payments` est indispensable : c'est la seule façon d'obtenir le
    // payment intent d'une facture, donc de la dédoublonner avec sa charge.
    for await (const invoice of stripe.invoices.list({
      status: 'paid',
      created: { gte: from },
      limit: 100,
      expand: ['data.customer', 'data.payments'],
    })) {
      if ((invoice.amount_paid ?? 0) <= 0) continue;
      const row = eventFromInvoice(
        project.id,
        invoice,
        'payment',
        `backfill:invoice:${invoice.id}`,
      );
      if (insertEvent(row, { publish: false })) eventCount++;
      else repaired += repairEvent(project.id, row);
    }

    // ---- Charges hors facture : paiements ponctuels, et remboursements
    for await (const charge of stripe.charges.list({
      created: { gte: from },
      limit: 100,
      expand: ['data.customer'],
    })) {
      if (!charge.paid || charge.status !== 'succeeded') continue;

      // Les charges adossées à une facture sont écartées par l'index d'unicité
      // sur le payment intent : inutile de les filtrer ici, et impossible de le
      // faire de façon fiable puisque `Charge.invoice` n'existe plus.
      const row = eventFromCharge(project.id, charge, `backfill:charge:${charge.id}`);
      if (insertEvent(row, { publish: false })) eventCount++;

      if ((charge.amount_refunded ?? 0) > 0) {
        const currency = charge.currency ?? 'eur';
        const cents = toInternalCents(charge.amount_refunded, currency);
        const refund = {
          project_id: project.id,
          stripe_event_id: `backfill:refund:${charge.id}`,
          stripe_object_id: charge.id,
          kind: 'refund' as const,
          amount_cents: -cents,
          currency,
          amount_base_cents: -toBaseCents(cents, currency),
          mrr_delta_cents: 0,
          customer_id: typeof charge.customer === 'string' ? charge.customer : (charge.customer?.id ?? null),
          customer_email: charge.billing_details?.email ?? null,
          customer_name: charge.billing_details?.name ?? null,
          subscription_id: null,
          payment_intent: null,
          billing_reason: null,
          description: charge.description ?? 'Remboursement',
          occurred_at: charge.created,
        };
        if (insertEvent(refund, { publish: false })) eventCount++;
      }
    }

    db.prepare(
      `UPDATE sync_state SET backfill_done = 1, last_backfill_at = ?, last_error = NULL WHERE project_id = ?`,
    ).run(Math.floor(Date.now() / 1000), project.id);

    console.log(
      `[backfill] ${project.id}: ${subCount} subscriptions, ${eventCount} events imported` +
        (repaired ? `, ${repaired} completed` : ''),
    );
  } catch (err) {
    const message = (err as Error).message;
    markSyncError(project.id, message);
    console.error(`[backfill] ${project.id}: failed, ${message}`);
  }

  return { subscriptions: subCount, events: eventCount };
}

/**
 * Réconciliation : resynchronise l'état des abonnements actifs.
 * Rattrape les webhooks éventuellement perdus (panne serveur, déploiement).
 */
export async function reconcileProject(project: ProjectConfig): Promise<number> {
  const stripe = stripeFor(project);
  if (!stripe) return 0;

  let count = 0;
  try {
    for (const status of MRR_STATUSES) {
      for await (const sub of stripe.subscriptions.list({
        status: status as Stripe.SubscriptionListParams.Status,
        limit: 100,
        expand: ['data.customer'],
      })) {
        const normalized = normalizeSubscription(project.id, sub);
        normalized.product_name =
          normalized.product_name ?? (await subscriptionProductName(stripe, project.id, sub));
        await applyDiscount(stripe, project.id, sub, normalized);
        upsertSubscription(normalized);
        count++;
      }
    }
    markSyncError(project.id, null);
  } catch (err) {
    markSyncError(project.id, (err as Error).message);
    console.error(`[reconcile] ${project.id}: ${(err as Error).message}`);
  }
  return count;
}
