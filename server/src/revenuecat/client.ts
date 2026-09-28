import type { ProjectConfig } from '../config.js';

/** Base of RevenueCat's REST API v2. A v1 key does not work against it. */
const BASE = 'https://api.revenuecat.com/v2';

/** Minimal shape of a v2 Subscription — only the fields the ledger needs. */
export interface RcSubscription {
  id: string;
  customer_id?: string | null;
  product_id?: string | null;
  status?: string;
  store?: string;
  environment?: string;
  starts_at?: number | null;
  ends_at?: number | null;
  current_period_starts_at?: number | null;
  current_period_ends_at?: number | null;
  auto_renewal_status?: string | null;
  total_revenue_in_usd?: {
    gross?: number;
    commission?: number;
    tax?: number;
    proceeds?: number;
    currency?: string;
  } | null;
}

export interface OverviewMetrics {
  mrrCents: number | null;
  activeSubscriptions: number | null;
  activeTrials: number | null;
}

/**
 * Calls RevenueCat's v2 API for a project.
 *
 * Returns `null` rather than throwing on any failure: none of this is on the
 * money path — the ledger is fed by webhooks — so an unreachable API must
 * degrade into "no cross-check this hour", never into a lost figure.
 */
async function call<T>(project: ProjectConfig, path: string): Promise<T | null> {
  const rc = project.revenuecat;
  if (!rc?.apiKey || !rc.projectId) return null;

  try {
    const response = await fetch(`${BASE}/projects/${rc.projectId}${path}`, {
      headers: { Authorization: `Bearer ${rc.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      console.warn(`[revenuecat] ${project.id}: HTTP ${response.status} on ${path}`);
      return null;
    }
    return (await response.json()) as T;
  } catch (err) {
    console.warn(`[revenuecat] ${project.id}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * RevenueCat's own view of the project.
 *
 * Used only to check our figure against theirs. The metrics domain is rate
 * limited to 25 requests a minute, which one call per project per hour sits far
 * inside.
 */
export async function overviewMetrics(project: ProjectConfig): Promise<OverviewMetrics | null> {
  const body = await call<{ metrics?: { id?: string; value?: number }[] }>(
    project,
    '/metrics/overview',
  );
  if (!body?.metrics) return null;

  const value = (id: string) => body.metrics!.find((m) => m.id === id)?.value ?? null;
  const mrr = value('mrr');

  return {
    // RevenueCat reports MRR in whole currency units, not cents.
    mrrCents: mrr === null ? null : Math.round(mrr * 100),
    activeSubscriptions: value('active_subscriptions'),
    activeTrials: value('active_trials'),
  };
}

/**
 * Walks every page of a v2 list endpoint.
 *
 * RevenueCat paginates with an absolute `next_page` URL. It is reduced back to
 * a path so the caller never has to care, and the walk has no ceiling: a
 * capped scan silently under-reports, which on a subscription base is the kind
 * of error that looks like a business result.
 */
export async function* listAll(
  project: ProjectConfig,
  path: string,
): AsyncGenerator<Record<string, unknown>> {
  const rc = project.revenuecat;
  if (!rc?.apiKey || !rc.projectId) return;

  let next: string | null = path;
  let guard = 0;

  while (next && guard++ < 1000) {
    const body: { items?: Record<string, unknown>[]; next_page?: string | null } | null =
      await call(project, next);
    if (!body) return;

    for (const item of body.items ?? []) yield item;

    next = body.next_page
      ? body.next_page.replace(new RegExp(`^.*/v2/projects/${rc.projectId}`), '')
      : null;
  }
}
