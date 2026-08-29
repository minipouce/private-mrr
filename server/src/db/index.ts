import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const here = dirname(fileURLToPath(import.meta.url));

function openDatabase(): Database.Database {
  mkdirSync(dirname(config.dbPath), { recursive: true });

  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // An acceptable durability/latency trade-off here: Stripe webhooks are
  // replayable, so losing the last transaction is not permanent.
  db.pragma('synchronous = NORMAL');

  migrate(db);
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  return db;
}

/**
 * Lightweight migrations, applied before the schema.
 *
 * `schema.sql` is idempotent for creation but cannot evolve an existing table.
 * The unique index on `payment_intent` relies on a column added later: without
 * this prior step, creating the index would fail on an older database.
 */
function migrate(db: Database.Database): void {
  const hasEvents = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'")
    .get();
  if (!hasEvents) return; // fresh database: schema.sql creates everything

  const columns = (db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!columns.includes('payment_intent')) {
    db.exec('ALTER TABLE events ADD COLUMN payment_intent TEXT');
    console.log('[db] migration: payment_intent column added');
  }

  const projectColumns = (
    db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]
  ).map((c) => c.name);
  if (projectColumns.length > 0 && !projectColumns.includes('include_in_totals')) {
    db.exec('ALTER TABLE projects ADD COLUMN include_in_totals INTEGER NOT NULL DEFAULT 1');
    console.log('[db] migration: include_in_totals column added');
  }
  if (projectColumns.length > 0 && !projectColumns.includes('logo_updated_at')) {
    db.exec('ALTER TABLE projects ADD COLUMN logo_updated_at INTEGER');
    console.log('[db] migration: logo_updated_at column added');
  }
  if (projectColumns.length > 0 && !projectColumns.includes('goal_cents')) {
    db.exec('ALTER TABLE projects ADD COLUMN goal_cents INTEGER');
    db.exec("ALTER TABLE projects ADD COLUMN goal_kind TEXT NOT NULL DEFAULT 'mrr'");
    console.log('[db] migration: goal columns added');
  }
  if (!columns.includes('billing_reason')) {
    db.exec('ALTER TABLE events ADD COLUMN billing_reason TEXT');
    console.log('[db] migration: billing_reason column added');
  }
}

export const db = openDatabase();

/**
 * Syncs the `projects` table with the environment configuration.
 * Projects removed from the config stay in the database: their history is kept,
 * only ingestion stops.
 */
export function syncProjectsFromConfig(): void {
  const upsert = db.prepare(`
    INSERT INTO projects (id, name, color, created_at)
    VALUES (@id, @name, @color, @now)
    -- include_in_totals is deliberately absent from the update: it is a user
    -- choice and must not be overwritten on every boot.
    ON CONFLICT(id) DO UPDATE SET name = @name, color = @color
  `);
  const ensurePrefs = db.prepare(
    'INSERT OR IGNORE INTO notification_prefs (project_id) VALUES (?)',
  );
  const ensureSync = db.prepare(
    'INSERT OR IGNORE INTO sync_state (project_id) VALUES (?)',
  );

  const now = Math.floor(Date.now() / 1000);
  const run = db.transaction(() => {
    for (const project of config.projects) {
      upsert.run({
        id: project.id,
        name: project.name,
        color: project.color,
        now,
      });
      ensurePrefs.run(project.id);
      ensureSync.run(project.id);
    }
  });
  run();
}

export interface ProjectRow {
  id: string;
  name: string;
  color: string;
  include_in_totals: number;
  logo_updated_at: number | null;
  goal_cents: number | null;
  goal_kind: string;
  created_at: number;
}

export function listProjects(): ProjectRow[] {
  return db
    .prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE')
    .all() as ProjectRow[];
}
