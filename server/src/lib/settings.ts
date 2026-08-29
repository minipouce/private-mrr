import { db } from '../db/index.js';

/** Global settings, stored as key/value pairs. */
export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, Math.floor(Date.now() / 1000));
}

export function deleteSetting(key: string): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

export type GoalKind = 'mrr' | 'arr';

export interface Goal {
  cents: number;
  kind: GoalKind;
}

/**
 * Consolidated goal, expressed in MRR or ARR. Thinking in "10k MRR" or "120k
 * ARR" describes the same reality, but not the same way of picturing it.
 */
export function globalGoal(): Goal | null {
  const cents = Number(getSetting('goal_cents') ?? '');
  if (!Number.isFinite(cents) || cents <= 0) return null;
  const kind = getSetting('goal_kind') === 'arr' ? 'arr' : 'mrr';
  return { cents, kind };
}

export function setGlobalGoal(goal: Goal | null): void {
  if (!goal || goal.cents <= 0) {
    deleteSetting('goal_cents');
    deleteSetting('goal_kind');
    return;
  }
  setSetting('goal_cents', String(Math.round(goal.cents)));
  setSetting('goal_kind', goal.kind);
}

/** Goal progress, capped at 100% for display. */
export function goalProgress(goal: Goal | null, mrrCents: number) {
  if (!goal) return null;
  const current = goal.kind === 'arr' ? mrrCents * 12 : mrrCents;
  return {
    kind: goal.kind,
    targetCents: goal.cents,
    currentCents: current,
    // The raw value can exceed 100%: it is kept for display, while the progress
    // bar itself is capped in the interface.
    percent: Math.round((current / goal.cents) * 1000) / 10,
    remainingCents: Math.max(0, goal.cents - current),
  };
}
