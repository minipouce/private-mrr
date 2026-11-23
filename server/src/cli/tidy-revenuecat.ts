/**
 * Puts the store subscriptions straight, once, with a report.
 *
 *   npm run rc-tidy
 *
 * The hourly job does the same quietly from now on; this exists to clean what
 * accumulated before it did, and to show what changed.
 */
import { config } from '../config.js';
import { db } from '../db/index.js';
import { MRR_STATUSES } from '../stripe/normalize.js';
import { expireLapsed, settleDuplicates } from '../revenuecat/dedupe.js';

const MRR_LIST = MRR_STATUSES.map((s) => `'${s}'`).join(',');
const state = (id: string) =>
  db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(mrr_base_cents), 0) AS mrr FROM subscriptions
       WHERE project_id = ? AND source = 'revenuecat' AND status IN (${MRR_LIST})`,
    )
    .get(id) as { n: number; mrr: number };

for (const project of config.projects.filter((p) => p.revenuecat?.apiKey)) {
  const before = state(project.id);
  // A row named 'inconnu' was never a subscription: anonymous events piled onto it.
  const orphans = db
    .prepare(`DELETE FROM subscriptions WHERE project_id = ? AND source = 'revenuecat' AND id = 'inconnu'`)
    .run(project.id).changes;
  const merged = settleDuplicates(project.id);
  const lapsed = expireLapsed(project.id);
  const after = state(project.id);
  console.log(
    `${project.id.padEnd(20)} ${before.n} -> ${after.n} abonnements, ` +
      `MRR ${(before.mrr / 100).toFixed(2)} -> ${(after.mrr / 100).toFixed(2)} EUR ` +
      `(${merged} doublon(s) fusionne(s), ${lapsed} expire(s), ${orphans} ligne(s) 'inconnu')`,
  );
}
