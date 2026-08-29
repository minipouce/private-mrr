import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { config } from '../config.js';
import { stripeFor } from '../stripe/client.js';
import { ingestEvent, SUBSCRIBED_EVENTS } from '../stripe/ingest.js';

/**
 * Endpoint webhook, un par compte Stripe : `/webhooks/stripe/:projectId`.
 *
 * Cette route est volontairement hors du périmètre d'authentification par jeton —
 * Stripe ne peut pas porter notre Bearer. L'authenticité est garantie par la
 * signature HMAC de Stripe, vérifiée sur le corps brut. Sans cette vérification,
 * n'importe qui pourrait injecter de faux paiements dans la base.
 */
export async function registerWebhooks(app: FastifyInstance): Promise<void> {
  // La signature porte sur les octets exacts reçus : tout reparsing JSON
  // (réordonnancement de clés, espaces) l'invaliderait.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  app.post<{ Params: { projectId: string } }>(
    '/webhooks/stripe/:projectId',
    async (request, reply) => {
      const project = config.projectById.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: 'projet inconnu' });

      if (!project.webhookSecret) {
        request.log.error(
          { project: project.id },
          'webhook reçu mais aucun secret de signature configuré',
        );
        return reply.code(500).send({ error: 'webhook non configuré' });
      }

      const signature = request.headers['stripe-signature'];
      if (typeof signature !== 'string') {
        return reply.code(400).send({ error: 'signature manquante' });
      }

      const stripe = stripeFor(project);
      if (!stripe) return reply.code(500).send({ error: 'client stripe indisponible' });

      let event: Stripe.Event;
      try {
        // Vérifie la signature HMAC *et* la fenêtre temporelle (tolérance 5 min),
        // ce qui bloque aussi le rejeu d'un webhook authentique capturé plus tôt.
        event = stripe.webhooks.constructEvent(
          request.body as Buffer,
          signature,
          project.webhookSecret,
        );
      } catch (err) {
        request.log.warn(
          { project: project.id, ip: request.ip },
          `signature webhook invalide : ${(err as Error).message}`,
        );
        return reply.code(400).send({ error: 'signature invalide' });
      }

      if (!SUBSCRIBED_EVENTS.includes(event.type as (typeof SUBSCRIBED_EVENTS)[number])) {
        return reply.code(200).send({ ignored: event.type });
      }

      // L'écriture en base est synchrone et donc déjà effectuée à ce point ;
      // seul l'envoi push reste en cours. On acquitte immédiatement pour rester
      // sous le délai d'attente de Stripe et éviter des relivraisons inutiles.
      void ingestEvent(project, event).catch((err) => {
        request.log.error(
          { project: project.id, event: event.id },
          `ingestion échouée : ${(err as Error).message}`,
        );
      });

      return reply.code(200).send({ received: true });
    },
  );
}
