import { db } from '../db/index.js';

/** Seconds since the epoch, the unit every date is stored in. */
export const sec = (d: Date) => Math.floor(d.getTime() / 1000);

/**
 * Builds the project filter for a query.
 *
 * With no id, the whole table is not summed: the scope narrows to projects
 * flagged `include_in_totals`. An excluded project stays viewable on its own, it
 * simply no longer weighs on the consolidated figures.
 */
export function projectFilter(projectId?: string): { clause: string; args: string[] } {
  if (projectId) return { clause: 'project_id = ?', args: [projectId] };

  const rows = db
    .prepare('SELECT id FROM projects WHERE include_in_totals = 1')
    .all() as { id: string }[];

  if (rows.length === 0) return { clause: '1 = 0', args: [] };
  return {
    clause: `project_id IN (${rows.map(() => '?').join(',')})`,
    args: rows.map((r) => r.id),
  };
}

export function startOfDay(ref = new Date()): Date {
  const d = new Date(ref);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function startOfMonth(ref = new Date()): Date {
  const d = startOfDay(ref);
  d.setDate(1);
  return d;
}

export function startOfYear(ref = new Date()): Date {
  const d = startOfMonth(ref);
  d.setMonth(0);
  return d;
}

export function addMonths(ref: Date, n: number): Date {
  const d = new Date(ref);
  d.setMonth(d.getMonth() + n);
  return d;
}

/** `2026-09`, the key every monthly series is indexed by. */
export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Days in the month a date falls in. */
export function daysInMonth(ref: Date): number {
  return new Date(ref.getFullYear(), ref.getMonth() + 1, 0).getDate();
}
