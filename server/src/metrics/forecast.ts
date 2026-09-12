import { db } from '../db/index.js';
import { toBaseCents, monthlyNormalized } from '../lib/money.js';
import { MRR_STATUSES } from '../stripe/normalize.js';
import {
  sec,
  projectFilter,
  startOfMonth,
  addMonths,
  monthKey,
  daysInMonth,
} from './scope.js';

const MRR_LIST = MRR_STATUSES.map((s) => `'${s}'`).join(',');

/** Full months new business and one-off revenue are measured over. */
const WINDOW = 6;
/**
 * Churn is measured over a longer window. Month to month it swings between 0%
 * and 50% on a base of a dozen subscriptions: read over six months its very
 * direction flips depending on where the window starts.
 */
const CHURN_WINDOW = 12;
/**
 * How far the measured direction is allowed to carry the rate. The trend is
 * honoured — a churn that is genuinely falling should show up in the forecast —
 * but four months of extrapolation must not drive it to zero or double it.
 */
const TREND_BOUND = 0.5;
/**
 * Cancellations a project needs before its own churn rate is trusted.
 *
 * Below this, one cancellation moves the rate by more than a quarter of itself:
 * a project with a single loss reads 100%, which is noise, not a rate. The
 * consolidated rate is the better guess, and in practice projects selling
 * comparable plans land close to it.
 */
const MIN_LOSS_EVENTS = 4;
/** Below this many observed months, the history is too thin to read a rate into. */
const MIN_HISTORY = 3;
/**
 * Ceiling on the measured churn rate. A month where every paying subscription
 * happened to end would otherwise project the business to zero.
 */
const MAX_CHURN = 0.8;

/**
 * Revenue forecast to the end of the year.
 *
 * Deliberately not built on the MRR movement ledger. That ledger books a
 * subscription that never billed — a trial, a test account, an abandoned
 * checkout — at list price, and such subscriptions can easily outnumber the
 * real ones: a churn rate read from it measures noise, not churn.
 *
 * Every driver is therefore measured on what actually moved money:
 *
 *   - retention, on subscriptions that have produced at least one payment;
 *   - new business, on first payments;
 *   - one-off revenue, on payments attached to no subscription;
 *   - the existing base, on its real billing schedule rather than on MRR —
 *     a yearly subscription weighs in MRR every month but only bills once.
 */

interface Drivers {
  /** Monthly churn measured on paying subscriptions, as a rate between 0 and 1. */
  churnRate: number;
  /** Where churn is heading, in points per month. Zero when unreadable. */
  churnTrendPct: number;
  /** Months of churn history behind the rate. */
  churnMonthsObserved: number;
  /** Cancellations behind the rate. Each one is worth roughly `churnRate / this`. */
  churnLossEvents: number;
  /** True when the project has too few losses of its own and uses the consolidated rate. */
  churnBorrowed: boolean;
  /** Typical monthly cash from new customers (median, so one huge month cannot carry it). */
  newBusinessCents: number;
  /** Same, following the trend rather than the median. */
  newBusinessTrendCents: number;
  /** Typical monthly one-off cash. */
  oneOffCents: number;
  oneOffTrendCents: number;
  /** Full months actually observed. Below `MIN_HISTORY` nothing is extrapolated. */
  monthsObserved: number;
}

interface MonthCash {
  month: string;
  cashCents: number;
  mrrCents: number;
}

export interface Forecast {
  ytdCents: number;
  /** Expected year-end cash: the base with churn, plus typical new business. */
  projectedYearEndCents: number;
  /** Existing base only, decaying at the measured churn. */
  lowCents: number;
  /** New business following its trend rather than its median. */
  highCents: number;
  projectedRecurringCents: number;
  projectedOneOffCents: number;
  runRateCents: number;
  /** MRR the simulation lands on at year end. */
  projectedYearEndMrrCents: number;
  drivers: Drivers;
  months: MonthCash[];
}

/** Least-squares slope of a series, per step. */
function slope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (values[i]! - meanY);
    den += (i - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!;
}

/** Value the trend points at for the month after the window. */
function nextFromTrend(values: number[]): number {
  if (values.length < 2) return median(values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const projected = mean + slope(values) * ((values.length + 1) / 2);
  return Math.max(0, Math.round(projected));
}

/**
 * Monthly cash, split into what a forecast has to treat differently: money from
 * a customer paying for the first time, and money owing to no subscription.
 */
function monthlyCash(
  fromSec: number,
  toSec: number,
  projectId?: string,
): Map<string, { newBusiness: number; oneOff: number }> {
  const f = projectFilter(projectId);
  const rows = db
    .prepare(
      `WITH firsts AS (
         SELECT subscription_id, MIN(occurred_at) AS t
         FROM events
         WHERE kind = 'payment' AND subscription_id IS NOT NULL AND ${f.clause}
         GROUP BY subscription_id
       )
       SELECT strftime('%Y-%m', e.occurred_at, 'unixepoch', 'localtime') AS month,
              COALESCE(SUM(CASE WHEN e.subscription_id IS NULL
                                 THEN e.amount_base_cents END), 0) AS one_off,
              COALESCE(SUM(CASE WHEN e.subscription_id IS NOT NULL AND e.occurred_at = f.t
                                 THEN e.amount_base_cents END), 0) AS new_business
       FROM events e
       LEFT JOIN firsts f ON f.subscription_id = e.subscription_id
       WHERE e.kind IN ('payment','refund')
         AND e.occurred_at >= ? AND e.occurred_at < ? AND ${f.clause}
       GROUP BY month`,
    )
    .all(...f.args, fromSec, toSec, ...f.args) as {
    month: string;
    one_off: number;
    new_business: number;
  }[];

  return new Map(
    rows.map((r) => [r.month, { newBusiness: r.new_business, oneOff: r.one_off }]),
  );
}

/**
 * Monthly revenue churn, measured on subscriptions that have actually billed.
 *
 * Three things this gets right that a naive count does not:
 *
 *  - It weighs euros, not logos. Losing a 15 € plan and losing a 250 € plan are
 *    not the same event, and a forecast cares about the euros.
 *  - Its denominator is the base present at the start of the month. A
 *    subscription that signed up and cancelled inside the same month was never
 *    part of that base, and counting it as a loss against it inflates the rate
 *    badly. Those failed acquisitions are already accounted for on the other
 *    side, in the decay applied to each new cohort.
 *  - It ignores subscriptions that never produced a payment: they were never
 *    customers, so their cancellation is not churn.
 *
 * A cancelled subscription keeps its `amount_cents` — only `mrr_base_cents` is
 * zeroed when it stops billing — so the revenue it used to carry is still
 * readable, which is what makes this measurable at all.
 */
function churnHistory(projectId?: string): { lost: number; base: number; lostCount: number }[] {
  const f = projectFilter(projectId);
  const subs = db
    .prepare(
      `SELECT amount_cents, currency, interval, interval_count, started_at, canceled_at
       FROM subscriptions
       WHERE id IN (
         SELECT DISTINCT subscription_id FROM events
         WHERE kind = 'payment' AND subscription_id IS NOT NULL AND ${f.clause}
       ) AND ${f.clause}`,
    )
    .all(...f.args, ...f.args) as {
    amount_cents: number;
    currency: string;
    interval: string;
    interval_count: number;
    started_at: number | null;
    canceled_at: number | null;
  }[];

  // `amount_cents` already carries the quantity, so it must not be applied
  // twice when the amount is brought back to a month.
  const weighed = subs.map((sub) => ({
    started: sub.started_at ?? 0,
    canceled: sub.canceled_at,
    mrr: toBaseCents(
      monthlyNormalized(sub.amount_cents, sub.interval, sub.interval_count, 1),
      sub.currency,
    ),
  }));

  const out: { lost: number; base: number; lostCount: number }[] = [];
  const firstOfThisMonth = startOfMonth();

  for (let i = CHURN_WINDOW; i >= 1; i--) {
    const from = sec(addMonths(firstOfThisMonth, -i));
    const to = sec(addMonths(firstOfThisMonth, -i + 1));

    let base = 0;
    let lost = 0;
    let lostCount = 0;
    for (const sub of weighed) {
      const present = sub.started < from && (sub.canceled === null || sub.canceled >= from);
      if (present) base += sub.mrr;
      // Only the base can be lost: an arrival that leaves the same month never
      // belonged to it.
      if (present && sub.canceled !== null && sub.canceled >= from && sub.canceled < to) {
        lost += sub.mrr;
        lostCount++;
      }
    }
    out.push({ base, lost, lostCount });
  }
  return out;
}

/**
 * Reads a rate and a direction out of a churn series.
 *
 * The rate is an aggregate, not an average of the monthly rates: it weighs each
 * month by the base at risk, so a 50% month on three subscriptions cannot
 * outvote a quiet month on thirty.
 */
function readChurn(series: { lost: number; base: number; lostCount: number }[]): {
  rate: number;
  trendPct: number;
  months: number;
  events: number;
} {
  const first = series.findIndex((r) => r.base > 0);
  const used = first === -1 ? [] : series.slice(first);

  const lost = used.reduce((a, r) => a + r.lost, 0);
  const base = used.reduce((a, r) => a + r.base, 0);
  const rates = used.map((r) => (r.base > 0 ? r.lost / r.base : 0));

  return {
    rate: base > 0 ? Math.min(lost / base, MAX_CHURN) : 0,
    // Direction, in points per month. Below four months the series is too short
    // for a slope to mean anything, and none is claimed.
    trendPct: rates.length >= 4 ? Math.round(slope(rates) * 1000) / 10 : 0,
    months: used.length,
    events: used.reduce((a, r) => a + r.lostCount, 0),
  };
}

function measureDrivers(projectId?: string): Drivers {
  const firstOfThisMonth = startOfMonth();
  const windowStart = addMonths(firstOfThisMonth, -WINDOW);

  const cash = monthlyCash(sec(windowStart), sec(firstOfThisMonth), projectId);
  const keys: string[] = [];
  for (let i = WINDOW; i >= 1; i--) keys.push(monthKey(addMonths(firstOfThisMonth, -i)));

  const newSeries = keys.map((k) => cash.get(k)?.newBusiness ?? 0);
  const oneOffSeries = keys.map((k) => cash.get(k)?.oneOff ?? 0);

  // A month is "observed" once it carries any cash at all: leading zeros are a
  // business that did not exist yet, not months of failure to sell.
  const firstActive = newSeries.findIndex((v, i) => v !== 0 || oneOffSeries[i] !== 0);
  const monthsObserved = firstActive === -1 ? 0 : newSeries.length - firstActive;
  const usedNew = firstActive === -1 ? [] : newSeries.slice(firstActive);
  const usedOneOff = firstActive === -1 ? [] : oneOffSeries.slice(firstActive);

  // Churn is measured on its own, longer window, starting at the first month the
  // business actually had subscribers to lose. A project with too few losses of
  // its own borrows the consolidated rate rather than publish its noise.
  let churn = readChurn(churnHistory(projectId));
  let churnBorrowed = false;

  if (projectId && churn.months > 0 && churn.events < MIN_LOSS_EVENTS) {
    const consolidated = readChurn(churnHistory(undefined));
    if (consolidated.events >= MIN_LOSS_EVENTS) {
      churn = consolidated;
      churnBorrowed = true;
    }
  }

  return {
    churnRate: churn.rate,
    churnTrendPct: churn.trendPct,
    churnMonthsObserved: churn.months,
    churnLossEvents: churn.events,
    churnBorrowed,
    newBusinessCents: median(usedNew),
    newBusinessTrendCents: Math.max(median(usedNew), nextFromTrend(usedNew)),
    oneOffCents: median(usedOneOff),
    oneOffTrendCents: Math.max(median(usedOneOff), nextFromTrend(usedOneOff)),
    monthsObserved,
  };
}

/**
 * Churn rate for each month ahead, carrying the measured direction forward.
 *
 * The direction is honoured — that is the point — but bounded: extrapolating a
 * slope read on a dozen noisy months would otherwise reach zero, or double,
 * within the year.
 */
function churnSchedule(rate: number, trendPct: number, months: number): number[] {
  const perMonth = trendPct / 100;
  const floor = rate * (1 - TREND_BOUND);
  const ceiling = rate * (1 + TREND_BOUND);

  return Array.from({ length: months }, (_, i) => {
    const projected = rate + perMonth * i;
    return Math.max(0, Math.min(MAX_CHURN, Math.min(ceiling, Math.max(floor, projected))));
  });
}

/** Probability of still being there after i months, index by index. */
function cumulativeSurvival(rates: number[]): number[] {
  const cum = [1];
  for (let i = 0; i < rates.length; i++) cum.push(cum[i]! * (1 - rates[i]!));
  return cum;
}

/** One step of a subscription's billing cycle. */
function addInterval(d: Date, interval: string, count: number): Date {
  const next = new Date(d);
  const n = Math.max(count, 1);
  switch (interval) {
    case 'day':
      next.setDate(next.getDate() + n);
      break;
    case 'week':
      next.setDate(next.getDate() + 7 * n);
      break;
    case 'year':
      next.setFullYear(next.getFullYear() + n);
      break;
    default:
      next.setMonth(next.getMonth() + n);
  }
  return next;
}

/**
 * Cash the subscriptions already in place are scheduled to bill, month by
 * month, before any churn is applied.
 *
 * This is what MRR cannot tell you: a yearly subscription weighs a twelfth of
 * its price in MRR every month, but bills the whole of it on one date — and
 * possibly not before the year is out.
 */
function scheduledRenewals(buckets: number, survival: number[], projectId?: string): number[] {
  const f = projectFilter(projectId);
  const subs = db
    .prepare(
      `SELECT amount_cents, currency, interval, interval_count, current_period_end
       FROM subscriptions
       WHERE status IN (${MRR_LIST}) AND mrr_base_cents > 0 AND ${f.clause}`,
    )
    .all(...f.args) as {
    amount_cents: number;
    currency: string;
    interval: string;
    interval_count: number;
    current_period_end: number | null;
  }[];

  const now = new Date();
  const thisMonth = startOfMonth(now);
  const out = new Array<number>(buckets).fill(0);

  for (const sub of subs) {
    const amount = toBaseCents(sub.amount_cents, sub.currency);
    if (amount <= 0) continue;

    let due = sub.current_period_end
      ? new Date(sub.current_period_end * 1000)
      : addInterval(now, sub.interval, sub.interval_count);

    // A past_due subscription can carry an overdue date: its next attempt is
    // now, not last month.
    if (due < now) due = new Date(now);

    // Decay applied per billing cycle, not per month. The rate was measured as
    // cancellations per paying subscriber per month over a base that is almost
    // all monthly plans, so for them a month is a cycle. Counting it per month
    // for a yearly plan instead would treat a renewal three months out as four
    // fifths lost, which is not what an annual subscriber does.
    for (let cycle = 1; cycle <= 400; cycle++) {
      const index =
        (due.getFullYear() - thisMonth.getFullYear()) * 12 +
        (due.getMonth() - thisMonth.getMonth());
      if (index >= buckets) break;
      if (index >= 0) {
        const weight = survival[Math.min(cycle - 1, survival.length - 1)] ?? 0;
        out[index] = (out[index] ?? 0) + Math.round(amount * weight);
      }
      due = addInterval(due, sub.interval, sub.interval_count);
    }
  }
  return out;
}

function currentMrr(projectId?: string): number {
  const f = projectFilter(projectId);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(mrr_base_cents), 0) AS total FROM subscriptions
       WHERE status IN (${MRR_LIST}) AND ${f.clause}`,
    )
    .get(...f.args) as { total: number };
  return row.total;
}

/**
 * Runs the simulation month by month to the end of the year.
 *
 * The existing base bills on its own schedule and decays at the churn rate.
 * Each month of new business forms a cohort that bills again the following
 * months, decaying likewise — which is what separates the three scenarios: the
 * base is the same, the acquisition is not.
 */
function simulate(
  buckets: number,
  renewals: number[],
  newPerMonth: number,
  oneOffPerMonth: number,
  rates: number[],
  survival: number[],
  firstMonthShare: number,
  startMrr: number,
): { months: MonthCash[]; total: number; recurring: number; oneOff: number; endMrr: number } {
  const months: MonthCash[] = [];
  const thisMonth = startOfMonth();

  let total = 0;
  let recurring = 0;
  let oneOffTotal = 0;
  let mrr = startMrr;
  const cohorts: number[] = [];

  for (let i = 0; i < buckets; i++) {
    // The current month only has the days it has left.
    const share = i === 0 ? firstMonthShare : 1;
    const fresh = Math.round(newPerMonth * share);
    const oneOff = Math.round(oneOffPerMonth * share);
    cohorts.push(fresh);

    // The existing base arrives already thinned: `scheduledRenewals` decays it
    // per billing cycle, which is not the same thing as per month.
    let cash = renewals[i] ?? 0;
    // Every cohort acquired so far bills again, itself thinned by the churn of
    // the months it has lived through.
    for (let j = 0; j <= i; j++) {
      const lived = (survival[i] ?? 0) / (survival[j] || 1);
      cash += Math.round((cohorts[j] ?? 0) * lived);
    }

    recurring += cash;
    oneOffTotal += oneOff;
    total += cash + oneOff;

    mrr = Math.round(mrr * (1 - (rates[i] ?? 0))) + fresh;
    months.push({ month: monthKey(addMonths(thisMonth, i)), cashCents: cash + oneOff, mrrCents: mrr });
  }

  return { months, total, recurring, oneOff: oneOffTotal, endMrr: mrr };
}

export function forecast(ytdCents: number, projectId?: string): Forecast {
  const now = new Date();
  const mrr = currentMrr(projectId);
  const drivers = measureDrivers(projectId);

  const buckets = 12 - now.getMonth();
  const firstMonthShare = (daysInMonth(now) - now.getDate()) / daysInMonth(now);

  // Too little history to read a rate into: the base is projected as it stands,
  // with no churn invented and no acquisition promised.
  const thin = drivers.monthsObserved < MIN_HISTORY;
  const rates = thin
    ? new Array<number>(buckets + 1).fill(0)
    : churnSchedule(drivers.churnRate, drivers.churnTrendPct, buckets + 1);
  const survival = cumulativeSurvival(rates);
  const renewals = scheduledRenewals(buckets, survival, projectId);

  const run = (newPerMonth: number, oneOffPerMonth: number) =>
    simulate(buckets, renewals, newPerMonth, oneOffPerMonth, rates, survival, firstMonthShare, mrr);

  const low = run(0, 0);
  const expected = thin
    ? low
    : run(drivers.newBusinessCents, drivers.oneOffCents);
  const high = thin
    ? low
    : run(drivers.newBusinessTrendCents, drivers.oneOffTrendCents);

  return {
    ytdCents,
    projectedYearEndCents: ytdCents + expected.total,
    lowCents: ytdCents + low.total,
    highCents: ytdCents + high.total,
    projectedRecurringCents: expected.recurring,
    projectedOneOffCents: expected.oneOff,
    runRateCents: mrr * 12,
    projectedYearEndMrrCents: expected.endMrr,
    drivers,
    months: expected.months,
  };
}
