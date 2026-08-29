import type { FastifyInstance } from 'fastify';
import { bus } from '../lib/bus.js';
import { overview } from '../metrics/index.js';
import type { EventRow } from '../db/repo.js';

/**
 * SSE stream: pushes every new event and the recomputed metrics to connected
 * apps, without polling.
 */
export function registerStream(app: FastifyInstance): void {
  app.get('/api/stream', (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disables buffering in any intermediate proxy.
      'X-Accel-Buffering': 'no',
    });

    const send = (type: string, payload: unknown) => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    send('hello', { ok: true, at: Math.floor(Date.now() / 1000) });
    send('metrics', overview());

    const onEvent = (event: EventRow) => send('event', event);

    // Recomputation is coalesced: a burst of webhooks causes a single send.
    let pending: NodeJS.Timeout | null = null;
    const onDirty = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        send('metrics', overview());
      }, 400);
    };

    // Keep-alive frame: stops proxies and mobile networks from cutting a
    // connection they consider idle.
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
