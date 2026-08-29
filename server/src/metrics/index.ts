import { db } from '../db/index.js';
import { config } from '../config.js';
import { MRR_STATUSES, TRIAL_STATUSES } from '../stripe/normalize.js';
import { hasLogo } from '../stripe/branding.js';
import { globalGoal, goalProgress, type GoalKind } from '../lib/settings.js';

const MRR_LIST = MRR_STATUSES.map((s) => `'${s}'`).join(',');
const TRIAL_LIST = TRIAL_STATUSES.map((s) => `'${s}'`).join(',');

/** Cash collected: payments and refunds, the latter as negative amounts. */
const CASH_KINDS = `('payment','refund')`;

const sec = (d: Date) => Math.floor(d.getTime() / 1000);

/**
 * Builds the project filter for a query.
 *
 * With no id, the whole table is not summed: the scope narrows to projects
 * flagged `include_in_totals`. An excluded project stays viewable on its own, it
 * simply no longer weighs on the consolidated figures.
 */
function projectFilter(projectId?: string): { clause: string; args: string[] } {
  if (projectId) return { clause: 'project_id = ?', args: [projectId] };

  const rows = db
    .prepare('SELECT id FROM projects WHERE include_in_totals = 1')
    .all() as { id: string }[];

  if (rows.length === 0) return { clause: '1 = 0', args: [] };
  return {
    clause: `project_id IN (${rows.map(() => '?').join(',')})`,
    args: rows.map((r) => r.id),
  };
}

function startOfDay(ref = new Date()): Date {
  const d = new Date(ref);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonth(ref = new Date()): Date {
  const d = startOfDay(ref);
  d.setDate(1);
  return d;
}

function startOfYear(ref = new Date()): Date {
  const d = startOfMonth(ref);
  d.setMonth(0);
  return d;
}

function addMonths(ref: Date, n: number): Date {
  const d = new Date(ref);
  d.setMonth(d.getMonth() + n);
  return d;
}

/** Cash collected over a window, optionally narrowed to one project. */
function cashBetween(fromSec: number, toSec: number, projectId?: string): number {
  const f = projectFilter(projectId);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_base_cents), 0) AS total
       FROM events
       WHERE kind IN ${CASH_KINDS}
         AND occurred_at >= ? AND occurred_at < ? AND ${f.clause}`,
    )
    .get(fromSec, toSec, ...f.args) as { total: number };
  return row.total;
}

function currentMrr(projectId?: string): number {
  const f = projectFilter(projectId);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(mrr_base_cents), 0) AS total
       FROM subscriptions
       WHERE status IN (${MRR_LIST}) AND ${f.clause}`,
    )
    .get(...f.args) as { total: number };
  return row.total;
}

function counts(projectId?: string) {
  const f = projectFilter(projectId);
  const active = db
    .prepare(
      `SELECT COUNT(*) AS n FROM subscriptions WHERE status IN (${MRR_LIST}) AND ${f.clause}`,
    )
    .get(...f.args) as { n: number };
  const trials = db
    .prepare(
      `SELECT COUNT(*) AS n FROM subscriptions WHERE status IN (${TRIAL_LIST}) AND ${f.clause}`,
    )
    .get(...f.args) as { n: number };

  return { activeSubscribers: active.n, trials: trials.n };
}

/**
 * Breaks down this month's MRR movement.
 * The four components explain the gap between MRR on the 1st and MRR today:
 * new business, expansion, contraction, churn.
 */
function mrrMovement(fromSec: number, toSec: number, projectId?: string) {
  const f = projectFilter(projectId);
  const args = [fromSec, toSec, ...f.args];

  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN kind IN ('subscription_created','trial_started')
                            THEN mrr_delta_cents END), 0) AS new_mrr,
         COALESCE(SUM(CASE WHEN kind = 'subscription_updated' AND mrr_delta_cents > 0
                            THEN mrr_delta_cents END), 0) AS expansion,
         COALESCE(SUM(CASE WHEN kind = 'subscription_updated' AND mrr_delta_cents < 0
                            THEN mrr_delta_cents END), 0) AS contraction,
         COALESCE(SUM(CASE WHEN kind = 'subscription_canceled'
                            THEN mrr_delta_cents END), 0) AS churned
       FROM events
       WHERE occurred_at >= ? AND occurred_at < ? AND ${f.clause}`,
    )
    .get(...args) as {
    new_mrr: number;
    expansion: number;
    contraction: number;
    churned: number;
  };

  return {
    newMrrCents: row.new_mrr,
    expansionCents: row.expansion,
    contractionCents: row.contraction,
    churnedCents: row.churned,
    netCents: row.new_mrr + row.expansion + row.contraction + row.churned,
  };
}

/**
 * Year-end projection.
 *
 * Two components: recurring revenue, extrapolated from current MRR across the
 * remaining months, and one-off revenue, extrapolated from the daily average
 * observed over 90 days. The current month counts only pro rata for the days
 * left, so what is already collected is not counted twice.
 */
function yearProjection(projectId?: string) {
  const now = new Date();
  const ytd = cashBetween(sec(startOfYear(now)), sec(now), projectId);
  const mrr = currentMrr(projectId);

  const endOfYear = new Date(now.getFullYear() + 1, 0, 1);
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const remainingInMonth = daysInMonth - now.getDate();
  const fullMonthsLeft = 11 - now.getMonth();

  const recurringLeft =
    mrr * fullMonthsLeft + Math.round((mrr * remainingInMonth) / daysInMonth);

  // One-off: 90-day average of payments not attached to a subscription.
  const ninetyDaysAgo = sec(new Date(now.getTime() - 90 * 86_400_000));
  const fOneOff = projectFilter(projectId);
  const oneOffRow = db
    .prepare(
      `SELECT COALESCE(SUM(amount_base_cents), 0) AS total
       FROM events
       WHERE kind IN ${CASH_KINDS} AND subscription_id IS NULL
         AND occurred_at >= ? AND ${fOneOff.clause}`,
    )
    .get(ninetyDaysAgo, ...fOneOff.args) as { total: number };

  const daysLeft = Math.max(0, Math.round((endOfYear.getTime() - now.getTime()) / 86_400_000));
  const oneOffLeft = Math.round((oneOffRow.total / 90) * daysLeft);

  return {
    ytdCents: ytd,
    projectedYearEndCents: ytd + recurringLeft + oneOffLeft,
    projectedRecurringCents: recurringLeft,
    projectedOneOffCents: oneOffLeft,
    runRateCents: mrr * 12,
  };
}

/** Daily cash series, for the app's chart. */
export function dailySeries(days: number, projectId?: string) {
  const from = sec(new Date(startOfDay().getTime() - (days - 1) * 86_400_000));
  const f = projectFilter(projectId);
  const rows = db
    .prepare(
      `SELECT date(occurred_at, 'unixepoch', 'localtime') AS day,
              COALESCE(SUM(amount_base_cents), 0) AS total
       FROM events
       WHERE kind IN ${CASH_KINDS} AND occurred_at >= ? AND ${f.clause}
       GROUP BY day ORDER BY day`,
    )
    .all(from, ...f.args) as { day: string; total: number }[];

  const byDay = new Map(rows.map((r) => [r.day, r.total]));
  const series: { day: string; cents: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(startOfDay().getTime() - i * 86_400_000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    series.push({ day: key, cents: byDay.get(key) ?? 0 });
  }
  return series;
}

/** Rolling monthly series over N months, with each month's net MRR. */
export function monthlySeries(months: number, projectId?: string) {
  const series: { month: string; cents: number; netMrrCents: number }[] = [];
  const now = new Date();

  for (let i = months - 1; i >= 0; i--) {
    const start = startOfMonth(addMonths(now, -i));
    const end = addMonths(start, 1);
    const label = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
    series.push({
      month: label,
      cents: cashBetween(sec(start), sec(end), projectId),
      netMrrCents: mrrMovement(sec(start), sec(end), projectId).netCents,
    });
  }
  return series;
}

export interface ProjectMetrics {
  projectId: string | null;
  name: string;
  color: string;
  currency: string;
  mrrCents: number;
  arrCents: number;
  todayCents: number;
  mtdCents: number;
  ytdCents: number;
  last30Cents: number;
  prevMonthCents: number;
  mtdVsPrevPct: number | null;
  activeSubscribers: number;
  trials: number;
  movement: ReturnType<typeof mrrMovement>;
  projection: ReturnType<typeof yearProjection>;
  lastEventAt: number | null;
}

function buildMetrics(
  projectId: string | undefined,
  name: string,
  color: string,
): ProjectMetrics {
  const now = new Date();
  const monthStart = startOfMonth(now);
  const prevStart = addMonths(monthStart, -1);

  const mtd = cashBetween(sec(monthStart), sec(now), projectId);

  // Like-for-like comparison: the same number of days elapsed last month.
  const prevSameSpan = cashBetween(
    sec(prevStart),
    sec(new Date(prevStart.getTime() + (now.getTime() - monthStart.getTime()))),
    projectId,
  );

  const mrr = currentMrr(projectId);
  const { activeSubscribers, trials } = counts(projectId);

  const fLast = projectFilter(projectId);
  const lastEvent = db
    .prepare(`SELECT MAX(occurred_at) AS last FROM events WHERE ${fLast.clause}`)
    .get(...fLast.args) as { last: number | null };

  return {
    projectId: projectId ?? null,
    name,
    color,
    currency: config.baseCurrency,
    mrrCents: mrr,
    arrCents: mrr * 12,
    todayCents: cashBetween(sec(startOfDay(now)), sec(now), projectId),
    mtdCents: mtd,
    ytdCents: cashBetween(sec(startOfYear(now)), sec(now), projectId),
    last30Cents: cashBetween(sec(new Date(now.getTime() - 30 * 86_400_000)), sec(now), projectId),
    prevMonthCents: cashBetween(sec(prevStart), sec(monthStart), projectId),
    mtdVsPrevPct:
      prevSameSpan > 0 ? Math.round(((mtd - prevSameSpan) / prevSameSpan) * 1000) / 10 : null,
    activeSubscribers,
    trials,
    movement: mrrMovement(sec(monthStart), sec(now), projectId),
    projection: yearProjection(projectId),
    lastEventAt: lastEvent.last,
  };
}

/** Consolidated view: all-project total plus per-project detail. */
export function overview() {
  const projects = db
    .prepare(
      `SELECT id, name, color, include_in_totals, goal_cents, goal_kind
       FROM projects ORDER BY name COLLATE NOCASE`,
    )
    .all() as {
    id: string;
    name: string;
    color: string;
    include_in_totals: number;
    goal_cents: number | null;
    goal_kind: string;
  }[];

  const total = buildMetrics(undefined, 'Tous les projets', '#6366f1');

  return {
    generatedAt: Math.floor(Date.now() / 1000),
    currency: config.baseCurrency,
    total: { ...total, goal: goalProgress(globalGoal(), total.mrrCents) },
    projects: projects.map((p) => {
      const metrics = buildMetrics(p.id, p.name, p.color);
      const goal =
        p.goal_cents && p.goal_cents > 0
          ? { cents: p.goal_cents, kind: (p.goal_kind === 'arr' ? 'arr' : 'mrr') as GoalKind }
          : null;
      return {
        ...metrics,
        includedInTotals: p.include_in_totals === 1,
        hasLogo: hasLogo(p.id),
        goal: goalProgress(goal, metrics.mrrCents),
      };
    }),
  };
}

export function projectMetrics(projectId: string): ProjectMetrics | null {
  const project = db
    .prepare('SELECT id, name, color FROM projects WHERE id = ?')
    .get(projectId) as { id: string; name: string; color: string } | undefined;
  if (!project) return null;
  return buildMetrics(project.id, project.name, project.color);
}
