import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { config } from '../config.js';
import { stripeFor } from '../stripe/client.js';
import { ingestEvent, SUBSCRIBED_EVENTS } from '../stripe/ingest.js';

/**
 * Webhook endpoint, one per Stripe account: `/webhooks/stripe/:projectId`.
 *
 * This route sits deliberately outside bearer authentication, since Stripe
 * cannot carry our token. Authenticity comes from Stripe's HMAC signature,
 * verified against the raw body. Without that check, anyone could inject fake
 * payments into the database.
 */
export async function registerWebhooks(app: FastifyInstance): Promise<void> {
  // The signature covers the exact bytes received: any JSON re-parsing, key
  // reordering or whitespace change would invalidate it.
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
          'webhook received but no signing secret configured',
        );
        return reply.code(500).send({ error: 'webhook not configured' });
      }

      const signature = request.headers['stripe-signature'];
      if (typeof signature !== 'string') {
        return reply.code(400).send({ error: 'signature manquante' });
      }

      const stripe = stripeFor(project);
      if (!stripe) return reply.code(500).send({ error: 'client stripe indisponible' });

      let event: Stripe.Event;
      try {
        // Verifies the HMAC signature *and* the time window (five-minute
        // tolerance), which also blocks replay of a genuine webhook captured
        // earlier.
        event = stripe.webhooks.constructEvent(
          request.body as Buffer,
          signature,
          project.webhookSecret,
        );
      } catch (err) {
        request.log.warn(
          { project: project.id, ip: request.ip },
          `invalid webhook signature: ${(err as Error).message}`,
        );
        return reply.code(400).send({ error: 'signature invalide' });
      }

      if (!SUBSCRIBED_EVENTS.includes(event.type as (typeof SUBSCRIBED_EVENTS)[number])) {
        return reply.code(200).send({ ignored: event.type });
      }

      // The database write is synchronous and already done at this point; only
      // the push send is still running. Acknowledge immediately to stay under
      // Stripe's timeout and avoid pointless redeliveries.
      void ingestEvent(project, event).catch((err) => {
        request.log.error(
          { project: project.id, event: event.id },
          `ingestion failed: ${(err as Error).message}`,
        );
      });

      return reply.code(200).send({ received: true });
    },
  );
}
