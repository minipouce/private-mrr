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
  // Derrière Caddy : indispensable pour que `request.ip` reflète l'IP réelle
  // et non celle du reverse-proxy, sinon le rate-limit devient inopérant.
  trustProxy: true,
  // Un webhook Stripe dépasse rarement 100 Ko ; plafonner limite la surface d'abus.
  bodyLimit: 1_048_576,
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: {
      // Aucun jeton ni signature ne doit atterrir dans les journaux.
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
    // L'API ne sert que du JSON : aucune ressource à autoriser.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
  });

  // Aucune de ces URL n'a vocation à être indexée.
  app.addHook('onSend', async (_request, reply, payload) => {
    void reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
    return payload;
  });

  app.get('/robots.txt', async (_request, reply) =>
    reply.type('text/plain').send('User-agent: *\nDisallow: /\n'),
  );

  // Logos servis sans authentification : une notification push doit pouvoir
  // charger l'image, et un logo de marque n'a rien de confidentiel. Le nom de
  // projet demandé est validé contre la base pour éviter toute traversée de
  // répertoire.
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

  // L'app mobile n'est pas un navigateur et n'émet pas de requête cross-origin :
  // aucune origine web n'est autorisée par défaut.
  await app.register(cors, {
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : false,
  });

  await app.register(rateLimit, {
    // Les webhooks Stripe arrivent en rafale lors d'un pic de paiements, mais
    // une exemption totale laisserait n'importe qui inonder l'endpoint s'il en
    // découvrait l'URL. Le plafond est donc très au-dessus du trafic réel de
    // Stripe, tout en restant borné.
    max: (request) =>
      request.url.startsWith('/webhooks/stripe/')
        ? Number(process.env.RATE_LIMIT_WEBHOOK ?? 1000)
        : Number(process.env.RATE_LIMIT_MAX ?? 300),
    timeWindow: '1 minute',
  });

  // Sonde publique volontairement muette : elle sert au conteneur et au
  // reverse-proxy, et ne doit rien révéler à qui découvrirait l'URL. Le détail
  // (volumes, nombre de projets, appareils) est exposé derrière le jeton.
  app.get('/health', async () => ({ ok: true }));

  // Webhooks : plugin isolé, sans authentification par jeton (signature Stripe),
  // et avec son propre parseur de corps brut.
  await app.register(registerWebhooks);

  // API privée : tout est derrière le jeton Bearer.
  await app.register(async (instance) => {
    instance.addHook('onRequest', requireAuth);
    registerApi(instance);
    registerStream(instance);
  });

  syncProjectsFromConfig();
  await refreshRates();

  if (config.demoMode) {
    app.log.warn('DEMO_MODE actif : aucune connexion Stripe, données fictives');
  } else {
    await verifyKeys();
  }

  if (!isPushConfigured()) {
    app.log.warn(
      'notifications désactivées : clé de compte de service Firebase absente ' +
        '(voir FCM_SERVICE_ACCOUNT_PATH)',
    );
  }

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `serveur prêt · ${config.projects.length} projet(s) · devise ${config.baseCurrency.toUpperCase()}`,
  );

  // Import de l'historique en arrière-plan : le serveur répond déjà pendant ce temps.
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
  // Réconciliation horaire : rattrape un webhook perdu pendant un redéploiement
  // ou une coupure réseau. C'est le filet de sécurité du temps réel.
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

  // `unref` évite que ces minuteries maintiennent le processus en vie à l'arrêt.
  hourly.unref();
  daily.unref();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} reçu, arrêt`);
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
