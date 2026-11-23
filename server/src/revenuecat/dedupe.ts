import { db } from '../db/index.js';
import { MRR_STATUSES } from '../stripe/normalize.js';
import type { SubscriptionRow } from '../db/repo.js';

const MRR_LIST = MRR_STATUSES.map((s) => `'${s}'`).join(',');

/** Past its period end by more than this, a store subscription has lapsed. */
const GRACE_SECONDS = 3 * 24 * 60 * 60;

/**
 * Keeps one billing row per customer for a store project.
 *
 * Two sources name the same subscription differently. The backfill only has
 * RevenueCat's own id (`subAap…`), the webhooks carry the store's original
 * transaction id, and RevenueCat's API exposes no field joining the two. A
 * customer imported by the backfill who then renews therefore arrives as a
 * second subscription: counted twice, and the first row never closes since no
 * webhook will ever name it.
 *
 * The customer is the one key both sides share. These apps sell a single
 * premium entitlement, so a customer holds one subscription at a time, and any
 * other billing row of theirs is the same subscription under its other name.
 *
 * Retired rows keep `amount_cents` and end where the kept row begins, so the
 * monthly MRR history neither loses them nor counts the overlap twice. Returns
 * the retired row that was billing the most, which the caller treats as the
 * kept row's past: a renewal under a new name is not a new subscriber.
 */
export function supersede(
  projectId: string,
  customerId: string | null,
  keep: { id: string; started_at: number | null },
): SubscriptionRow | null {
  if (!customerId) return null;

  const others = db
    .prepare(
      `SELECT * FROM subscriptions
       WHERE project_id = ? AND source = 'revenuecat' AND customer_id = ? AND id <> ?
         AND status IN (${MRR_LIST})
       ORDER BY mrr_base_cents DESC`,
    )
    .all(projectId, customerId, keep.id) as SubscriptionRow[];
  if (others.length === 0) return null;

  const now = Math.floor(Date.now() / 1000);
  const retire = db.prepare(
    `UPDATE subscriptions
        SET status = 'canceled', canceled_at = ?, mrr_cents = 0, mrr_base_cents = 0,
            mrr_current_base_cents = 0, updated_at = ?
      WHERE project_id = ? AND id = ?`,
  );
  for (const row of others) {
    const end = Math.min(row.current_period_end ?? now, keep.started_at ?? now, now);
    retire.run(end, now, projectId, row.id);
  }
  return others[0] ?? null;
}

/**
 * Closes store subscriptions whose period ended and that nothing renewed.
 *
 * A renewal moves `current_period_end` forward. A row left behind it lapsed:
 * either its EXPIRATION webhook was lost, or no webhook could ever reach it
 * under the name it was imported with. Only `active` rows: a `past_due` one is
 * in the store's billing retry, which legitimately runs past the period end.
 */
export function expireLapsed(projectId: string): number {
  const now = Math.floor(Date.now() / 1000);
  return db
    .prepare(
      `UPDATE subscriptions
          SET status = 'expired', canceled_at = current_period_end, mrr_cents = 0,
              mrr_base_cents = 0, mrr_current_base_cents = 0, updated_at = ?
        WHERE project_id = ? AND source = 'revenuecat' AND status = 'active'
          AND current_period_end IS NOT NULL AND current_period_end < ?`,
    )
    .run(now, projectId, now - GRACE_SECONDS).changes;
}

/**
 * Settles every customer holding more than one billing row.
 *
 * The row a webhook can still reach is kept: anything but a backfill id, and
 * failing that the one running furthest. If it carries no amount yet — it was
 * created by an event that names no price — it takes the amount of the row it
 * replaces, rather than dropping a paying subscriber to zero until next year.
 */
export function settleDuplicates(projectId: string): number {
  const customers = db
    .prepare(
      `SELECT customer_id FROM subscriptions
       WHERE project_id = ? AND source = 'revenuecat' AND customer_id IS NOT NULL
         AND status IN (${MRR_LIST})
       GROUP BY customer_id HAVING COUNT(*) > 1`,
    )
    .all(projectId) as { customer_id: string }[];

  let retired = 0;
  for (const { customer_id } of customers) {
    const rows = db
      .prepare(
        `SELECT * FROM subscriptions
         WHERE project_id = ? AND source = 'revenuecat' AND customer_id = ?
           AND status IN (${MRR_LIST})
         ORDER BY (id LIKE 'sub%') ASC, current_period_end DESC`,
      )
      .all(projectId, customer_id) as SubscriptionRow[];
    const keep = rows[0]!;

    const replaced = supersede(projectId, customer_id, keep);
    if (replaced) retired += rows.length - 1;
    if (keep.mrr_base_cents === 0 && replaced && replaced.mrr_base_cents > 0) {
      inherit(projectId, keep.id, replaced);
    }
  }
  return retired;
}

/** Gives a row the amounts of the subscription it replaces. */
export function inherit(projectId: string, id: string, from: SubscriptionRow): void {
  db.prepare(
    `UPDATE subscriptions
        SET mrr_cents = ?, mrr_base_cents = ?, mrr_current_base_cents = ?,
            amount_cents = ?, currency = ?, interval = ?, interval_count = ?
      WHERE project_id = ? AND id = ?`,
  ).run(
    from.mrr_cents,
    from.mrr_base_cents,
    from.mrr_current_base_cents,
    from.amount_cents,
    from.currency,
    from.interval,
    from.interval_count,
    projectId,
    id,
  );
}
