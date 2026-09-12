export type EventKind =
  | 'payment'
  | 'refund'
  | 'payment_failed'
  | 'subscription_created'
  | 'subscription_updated'
  | 'subscription_canceled'
  | 'trial_started';

export interface RevenueEvent {
  id: number;
  project_id: string;
  project_name: string;
  project_color: string;
  kind: EventKind;
  amount_cents: number;
  currency: string;
  amount_base_cents: number;
  mrr_delta_cents: number;
  customer_email: string | null;
  customer_name: string | null;
  subscription_id: string | null;
  description: string | null;
  occurred_at: number;
}

export interface MrrMovement {
  newMrrCents: number;
  expansionCents: number;
  contractionCents: number;
  churnedCents: number;
  netCents: number;
}

/** What the forecast measured, so the interface can show its own assumptions. */
export interface ForecastDrivers {
  /** Monthly churn on paying subscriptions, between 0 and 1. */
  churnRate: number;
  /** Where churn is heading, in points per month. Zero when unreadable. */
  churnTrendPct: number;
  /** Months of churn history behind the rate. */
  churnMonthsObserved: number;
  /** Cancellations behind the rate. Each one is worth roughly `churnRate / this`. */
  churnLossEvents: number;
  /** True when the project has too few losses of its own and uses the consolidated rate. */
  churnBorrowed: boolean;
  newBusinessCents: number;
  newBusinessTrendCents: number;
  oneOffCents: number;
  oneOffTrendCents: number;
  /** Full months observed. Below 3, nothing is extrapolated. */
  monthsObserved: number;
}

/**
 * Everything added after a given server version is optional here.
 *
 * The server is self-hosted and updated by hand, so an app newer than the
 * server it talks to is a normal state, not an accident. Declaring these
 * required once cost a release: the app dereferenced `drivers` on a server that
 * did not send it yet and crashed on the first render. Optional is the truth,
 * and it makes the compiler point at every place that has to cope.
 */
export interface Projection {
  ytdCents: number;
  /** Expected: the base decaying at the measured churn, plus a typical month of sales. */
  projectedYearEndCents: number;
  projectedRecurringCents: number;
  projectedOneOffCents: number;
  runRateCents: number;
  /** Existing base only, no new customer at all. Absent before the forecast engine. */
  lowCents?: number;
  /** New business following its trend rather than its median. */
  highCents?: number;
  projectedYearEndMrrCents?: number;
  drivers?: ForecastDrivers;
  months?: { month: string; cashCents: number; mrrCents: number }[];
}

export interface GoalProgress {
  kind: 'mrr' | 'arr';
  targetCents: number;
  currentCents: number;
  /** May exceed 100: the bar is capped, the value is not. */
  percent: number;
  remainingCents: number;
}

export interface Metrics {
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
  /** Subscribers actually paying: a billing subscription worth more than zero. */
  activeSubscribers: number;
  trials: number;
  /** Billing but worth zero: comped, 100% coupon, free plan. Absent on older servers. */
  compedSubscribers?: number;
  /** Subscribers billing but whose payment is failing (`past_due`). */
  atRiskSubscribers?: number;
  /** Share of `mrrCents` carried by those subscribers. */
  atRiskMrrCents?: number;
  movement: MrrMovement;
  projection: Projection;
  lastEventAt: number | null;
  /** Present only in the overview's `projects` list. */
  includedInTotals?: boolean;
  hasLogo?: boolean;
  goal?: GoalProgress | null;
}

export interface Overview {
  generatedAt: number;
  currency: string;
  total: Metrics;
  projects: Metrics[];
}

export interface DailyPoint {
  day: string;
  cents: number;
}

export interface MonthlyPoint {
  month: string;
  cents: number;
  netMrrCents: number;
}

export interface Subscriber {
  id: string;
  project_id: string;
  project_name: string;
  project_color: string;
  customer_name: string | null;
  customer_email: string | null;
  status: string;
  mrr_base_cents: number;
  interval: string;
  product_name: string | null;
  started_at: number | null;
}

export interface NotificationPrefs {
  project_id: string;
  notify_payments: number;
  notify_signups: number;
  notify_cancels: number;
  notify_failures: number;
  min_amount_cents: number;
}

export interface ProjectInfo {
  id: string;
  name: string;
  color: string;
  connected: boolean;
  /** Does this project count towards consolidated MRR and revenue? */
  includedInTotals: boolean;
  /** Has a brand logo been fetched from Stripe? */
  hasLogo: boolean;
  /** Objectif de revenu en centimes, `null` si aucun. */
  goal_cents: number | null;
  /** Nature de l'objectif : `mrr` ou `arr`. */
  goal_kind: string;
  sync: {
    backfill_done: number;
    last_backfill_at: number | null;
    last_event_at: number | null;
    last_error: string | null;
  } | null;
}
