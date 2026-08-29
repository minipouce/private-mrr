import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';

import { config } from './config.js';
import { db, syncProjectsFromConfig } from './db/index.js';
import { refreshRates } from './lib/money.js';
import { verifyKeys, liveProjects } from './stripe/client.js';
import { backfillProject, reconcileProject } from './stripe/backfill.js';
import { readFileSync } from 'node:fs';
import { isPushConfigured } from './push/index.js';
import { hasLogo, logoPath, sniffImageType, syncAllLogos } from './stripe/branding.js';
import { requireAuth } from './routes/auth.js';
import { registerApi } from './routes/api.js';
import { registerWebhooks } from './routes/webhook.js';
import { registerStream } from './routes/stream.js';

const app = Fastify({
  // Behind a reverse proxy: required so `request.ip` reflects the real client
  // rather than the proxy, without which rate limiting is useless.
  trustProxy: true,
  // A Stripe webhook rarely exceeds 100 KB; a cap limits the abuse surface.
  bodyLimit: 1_048_576,
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: {
      // No token or signature must ever reach the logs.
      paths: [
        'req.headers.authorization',
        'req.headers["stripe-signature"]',
        'req.headers.cookie',
      ],
      remove: true,
    },
    transport:
      process.env.NODE_ENV === 'production'
        ? undefined
        : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
  },
});

async function boot(): Promise<void> {
  await app.register(helmet, {
    // The API only serves JSON: no resource to allow.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
  });

  // None of these URLs is meant to be indexed.
  app.addHook('onSend', async (_request, reply, payload) => {
    void reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
    return payload;
  });

  app.get('/robots.txt', async (_request, reply) =>
    reply.type('text/plain').send('User-agent: *\nDisallow: /\n'),
  );

  // Logos are served unauthenticated: a push notification must be able to load
  // the image, and a brand logo is not confidential. The requested project id is
  // validated against the database to prevent any path traversal.
  app.get<{ Params: { projectId: string } }>('/logos/:projectId', async (request, reply) => {
    const known = db
      .prepare('SELECT 1 FROM projects WHERE id = ?')
      .get(request.params.projectId);
    if (!known || !hasLogo(request.params.projectId)) {
      return reply.code(404).send({ error: 'logo introuvable' });
    }

    const buf = readFileSync(logoPath(request.params.projectId));
    const type = sniffImageType(buf);
    if (!type) return reply.code(404).send({ error: 'logo illisible' });

    return reply
      .header('Cache-Control', 'public, max-age=86400')
      .type(type)
      .send(buf);
  });

  // The mobile app is not a browser and issues no cross-origin request, so no
  // web origin is allowed by default.
  await app.register(cors, {
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : false,
  });

  await app.register(rateLimit, {
    // Stripe webhooks arrive in bursts during a payment spike, but a blanket
    // exemption would let anyone flood the endpoint who discovered its URL. The
    // ceiling therefore sits far above real Stripe traffic while staying bounded.
    max: (request) =>
      request.url.startsWith('/webhooks/stripe/')
        ? Number(process.env.RATE_LIMIT_WEBHOOK ?? 1000)
        : Number(process.env.RATE_LIMIT_MAX ?? 300),
    timeWindow: '1 minute',
  });

  // Deliberately mute public probe: it serves the container and the reverse
  // proxy, and must reveal nothing to whoever finds the URL. The detail (volumes,
  // project and device counts) sits behind the token.
  app.get('/health', async () => ({ ok: true }));

  // Webhooks: isolated plugin, no bearer authentication (Stripe signature does
  // the job), with its own raw-body parser.
  await app.register(registerWebhooks);

  // Private API: everything sits behind the bearer token.
  await app.register(async (instance) => {
    // Some actions carry no data. A client announcing JSON with no body would be
    // refused by the default parser, so an empty body is treated as an empty
    // object rather than an error.
    instance.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (_req, body, done) => {
        const raw = (body as string).trim();
        if (!raw) return done(null, {});
        try {
          done(null, JSON.parse(raw));
        } catch {
          // An unreadable body is a client mistake: report it as such rather than
          // letting Fastify conclude the server failed.
          const error = new Error('Corps JSON invalide') as Error & { statusCode?: number };
          error.statusCode = 400;
          done(error, undefined);
        }
      },
    );

    instance.addHook('onRequest', requireAuth);
    registerApi(instance);
    registerStream(instance);
  });

  syncProjectsFromConfig();
  await refreshRates();

  if (config.demoMode) {
    app.log.warn('DEMO_MODE active: no Stripe connection, fictional data');
  } else {
    await verifyKeys();
  }

  if (!isPushConfigured()) {
    app.log.warn(
      'notifications disabled: Firebase service account key missing ' +
        '(see FCM_SERVICE_ACCOUNT_PATH)',
    );
  }

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `server ready · ${config.projects.length} project(s) · currency ${config.baseCurrency.toUpperCase()}`,
  );

  // History import runs in the background: the server already answers meanwhile.
  if (!config.demoMode && config.backfillOnBoot) {
    void (async () => {
      for (const project of liveProjects()) {
        await backfillProject(project);
      }
      await syncAllLogos(liveProjects());
    })();
  }

  scheduleJobs();
}

function scheduleJobs(): void {
  // Hourly reconciliation: catches a webhook lost during a redeploy or a network
  // outage. It is the safety net under the real-time path.
  const hourly = setInterval(
    () => {
      if (config.demoMode) return;
      void (async () => {
        for (const project of liveProjects()) await reconcileProject(project);
      })();
    },
    60 * 60 * 1000,
  );

  const daily = setInterval(() => {
    void refreshRates();
    if (!config.demoMode) void syncAllLogos(liveProjects());
  }, 24 * 60 * 60 * 1000);

  // `unref` keeps these timers from holding the process alive on shutdown.
  hourly.unref();
  daily.unref();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    void app.close().then(() => {
      db.close();
      process.exit(0);
    });
  });
}

boot().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
