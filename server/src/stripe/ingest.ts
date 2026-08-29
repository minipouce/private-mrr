import type Stripe from 'stripe';
import type { ProjectConfig } from '../config.js';
import { stripeFor } from './client.js';
import { invoicePaymentIntents } from './compat.js';
import { insertEvent, getSubscription, upsertSubscription, type EventRow } from '../db/repo.js';
import {
  eventFromCharge,
  eventFromInvoice,
  eventFromRefund,
  eventFromSubscription,
  normalizeSubscription,
  MRR_STATUSES,
} from './normalize.js';
import { notifyEvent } from '../push/index.js';
import { db } from '../db/index.js';

/** Types d'événements que l'on souscrit côté Stripe. */
export const SUBSCRIBED_EVENTS = [
  'invoice.paid',
  'invoice.payment_failed',
  'charge.succeeded',
  'charge.refunded',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
] as const;

/**
 * Traite un événement Stripe vérifié.
 *
 * `notify` est désactivé pendant le backfill : rejouer deux ans d'historique
 * ne doit pas déclencher des milliers de notifications.
 */
export async function ingestEvent(
  project: ProjectConfig,
  event: Stripe.Event,
  opts: { notify?: boolean } = {},
): Promise<EventRow | null> {
  const notify = opts.notify !== false;
  const row = await handle(project, event);
  if (!row) return null;

  if (notify) await notifyEvent(row, project.name);
  return row;
}

async function handle(project: ProjectConfig, event: Stripe.Event): Promise<EventRow | null> {
  const projectId = project.id;
  const object = event.data.object as unknown as Record<string, unknown>;

  switch (event.type) {
    case 'invoice.paid': {
      const invoice = object as unknown as Stripe.Invoice;
      // Une facture à 0 € (essai, crédit intégral) n'est pas un encaissement.
      if ((invoice.amount_paid ?? 0) <= 0) return null;

      // Le corps du webhook ne contient pas les paiements étendus, donc pas de
      // payment intent — or c'est la clé qui empêche de compter deux fois la
      // facture et sa charge. On relit la facture pour l'obtenir : un appel par
      // encaissement, négligeable au regard du risque de doubler le CA.
      let enriched = invoice;
      if (invoicePaymentIntents(invoice).length === 0 && invoice.id) {
        const stripe = stripeFor(project);
        if (stripe) {
          try {
            enriched = await stripe.invoices.retrieve(invoice.id, { expand: ['payments'] });
          } catch {
            // Échec de relecture : on insère sans clé de déduplication plutôt
            // que de perdre l'encaissement. La réconciliation horaire corrigera.
          }
        }
      }

      return insertEvent(eventFromInvoice(projectId, enriched, 'payment', event.id));
    }

    case 'invoice.payment_failed': {
      const invoice = object as unknown as Stripe.Invoice;
      return insertEvent(eventFromInvoice(projectId, invoice, 'payment_failed', event.id));
    }

    case 'charge.succeeded': {
      const charge = object as unknown as Stripe.Charge;
      // Pas de filtrage : une charge adossée à une facture partage son payment
      // intent, et l'index d'unicité écarte le second arrivé — quel que soit
      // l'ordre entre `invoice.paid` et `charge.succeeded`.
      return insertEvent(eventFromCharge(projectId, charge, event.id));
    }

    case 'charge.refunded': {
      const charge = object as unknown as Stripe.Charge;
      return insertEvent(eventFromRefund(projectId, charge, event.id));
    }

    case 'customer.subscription.created': {
      const sub = object as unknown as Stripe.Subscription;
      const normalized = normalizeSubscription(projectId, sub);
      upsertSubscription(normalized);
      const kind = sub.status === 'trialing' ? 'trial_started' : 'subscription_created';
      return insertEvent(
        eventFromSubscription(projectId, sub, kind, normalized.mrr_base_cents, event.id),
      );
    }

    case 'customer.subscription.updated': {
      const sub = object as unknown as Stripe.Subscription;
      const previous = getSubscription(projectId, sub.id);
      const normalized = normalizeSubscription(projectId, sub);
      upsertSubscription(normalized);

      const before = previous?.mrr_base_cents ?? 0;
      const delta = normalized.mrr_base_cents - before;

      // Passage d'essai à payant : c'est une conversion, pas un simple update.
      const converted =
        previous && !MRR_STATUSES.includes(previous.status) && MRR_STATUSES.includes(sub.status);
      if (converted) {
        return insertEvent(
          eventFromSubscription(
            projectId,
            sub,
            'subscription_created',
            normalized.mrr_base_cents,
            event.id,
          ),
        );
      }

      if (delta === 0) return null;
      return insertEvent(
        eventFromSubscription(projectId, sub, 'subscription_updated', delta, event.id),
      );
    }

    case 'customer.subscription.deleted': {
      const sub = object as unknown as Stripe.Subscription;
      const previous = getSubscription(projectId, sub.id);
      const lost = previous?.mrr_base_cents ?? 0;

      const normalized = normalizeSubscription(projectId, sub);
      upsertSubscription({ ...normalized, status: 'canceled', mrr_cents: 0, mrr_base_cents: 0 });

      return insertEvent(
        eventFromSubscription(projectId, sub, 'subscription_canceled', -lost, event.id),
      );
    }

    default:
      return null;
  }
}

export function markSyncError(projectId: string, message: string | null): void {
  db.prepare('UPDATE sync_state SET last_error = ? WHERE project_id = ?').run(
    message,
    projectId,
  );
}
