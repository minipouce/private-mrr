/**
 * Recomputes what store payments really left, after the commission bug.
 *
 *   npm run rc-repair-net            -> every RevenueCat project
 *   npm run rc-repair-net -- --dry   -> report only, nothing written
 *
 * Until the fix, RevenueCat's commission and tax fractions were read as
 * percentages, so payments were booked at 99.7 % of their price. The webhook
 * payloads are gone, but RevenueCat still knows, per subscription, the gross
 * and the proceeds it paid out. Each customer's own ratio is applied to their
 * payments, and the subscriptions priced from those payments are rescaled.
 */
import { config } from '../config.js';
import { db } from '../db/index.js';
import { listAll, type RcSubscription } from '../revenuecat/client.js';

const dry = process.argv.includes('--dry');

for (const project of config.projects.filter((p) => p.revenuecat?.apiKey)) {
  const customers = db
    .prepare(
      `SELECT DISTINCT customer_id FROM events
       WHERE project_id = ? AND source = 'revenuecat' AND kind IN ('payment','refund')
         AND customer_id IS NOT NULL`,
    )
    .all(project.id) as { customer_id: string }[];

  const ratio = new Map<string, number>();
  let gAll = 0;
  let pAll = 0;
  for (const { customer_id } of customers) {
    let g = 0;
    let p = 0;
    for await (const raw of listAll(project, `/customers/${encodeURIComponent(customer_id)}/subscriptions`)) {
      const sub = raw as unknown as RcSubscription;
      if (sub.environment !== 'production') continue;
      g += sub.total_revenue_in_usd?.gross ?? 0;
      p += sub.total_revenue_in_usd?.proceeds ?? 0;
    }
    if (g > 0) ratio.set(customer_id, p / g);
    gAll += g;
    pAll += p;
  }
  // A customer RevenueCat no longer knows takes the project's own average.
  const fallback = gAll > 0 ? pAll / gAll : 0.6;

  const payments = db
    .prepare(
      `SELECT id, customer_id, subscription_id, gross_base_cents, amount_base_cents, occurred_at
       FROM events WHERE project_id = ? AND source = 'revenuecat'
         AND kind IN ('payment','refund') AND gross_base_cents IS NOT NULL`,
    )
    .all(project.id) as {
    id: number; customer_id: string | null; subscription_id: string | null;
    gross_base_cents: number; amount_base_cents: number; occurred_at: number;
  }[];

  let before = 0;
  let after = 0;
  const factorBySub = new Map<string, { factor: number; at: number }>();
  const setNet = db.prepare('UPDATE events SET amount_base_cents = ? WHERE id = ?');

  const apply = db.transaction(() => {
    for (const pay of payments) {
      const r = (pay.customer_id && ratio.get(pay.customer_id)) || fallback;
      const net = Math.round(pay.gross_base_cents * r);
      before += pay.amount_base_cents;
      after += net;
      if (!dry) setNet.run(net, pay.id);
      // The latest payment of a subscription is what priced it.
      if (pay.subscription_id && pay.amount_base_cents > 0) {
        const seen = factorBySub.get(pay.subscription_id);
        if (!seen || pay.occurred_at > seen.at) {
          factorBySub.set(pay.subscription_id, { factor: net / pay.amount_base_cents, at: pay.occurred_at });
        }
      }
    }

    let mrrBefore = 0;
    let mrrAfter = 0;
    const subs = db
      .prepare(
        `SELECT id, mrr_cents, mrr_base_cents, mrr_current_base_cents, amount_cents FROM subscriptions
         WHERE project_id = ? AND source = 'revenuecat' AND id NOT LIKE 'sub%' AND mrr_base_cents > 0`,
      )
      .all(project.id) as { id: string; mrr_cents: number; mrr_base_cents: number; mrr_current_base_cents: number; amount_cents: number }[];
    const rescale = db.prepare(
      `UPDATE subscriptions SET mrr_cents = ?, mrr_base_cents = ?, mrr_current_base_cents = ?, amount_cents = ?
       WHERE project_id = ? AND id = ?`,
    );
    for (const s of subs) {
      const f = factorBySub.get(s.id)?.factor ?? fallback;
      mrrBefore += s.mrr_base_cents;
      const m = Math.round(s.mrr_base_cents * f);
      mrrAfter += m;
      if (!dry) {
        rescale.run(Math.round(s.mrr_cents * f), m, Math.round(s.mrr_current_base_cents * f), Math.round(s.amount_cents * f), project.id, s.id);
      }
    }
    console.log(
      `${project.id.padEnd(20)} ${payments.length} paiements : net ${(before / 100).toFixed(2)} -> ${(after / 100).toFixed(2)} EUR | ` +
        `${subs.length} abonnements : MRR ${(mrrBefore / 100).toFixed(2)} -> ${(mrrAfter / 100).toFixed(2)} EUR | ` +
        `part moyenne conservee ${(fallback * 100).toFixed(1)} %${dry ? '  [essai, rien ecrit]' : ''}`,
    );
  });
  apply();
}
