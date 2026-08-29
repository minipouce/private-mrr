import type { FastifyInstance } from 'fastify';
import { bus } from '../lib/bus.js';
import { overview } from '../metrics/index.js';
import type { EventRow } from '../db/repo.js';

/**
 * Flux SSE : pousse chaque nouvel événement et les métriques recalculées
 * vers les apps connectées, sans polling.
 */
export function registerStream(app: FastifyInstance): void {
  app.get('/api/stream', (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Désactive la mise en tampon d'un éventuel proxy intermédiaire.
      'X-Accel-Buffering': 'no',
    });

    const send = (type: string, payload: unknown) => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    send('hello', { ok: true, at: Math.floor(Date.now() / 1000) });
    send('metrics', overview());

    const onEvent = (event: EventRow) => send('event', event);

    // Le recalcul est groupé : une rafale de webhooks ne provoque qu'un envoi.
    let pending: NodeJS.Timeout | null = null;
    const onDirty = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        send('metrics', overview());
      }, 400);
    };

    // Trame de maintien : empêche les proxies et le réseau mobile de couper
    // une connexion jugée inactive.
    const heartbeat = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(': ping\n\n');
    }, 25_000);

    bus.on('event', onEvent);
    bus.on('metrics:dirty', onDirty);

    const cleanup = () => {
      clearInterval(heartbeat);
      if (pending) clearTimeout(pending);
      bus.off('event', onEvent);
      bus.off('metrics:dirty', onDirty);
    };

    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
  });
}
