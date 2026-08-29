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

export interface Projection {
  ytdCents: number;
  projectedYearEndCents: number;
  projectedRecurringCents: number;
  projectedOneOffCents: number;
  runRateCents: number;
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
  activeSubscribers: number;
  trials: number;
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
