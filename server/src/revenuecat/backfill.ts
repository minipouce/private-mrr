import type { ProjectConfig } from '../config.js';
import { db } from '../db/index.js';
import { upsertSubscription } from '../db/repo.js';
import { toBaseCents } from '../lib/money.js';
import { listAll, type RcSubscription } from './client.js';

/**
 * Rebuilds the store subscriptions a project already had.
 *
 * Webhooks only ever describe what happens next, so an app that has been
 * selling for a year starts at zero without this. RevenueCat offers no
 * project-wide list of subscriptions — only customer by customer — so the walk
 * is the only way in, and it is deliberately a command you run rather than
 * something that happens at boot.
 *
 * Two things this gets right, both learned from the data rather than the docs:
 *
 * Sandbox subscriptions sit in the same list as the real ones, carrying
 * plausible amounts (one test subscription showed 49.95 of revenue). Only
 * `environment: production` is kept.
 *
 * And the amount is RevenueCat's own `proceeds`, not the price times an assumed
 * commission. On this account proceeds are 58% of gross once Apple's cut and
 * the tax it remits are taken out — an assumed 15% commission would have
 * overstated the revenue by nearly half.
 */

/** Statuses under which a subscription is still worth something. */
const LIVE = new Set(['active', 'in_grace_period', 'in_billing_retry']);
/** Statuses that map to the ledger's `past_due`: billing, but failing. */
const AT_RISK = new Set(['in_grace_period', 'in_billing_retry']);

export interface BackfillResult {
  customers: number;
  production: number;
  sandbox: number;
  live: number;
  mrrBaseCents: number;
}

/** ISO 8601 period (`P1M`, `P1Y`, `P1W`) to months, for normalising to MRR. */
function monthsOf(duration: string | null | undefined, fallbackMs: number): number {
  const m = duration?.match(/^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/);
  if (m) {
    const months = Number(m[2] ?? 0) + Number(m[1] ?? 0) * 12;
    const weeks = Number(m[3] ?? 0);
    const days = Number(m[4] ?? 0);
    const total = months + weeks * (7 / 30.44) + days / 30.44;
    if (total > 0) return total;
  }
  // No usable product period: fall back to the length of the period it bought.
  return Math.max(fallbackMs / (30.44 * 86_400_000), 1 / 30.44);
}

/**
 * What one period of this subscription is worth, net.
 *
 * `total_revenue_in_usd` is cumulative over every renewal, so it is divided by
 * the number of periods actually billed. A subscription in its first period
 * divides by one and is therefore exact; the estimate only spreads across
 * renewals, where the price may have changed since.
 */
function perPeriodProceeds(sub: RcSubscription): number {
  const proceeds = sub.total_revenue_in_usd?.proceeds ?? 0;
  if (proceeds <= 0) return 0;

  const periodMs = Math.max(1, (sub.current_period_ends_at ?? 0) - (sub.current_period_starts_at ?? 0));
  const elapsedMs = Math.max(periodMs, (sub.current_period_ends_at ?? 0) - (sub.starts_at ?? 0));
  const periods = Math.max(1, Math.round(elapsedMs / periodMs));
  return proceeds / periods;
}

export async function backfillRevenueCat(project: ProjectConfig): Promise<BackfillResult> {
  const rc = project.revenuecat;
  const out: BackfillResult = { customers: 0, production: 0, sandbox: 0, live: 0, mrrBaseCents: 0 };
  if (!rc?.apiKey || !rc.projectId) return out;

  // Product periods, so a yearly subscription weighs a twelfth in MRR.
  const periods = new Map<string, string | null>();
  for await (const product of listAll(project, '/products?limit=100')) {
    periods.set(product.id as string, (product as { subscription?: { duration?: string } }).subscription?.duration ?? null);
  }

  for await (const customer of listAll(project, '/customers?limit=100')) {
    out.customers++;
    const id = encodeURIComponent(customer.id as string);

    for await (const raw of listAll(project, `/customers/${id}/subscriptions`)) {
      const sub = raw as unknown as RcSubscription;

      // The single most important line here. Sandbox subscriptions carry real
      // looking amounts and would quietly inflate the revenue.
      if (sub.environment !== 'production') { out.sandbox++; continue; }
      out.production++;

      const live = LIVE.has(sub.status ?? '');
      const trial = sub.status === 'trialing';
      if (!live && !trial) continue;

      const periodMs = Math.max(1, (sub.current_period_ends_at ?? 0) - (sub.current_period_starts_at ?? 0));
      const months = monthsOf(periods.get(sub.product_id ?? '') ?? null, periodMs);
      const netUsdCents = Math.round(perPeriodProceeds(sub) * 100);
      const monthlyBase = trial ? 0 : toBaseCents(Math.round(netUsdCents / months), 'usd');

      if (live) { out.live++; out.mrrBaseCents += monthlyBase; }

      upsertSubscription({
        id: sub.id,
        project_id: project.id,
        source: 'revenuecat',
        customer_id: sub.customer_id ?? null,
        customer_email: null,
        customer_name: null,
        status: trial ? 'trialing' : AT_RISK.has(sub.status ?? '') ? 'past_due' : 'active',
        currency: 'usd',
        amount_cents: netUsdCents,
        interval: months >= 11 ? 'year' : 'month',
        interval_count: months >= 11 ? 1 : Math.max(1, Math.round(months)),
        quantity: 1,
        mrr_cents: monthlyBase,
        mrr_base_cents: monthlyBase,
        mrr_current_base_cents: monthlyBase,
        product_name: sub.product_id ?? null,
        started_at: sub.starts_at ? Math.floor(sub.starts_at / 1000) : null,
        canceled_at: sub.auto_renewal_status === 'will_not_renew' && sub.ends_at
          ? Math.floor(sub.ends_at / 1000)
          : null,
        current_period_end: sub.current_period_ends_at
          ? Math.floor(sub.current_period_ends_at / 1000)
          : null,
      });
    }
  }

  db.prepare(
    `UPDATE sync_state SET last_backfill_at = ?, backfill_done = 1 WHERE project_id = ?`,
  ).run(Math.floor(Date.now() / 1000), project.id);

  return out;
}
