import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { stripeFor } from '../stripe/client.js';
import { ingestEvent, SUBSCRIBED_EVENTS } from '../stripe/ingest.js';
import { ingestRevenueCat } from '../revenuecat/ingest.js';
import type { RevenueCatEvent } from '../revenuecat/normalize.js';

/**
 * Compares two secrets without leaking their length or content through timing.
 *
 * Hashed first so both sides are the same size whatever was sent: comparing
 * buffers of different lengths throws, and returning early on the first
 * differing byte is exactly the leak this avoids.
 */
function sameSecret(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

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

  /**
   * RevenueCat endpoint, one per project: `/webhooks/revenuecat/:projectId`.
   *
   * RevenueCat does not sign its webhooks. It repeats a secret of your choosing
   * in the `Authorization` header, set in its dashboard, so that header is the
   * only thing standing between the ledger and anyone who finds the URL.
   */
  app.post<{ Params: { projectId: string } }>(
    '/webhooks/revenuecat/:projectId',
    async (request, reply) => {
      const project = config.projectById.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: 'projet inconnu' });

      const expected = project.revenuecat?.webhookAuth;
      if (!expected) {
        request.log.error(
          { project: project.id },
          'revenuecat webhook received but no authorization secret configured',
        );
        return reply.code(500).send({ error: 'webhook not configured' });
      }

      const given = request.headers.authorization;
      if (typeof given !== 'string' || !sameSecret(given, expected)) {
        request.log.warn(
          { project: project.id, ip: request.ip },
          'invalid revenuecat authorization header',
        );
        return reply.code(401).send({ error: 'non autorise' });
      }

      let event: RevenueCatEvent;
      try {
        const parsed = JSON.parse((request.body as Buffer).toString('utf8')) as {
          event?: RevenueCatEvent;
        };
        if (!parsed.event) throw new Error('champ event absent');
        event = parsed.event;
      } catch (err) {
        return reply.code(400).send({ error: `corps illisible: ${(err as Error).message}` });
      }

      void ingestRevenueCat(project, event).catch((err) => {
        request.log.error(
          { project: project.id, event: event.id },
          `ingestion revenuecat failed: ${(err as Error).message}`,
        );
      });

      return reply.code(200).send({ received: true });
    },
  );
}
