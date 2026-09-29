import { db } from '../db/index.js';
import { config } from '../config.js';
import { MRR_STATUSES, AT_RISK_STATUSES, TRIAL_STATUSES } from '../stripe/normalize.js';
import { hasLogo } from '../stripe/branding.js';
import { globalGoal, goalProgress, type GoalKind } from '../lib/settings.js';
import { monthlyNormalized, toBaseCents } from '../lib/money.js';
import { forecast, type Forecast } from './forecast.js';
import {
  sec,
  projectFilter,
  startOfDay,
  startOfMonth,
  startOfYear,
  addMonths,
} from './scope.js';

const MRR_LIST = MRR_STATUSES.map((s) => `'${s}'`).join(',');
const AT_RISK_LIST = AT_RISK_STATUSES.map((s) => `'${s}'`).join(',');
const TRIAL_LIST = TRIAL_STATUSES.map((s) => `'${s}'`).join(',');

/** Cash collected: payments and refunds, the latter as negative amounts. */
const CASH_KINDS = `('payment','refund')`;

/** Cash collected over a window, optionally narrowed to one project. */
function cashBetween(fromSec: number, toSec: number, projectId?: string, scope?: string[] | null): number {
  const f = projectFilter(projectId, scope);
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

function currentMrr(projectId?: string, scope?: string[] | null): number {
  const f = projectFilter(projectId, scope);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(mrr_base_cents), 0) AS total
       FROM subscriptions
       WHERE status IN (${MRR_LIST}) AND ${f.clause}`,
    )
    .get(...f.args) as { total: number };
  return row.total;
}

/**
 * Subscriber counts.
 *
 * A billing subscription weighing zero — comped, a 100% coupon, a free plan —
 * is not a customer for the purposes of this count. Counting it inflates the
 * headline while adding nothing to MRR, so it is tallied apart.
 */
function counts(projectId?: string, scope?: string[] | null) {
  const f = projectFilter(projectId, scope);
  const active = db
    .prepare(
      `SELECT COUNT(*) AS n FROM subscriptions
       WHERE status IN (${MRR_LIST}) AND mrr_base_cents > 0 AND ${f.clause}`,
    )
    .get(...f.args) as { n: number };
  const comped = db
    .prepare(
      `SELECT COUNT(*) AS n FROM subscriptions
       WHERE status IN (${MRR_LIST}) AND mrr_base_cents = 0 AND ${f.clause}`,
    )
    .get(...f.args) as { n: number };
  const trials = db
    .prepare(
      `SELECT COUNT(*) AS n FROM subscriptions WHERE status IN (${TRIAL_LIST}) AND ${f.clause}`,
    )
    .get(...f.args) as { n: number };

  // Also counted inside `active`: a subscription on a first-invoice or
  // time-limited coupon pays less than its recurring rate for now, which the
  // headline MRR deliberately does not show — so it is named here instead.
  const promo = db
    .prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(mrr_base_cents - mrr_current_base_cents), 0) AS cents
       FROM subscriptions
       WHERE status IN (${MRR_LIST}) AND mrr_base_cents > mrr_current_base_cents
         AND ${f.clause}`,
    )
    .get(...f.args) as { n: number; cents: number };

  // Counted inside `active`, not alongside it: these subscriptions are billing
  // and weigh in MRR, they are simply failing to collect right now.
  const atRisk = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(mrr_base_cents), 0) AS cents
       FROM subscriptions
       WHERE status IN (${AT_RISK_LIST}) AND mrr_base_cents > 0 AND ${f.clause}`,
    )
    .get(...f.args) as { n: number; cents: number };

  return {
    activeSubscribers: active.n,
    compedSubscribers: comped.n,
    trials: trials.n,
    atRiskSubscribers: atRisk.n,
    atRiskMrrCents: atRisk.cents,
    promoSubscribers: promo.n,
    promoMrrCents: promo.cents,
  };
}

/**
 * Breaks down this month's MRR movement.
 * The four components explain the gap between MRR on the 1st and MRR today:
 * new business, expansion, contraction, churn.
 */
function mrrMovement(fromSec: number, toSec: number, projectId?: string, scope?: string[] | null) {
  const f = projectFilter(projectId, scope);
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

/** Daily cash series, for the app's chart. */
export function dailySeries(days: number, projectId?: string, scope?: string[] | null) {
  const from = sec(new Date(startOfDay().getTime() - (days - 1) * 86_400_000));
  const f = projectFilter(projectId, scope);
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

/** Statuses that never billed: they weigh nothing, today or in the past. */
const NEVER_BILLED = new Set(['incomplete', 'incomplete_expired', 'trialing']);

interface Cohort {
  startedAt: number;
  /** When it stopped billing; `null` while it still does. */
  endedAt: number | null;
  mrrCents: number;
}

/**
 * Subscriptions as cohorts, so MRR can be read at a past date.
 *
 * The event ledger cannot answer this question. Its deltas only say what
 * changed, and the hourly reconciliation corrects a stored price without
 * emitting anything, so summing the deltas backwards drifts a little further
 * with every correction. Walking the subscriptions themselves is anchored: the
 * same function evaluated at today returns today's MRR to the cent.
 *
 * Two readings of the amount, because a cancelled subscription is zeroed:
 * `mrr_base_cents` while it holds a figure (discounts already applied), and the
 * price it was signed at once it no longer does.
 */
function mrrCohorts(projectId?: string, scope?: string[] | null): Cohort[] {
  const f = projectFilter(projectId, scope);
  const rows = db
    .prepare(
      `SELECT status, mrr_base_cents, amount_cents, currency, interval, interval_count,
              started_at, canceled_at, updated_at
       FROM subscriptions WHERE ${f.clause}`,
    )
    .all(...f.args) as {
    status: string;
    mrr_base_cents: number;
    amount_cents: number;
    currency: string;
    interval: string;
    interval_count: number;
    started_at: number | null;
    canceled_at: number | null;
    updated_at: number;
  }[];

  const cohorts: Cohort[] = [];
  for (const row of rows) {
    if (row.started_at === null || NEVER_BILLED.has(row.status)) continue;

    const mrrCents =
      row.mrr_base_cents > 0
        ? row.mrr_base_cents
        : toBaseCents(
            // The stored amount already carries the quantity: applying it again
            // here would double a seat-based subscription.
            monthlyNormalized(row.amount_cents, row.interval, row.interval_count, 1),
            row.currency,
          );
    if (mrrCents <= 0) continue;

    // A subscription set to stop at period end is billing today and carries a
    // `canceled_at` in the past: still billing wins over the request date.
    // Anything else that stopped without a date is closed at the moment we last
    // saw it change, rather than left running forever.
    const endedAt = MRR_STATUSES.includes(row.status)
      ? null
      : (row.canceled_at ?? row.updated_at);

    cohorts.push({ startedAt: row.started_at, endedAt, mrrCents });
  }
  return cohorts;
}

function mrrAt(cohorts: readonly Cohort[], atSec: number): number {
  let total = 0;
  for (const c of cohorts) {
    if (c.startedAt <= atSec && (c.endedAt === null || c.endedAt > atSec)) total += c.mrrCents;
  }
  return total;
}

/** Rolling monthly series over N months, with each month's net MRR. */
export function monthlySeries(months: number, projectId?: string, scope?: string[] | null) {
  const series: { month: string; cents: number; netMrrCents: number; mrrCents: number }[] = [];
  const now = new Date();
  const cohorts = mrrCohorts(projectId, scope);

  for (let i = months - 1; i >= 0; i--) {
    const start = startOfMonth(addMonths(now, -i));
    const end = addMonths(start, 1);
    const label = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
    series.push({
      month: label,
      cents: cashBetween(sec(start), sec(end), projectId, scope),
      netMrrCents: mrrMovement(sec(start), sec(end), projectId, scope).netCents,
      // MRR as it stood when the month closed. The month under way is read at
      // today, so the last bar matches the figure at the top of the screen.
      mrrCents: mrrAt(cohorts, Math.min(sec(end), sec(now))),
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
  /** MRR as it stood when the previous month closed. */
  prevMonthMrrCents: number;
  /** Growth of the recurring base against that figure. `null` when it was zero. */
  mrrVsPrevMonthPct: number | null;
  /** Subscribers actually paying: a billing subscription worth more than zero. */
  activeSubscribers: number;
  /** Billing but worth zero: comped, 100% coupon, free plan. */
  compedSubscribers: number;
  trials: number;
  /** Subscribers billing but whose payment is failing (`past_due`). */
  atRiskSubscribers: number;
  /** Share of `mrrCents` carried by those subscribers. */
  atRiskMrrCents: number;
  /** Subscribers paying less than their recurring rate, on a temporary coupon. */
  promoSubscribers: number;
  /** How much of `mrrCents` they are not paying yet. */
  promoMrrCents: number;
  movement: ReturnType<typeof mrrMovement>;
  projection: Forecast;
  lastEventAt: number | null;
}

function buildMetrics(
  projectId: string | undefined,
  name: string,
  color: string,
  scope?: string[] | null,
): ProjectMetrics {
  const now = new Date();
  const monthStart = startOfMonth(now);
  const prevStart = addMonths(monthStart, -1);

  const mtd = cashBetween(sec(monthStart), sec(now), projectId, scope);
  const ytd = cashBetween(sec(startOfYear(now)), sec(now), projectId, scope);

  // Like-for-like comparison: the same number of days elapsed last month.
  const prevSameSpan = cashBetween(
    sec(prevStart),
    sec(new Date(prevStart.getTime() + (now.getTime() - monthStart.getTime()))),
    projectId,
    scope,
  );

  const mrr = currentMrr(projectId, scope);
  // Same cohorts as the monthly chart, read at the first instant of this month:
  // the recurring base as the previous month left it. The cash comparison below
  // answers a different question and must not stand in for this one.
  const prevMonthMrr = mrrAt(mrrCohorts(projectId, scope), sec(monthStart));
  const {
    activeSubscribers,
    compedSubscribers,
    trials,
    atRiskSubscribers,
    atRiskMrrCents,
    promoSubscribers,
    promoMrrCents,
  } = counts(projectId, scope);

  const fLast = projectFilter(projectId, scope);
  const lastEvent = db
    .prepare(`SELECT MAX(occurred_at) AS last FROM events WHERE ${fLast.clause}`)
    .get(...fLast.args) as { last: number | null };

  return {
    projectId: projectId ?? null,
    name,
    color,
    currency: config.baseCurrency,
    mrrCents: mrr,
    prevMonthMrrCents: prevMonthMrr,
    mrrVsPrevMonthPct:
      prevMonthMrr > 0 ? ((mrr - prevMonthMrr) / prevMonthMrr) * 100 : null,
    arrCents: mrr * 12,
    todayCents: cashBetween(sec(startOfDay(now)), sec(now), projectId, scope),
    mtdCents: mtd,
    ytdCents: ytd,
    last30Cents: cashBetween(sec(new Date(now.getTime() - 30 * 86_400_000)), sec(now), projectId, scope),
    prevMonthCents: cashBetween(sec(prevStart), sec(monthStart), projectId, scope),
    mtdVsPrevPct:
      prevSameSpan > 0 ? Math.round(((mtd - prevSameSpan) / prevSameSpan) * 1000) / 10 : null,
    activeSubscribers,
    compedSubscribers,
    trials,
    atRiskSubscribers,
    atRiskMrrCents,
    promoSubscribers,
    promoMrrCents,
    movement: mrrMovement(sec(monthStart), sec(now), projectId, scope),
    projection: forecast(ytd, projectId, scope),
    lastEventAt: lastEvent.last,
  };
}

/** Consolidated view: all-project total plus per-project detail. */
export function overview(scope?: string[] | null) {
  const rows = db
    .prepare(
      `SELECT id, name, color, include_in_totals, visible, goal_cents, goal_kind
       FROM projects ORDER BY name COLLATE NOCASE`,
    )
    .all() as {
    id: string;
    name: string;
    color: string;
    include_in_totals: number;
    visible: number;
    goal_cents: number | null;
    goal_kind: string;
  }[];

  // A restricted token never learns that the other projects exist.
  const projects = scope ? rows.filter((p) => scope.includes(p.id)) : rows;

  const total = buildMetrics(undefined, 'Tous les projets', '#6366f1', scope);

  return {
    generatedAt: Math.floor(Date.now() / 1000),
    currency: config.baseCurrency,
    total: { ...total, goal: goalProgress(globalGoal(), total.mrrCents) },
    projects: projects.map((p) => {
      const metrics = buildMetrics(p.id, p.name, p.color, scope);
      const goal =
        p.goal_cents && p.goal_cents > 0
          ? { cents: p.goal_cents, kind: (p.goal_kind === 'arr' ? 'arr' : 'mrr') as GoalKind }
          : null;
      return {
        ...metrics,
        includedInTotals: p.include_in_totals === 1,
        // A hidden project still travels: it weighs on the total, its events
        // keep their logo in the feed, and only the dashboard list skips it.
        visible: p.visible === 1,
        hasLogo: hasLogo(p.id),
        goal: goalProgress(goal, metrics.mrrCents),
      };
    }),
  };
}

export function projectMetrics(
  projectId: string,
  scope?: string[] | null,
): ProjectMetrics | null {
  if (scope && !scope.includes(projectId)) return null;
  const project = db
    .prepare('SELECT id, name, color FROM projects WHERE id = ?')
    .get(projectId) as { id: string; name: string; color: string } | undefined;
  if (!project) return null;
  return buildMetrics(project.id, project.name, project.color, scope);
}
