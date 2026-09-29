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
export function projectFilter(
  projectId?: string,
  scope?: string[] | null,
): { clause: string; args: string[] } {
  // A restricted token narrows everything, including a request naming one
  // project: without this, asking for a project by id would walk straight past
  // the restriction.
  if (projectId) {
    if (scope && !scope.includes(projectId)) return { clause: '1 = 0', args: [] };
    return { clause: 'project_id = ?', args: [projectId] };
  }

  const rows = db
    .prepare('SELECT id FROM projects WHERE include_in_totals = 1')
    .all() as { id: string }[];

  const ids = scope ? rows.filter((r) => scope.includes(r.id)) : rows;
  if (ids.length === 0) return { clause: '1 = 0', args: [] };
  return {
    clause: `project_id IN (${ids.map(() => '?').join(',')})`,
    args: ids.map((r) => r.id),
  };
}

/** Projects a token may list, in the order the interface shows them. */
export function visibleProjects(scope?: string[] | null): string[] {
  const rows = db.prepare('SELECT id FROM projects').all() as { id: string }[];
  return rows.map((r) => r.id).filter((id) => !scope || scope.includes(id));
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

/**
 * Shifts a date by whole months, keeping the day of month inside the target.
 *
 * `setMonth` alone keeps the day and lets it overflow: asked for 29 February it
 * answers 1 March. Walking a series back from the 29th of a month therefore
 * skipped February and returned March twice.
 */
export function addMonths(ref: Date, n: number): Date {
  const d = new Date(ref);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, daysInMonth(d)));
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
