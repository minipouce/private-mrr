import { db } from '../db/index.js';
import type { ProjectConfig } from '../config.js';
import { MRR_STATUSES } from '../stripe/normalize.js';
import { overviewMetrics } from './client.js';

const MRR_LIST = MRR_STATUSES.map((s) => `'${s}'`).join(',');

/**
 * Compares our MRR for a store project with RevenueCat's own.
 *
 * The ledger is built from webhooks, so a delivery lost during a deployment
 * leaves a hole that nothing else would ever reveal — the figure would simply
 * be quietly too low. This asks RevenueCat what it thinks and records the gap.
 *
 * It deliberately does not correct anything. The two numbers are not the same
 * quantity: ours is net of the store commission, RevenueCat's is gross. What
 * matters is that the gap stays stable; a jump means a missed event.
 */
export async function crossCheck(project: ProjectConfig): Promise<string | null> {
  const metrics = await overviewMetrics(project);
  if (!metrics || metrics.mrrCents === null) return null;

  const row = db
    .prepare(
      `SELECT COALESCE(SUM(mrr_base_cents), 0) AS mrr, COUNT(*) AS n
       FROM subscriptions
       WHERE project_id = ? AND source = 'revenuecat' AND status IN (${MRR_LIST})`,
    )
    .get(project.id) as { mrr: number; n: number };

  const theirs = metrics.activeSubscriptions ?? 0;
  const ours = row.n;

  // The subscription count is the honest comparison: it is the same quantity on
  // both sides, where the amounts are not.
  if (theirs > 0 && Math.abs(theirs - ours) > Math.max(1, theirs * 0.05)) {
    const message =
      `RevenueCat compte ${theirs} abonnements actifs, nous en avons ${ours} ` +
      `(MRR brut RevenueCat ${(metrics.mrrCents / 100).toFixed(2)}, notre MRR net ${(row.mrr / 100).toFixed(2)})`;
    console.warn(`[revenuecat] ${project.id}: ${message}`);
    return message;
  }
  return null;
}
