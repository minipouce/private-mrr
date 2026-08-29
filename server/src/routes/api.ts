import type { FastifyInstance } from 'fastify';
import { db, listProjects } from '../db/index.js';
import { config } from '../config.js';
import { overview, projectMetrics, dailySeries, monthlySeries } from '../metrics/index.js';
import { registerToken, removeToken, sendTestNotification } from '../push/index.js';
import { backfillProject, reconcileProject } from '../stripe/backfill.js';
import { MRR_STATUSES, TRIAL_STATUSES } from '../stripe/normalize.js';
import { bus } from '../lib/bus.js';

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

export function registerApi(app: FastifyInstance): void {
  app.get('/api/overview', async () => overview());

  app.get('/api/projects', async () => {
    const sync = db.prepare('SELECT * FROM sync_state').all() as {
      project_id: string;
      backfill_done: number;
      last_backfill_at: number | null;
      last_event_at: number | null;
      last_error: string | null;
    }[];
    const syncById = new Map(sync.map((s) => [s.project_id, s]));

    return listProjects().map((p) => ({
      ...p,
      includedInTotals: p.include_in_totals === 1,
      // `connected` indique qu'une clé Stripe est configurée, sans jamais la divulguer.
      connected: Boolean(config.projectById.get(p.id)?.stripeKey),
      sync: syncById.get(p.id) ?? null,
    }));
  });

  app.put<{ Params: { id: string }; Body: { include_in_totals?: boolean } }>(
    '/api/projects/:id',
    async (request, reply) => {
      const exists = db.prepare('SELECT 1 FROM projects WHERE id = ?').get(request.params.id);
      if (!exists) return reply.code(404).send({ error: 'projet introuvable' });

      if (typeof request.body?.include_in_totals === 'boolean') {
        db.prepare('UPDATE projects SET include_in_totals = ? WHERE id = ?').run(
          request.body.include_in_totals ? 1 : 0,
          request.params.id,
        );
      }

      // Le consolidé change : on prévient les clients connectés au flux.
      bus.publishMetricsDirty();

      return db
        .prepare('SELECT id, name, color, include_in_totals FROM projects WHERE id = ?')
        .get(request.params.id);
    },
  );

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const metrics = projectMetrics(request.params.id);
    if (!metrics) return reply.code(404).send({ error: 'projet introuvable' });
    return metrics;
  });

  app.get<{
    Querystring: { project?: string; kind?: string; limit?: string; before?: string };
  }>('/api/events', async (request) => {
    const { project, kind, before } = request.query;
    const limit = clamp(Number(request.query.limit ?? 50), 1, 200);

    const clauses: string[] = [];
    const args: unknown[] = [];

    if (project) {
      clauses.push('project_id = ?');
      args.push(project);
    }
    if (kind) {
      // Liste blanche implicite : les valeurs sont paramétrées, jamais concaténées.
      const kinds = kind.split(',').filter(Boolean);
      clauses.push(`kind IN (${kinds.map(() => '?').join(',')})`);
      args.push(...kinds);
    }
    if (before) {
      clauses.push('id < ?');
      args.push(Number(before));
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db
      .prepare(
        `SELECT e.*, p.name AS project_name, p.color AS project_color
         FROM events e JOIN projects p ON p.id = e.project_id
         ${where} ORDER BY e.occurred_at DESC, e.id DESC LIMIT ?`,
      )
      .all(...args, limit);

    return { events: rows, nextCursor: rows.length === limit ? (rows.at(-1) as { id: number }).id : null };
  });

  app.get<{ Querystring: { days?: string; project?: string } }>(
    '/api/series/daily',
    async (request) => ({
      series: dailySeries(
        clamp(Number(request.query.days ?? 30), 7, 365),
        request.query.project,
      ),
    }),
  );

  app.get<{ Querystring: { months?: string; project?: string } }>(
    '/api/series/monthly',
    async (request) => ({
      series: monthlySeries(
        clamp(Number(request.query.months ?? 12), 3, 36),
        request.query.project,
      ),
    }),
  );

  app.get<{ Querystring: { project?: string; limit?: string } }>(
    '/api/subscribers',
    async (request) => {
      const limit = clamp(Number(request.query.limit ?? 100), 1, 500);
      const statuses = [...MRR_STATUSES, ...TRIAL_STATUSES];
      const args: unknown[] = [...statuses];
      let where = `WHERE s.status IN (${statuses.map(() => '?').join(',')})`;
      if (request.query.project) {
        where += ' AND s.project_id = ?';
        args.push(request.query.project);
      }

      return {
        subscribers: db
          .prepare(
            `SELECT s.*, p.name AS project_name, p.color AS project_color
             FROM subscriptions s JOIN projects p ON p.id = s.project_id
             ${where} ORDER BY s.mrr_base_cents DESC LIMIT ?`,
          )
          .all(...args, limit),
      };
    },
  );

  // ---- Notifications

  app.post<{ Body: { token?: string; deviceName?: string } }>(
    '/api/push/register',
    async (request, reply) => {
      const token = request.body?.token;
      if (!token) return reply.code(400).send({ error: 'token manquant' });
      try {
        registerToken(token, request.body?.deviceName);
        return { ok: true };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Body: { token?: string } }>('/api/push/unregister', async (request) => {
    if (request.body?.token) removeToken(request.body.token);
    return { ok: true };
  });

  app.post('/api/push/test', async () => ({ sent: await sendTestNotification() }));

  app.get('/api/prefs', async () =>
    db.prepare('SELECT * FROM notification_prefs').all(),
  );

  app.put<{
    Params: { projectId: string };
    Body: Partial<{
      notify_payments: boolean;
      notify_signups: boolean;
      notify_cancels: boolean;
      notify_failures: boolean;
      min_amount_cents: number;
    }>;
  }>('/api/prefs/:projectId', async (request, reply) => {
    const { projectId } = request.params;
    const exists = db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
    if (!exists) return reply.code(404).send({ error: 'projet introuvable' });

    const body = request.body ?? {};
    const bool = (v: unknown, fallback: number) =>
      typeof v === 'boolean' ? (v ? 1 : 0) : fallback;

    const current = db
      .prepare('SELECT * FROM notification_prefs WHERE project_id = ?')
      .get(projectId) as Record<string, number> | undefined;

    db.prepare(
      `INSERT INTO notification_prefs
         (project_id, notify_payments, notify_signups, notify_cancels, notify_failures, min_amount_cents)
       VALUES (@project_id, @notify_payments, @notify_signups, @notify_cancels, @notify_failures, @min_amount_cents)
       ON CONFLICT(project_id) DO UPDATE SET
         notify_payments  = excluded.notify_payments,
         notify_signups   = excluded.notify_signups,
         notify_cancels   = excluded.notify_cancels,
         notify_failures  = excluded.notify_failures,
         min_amount_cents = excluded.min_amount_cents`,
    ).run({
      project_id: projectId,
      notify_payments: bool(body.notify_payments, current?.notify_payments ?? 1),
      notify_signups: bool(body.notify_signups, current?.notify_signups ?? 1),
      notify_cancels: bool(body.notify_cancels, current?.notify_cancels ?? 1),
      notify_failures: bool(body.notify_failures, current?.notify_failures ?? 1),
      min_amount_cents: Math.max(0, Number(body.min_amount_cents ?? current?.min_amount_cents ?? 0)),
    });

    return db.prepare('SELECT * FROM notification_prefs WHERE project_id = ?').get(projectId);
  });

  // ---- Synchronisation manuelle

  app.post('/api/sync/reconcile', async () => {
    let total = 0;
    for (const project of config.projects) {
      if (project.stripeKey) total += await reconcileProject(project);
    }
    return { reconciled: total };
  });

  app.post<{ Body: { projectId?: string; force?: boolean } }>(
    '/api/sync/backfill',
    async (request) => {
      const targets = request.body?.projectId
        ? config.projects.filter((p) => p.id === request.body!.projectId)
        : config.projects;

      const results: Record<string, unknown> = {};
      for (const project of targets) {
        results[project.id] = await backfillProject(project, {
          force: request.body?.force === true,
        });
      }
      return results;
    },
  );
}
