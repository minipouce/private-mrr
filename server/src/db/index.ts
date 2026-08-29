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
  // Compromis durabilité/latence acceptable ici : les webhooks Stripe sont
  // rejouables, une perte de la dernière transaction n'est pas définitive.
  db.pragma('synchronous = NORMAL');

  migrate(db);
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  return db;
}

/**
 * Migrations légères, appliquées avant le schéma.
 *
 * `schema.sql` est idempotent pour les créations, mais ne sait pas faire
 * évoluer une table existante. L'index d'unicité sur `payment_intent` s'appuie
 * sur une colonne ajoutée après coup : sans cet ajout préalable, la création de
 * l'index échouerait sur une base antérieure.
 */
function migrate(db: Database.Database): void {
  const hasEvents = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'")
    .get();
  if (!hasEvents) return; // base neuve : schema.sql crée déjà tout

  const columns = (db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!columns.includes('payment_intent')) {
    db.exec('ALTER TABLE events ADD COLUMN payment_intent TEXT');
    console.log('[db] migration : colonne payment_intent ajoutée');
  }

  const projectColumns = (
    db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]
  ).map((c) => c.name);
  if (projectColumns.length > 0 && !projectColumns.includes('include_in_totals')) {
    db.exec('ALTER TABLE projects ADD COLUMN include_in_totals INTEGER NOT NULL DEFAULT 1');
    console.log('[db] migration : colonne include_in_totals ajoutée');
  }
}

export const db = openDatabase();

/**
 * Synchronise la table `projects` avec la configuration d'environnement.
 * Les projets retirés de la config restent en base : leur historique est
 * conservé, seule l'ingestion s'arrête.
 */
export function syncProjectsFromConfig(): void {
  const upsert = db.prepare(`
    INSERT INTO projects (id, name, color, created_at)
    VALUES (@id, @name, @color, @now)
    -- include_in_totals est délibérément absent de la mise à jour : c'est un
    -- choix de l'utilisateur, il ne doit pas être écrasé à chaque démarrage.
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
  created_at: number;
}

export function listProjects(): ProjectRow[] {
  return db
    .prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE')
    .all() as ProjectRow[];
}
