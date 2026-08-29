-- Schéma du ledger d'événements et de l'état des abonnements.
-- Tous les montants sont des entiers en centimes. `amount_cents` est exprimé
-- dans la devise d'origine, `amount_base_cents` dans la devise de consolidation.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#6366f1',
  -- Exclure un projet du total consolidé sans cesser de le suivre : utile pour
  -- un compte de test, ou un projet entièrement offert qui fausserait la lecture.
  include_in_totals INTEGER NOT NULL DEFAULT 1,
  -- Dernière récupération du logo de marque depuis Stripe.
  logo_updated_at INTEGER,
  -- Objectif de revenu, en centimes de la devise de consolidation.
  goal_cents      INTEGER,
  -- Nature de l'objectif : 'mrr' ou 'arr'.
  goal_kind       TEXT NOT NULL DEFAULT 'mrr',
  created_at  INTEGER NOT NULL
);

-- Ledger append-only. `stripe_event_id` garantit l'idempotence : Stripe peut
-- relivrer un webhook plusieurs fois, on n'insère qu'une seule occurrence.
CREATE TABLE IF NOT EXISTS events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stripe_event_id    TEXT,
  stripe_object_id   TEXT NOT NULL,
  kind               TEXT NOT NULL,
  amount_cents       INTEGER NOT NULL DEFAULT 0,
  currency           TEXT NOT NULL,
  amount_base_cents  INTEGER NOT NULL DEFAULT 0,
  mrr_delta_cents    INTEGER NOT NULL DEFAULT 0,
  customer_id        TEXT,
  customer_email     TEXT,
  customer_name      TEXT,
  subscription_id    TEXT,
  payment_intent     TEXT,
  -- Motif Stripe de la facture : distingue une première souscription d'un
  -- renouvellement, information invisible sur le seul montant encaissé.
  billing_reason     TEXT,
  description        TEXT,
  occurred_at        INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  UNIQUE (project_id, stripe_event_id)
);

CREATE INDEX IF NOT EXISTS idx_events_occurred     ON events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_project_time ON events (project_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind_time    ON events (kind, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_object       ON events (project_id, stripe_object_id);

-- Un encaissement se matérialise à la fois par une facture et par une charge.
-- Aucun champ ne les relie sur les versions récentes de l'API : le payment
-- intent est le seul identifiant commun. Cet index garantit qu'un même
-- encaissement n'est compté qu'une fois, quel que soit l'ordre d'arrivée.
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_payment_intent
  ON events (project_id, payment_intent)
  WHERE payment_intent IS NOT NULL AND kind = 'payment';

-- État courant de chaque abonnement, reconstruit depuis Stripe puis maintenu
-- par les webhooks. C'est la source de vérité du MRR instantané.
CREATE TABLE IF NOT EXISTS subscriptions (
  id                  TEXT NOT NULL,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  customer_id         TEXT,
  customer_email      TEXT,
  customer_name       TEXT,
  status              TEXT NOT NULL,
  currency            TEXT NOT NULL,
  amount_cents        INTEGER NOT NULL DEFAULT 0,
  interval            TEXT NOT NULL DEFAULT 'month',
  interval_count      INTEGER NOT NULL DEFAULT 1,
  quantity            INTEGER NOT NULL DEFAULT 1,
  mrr_cents           INTEGER NOT NULL DEFAULT 0,
  mrr_base_cents      INTEGER NOT NULL DEFAULT 0,
  product_name        TEXT,
  started_at          INTEGER,
  canceled_at         INTEGER,
  current_period_end  INTEGER,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_subs_status  ON subscriptions (status);
CREATE INDEX IF NOT EXISTS idx_subs_project ON subscriptions (project_id, status);

-- Jetons de notification Expo. Un par appareil.
CREATE TABLE IF NOT EXISTS push_tokens (
  token        TEXT PRIMARY KEY,
  device_name  TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

-- Préférences de notification par projet. L'absence de ligne vaut "tout activé".
CREATE TABLE IF NOT EXISTS notification_prefs (
  project_id         TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  notify_payments    INTEGER NOT NULL DEFAULT 1,
  notify_signups     INTEGER NOT NULL DEFAULT 1,
  notify_cancels     INTEGER NOT NULL DEFAULT 1,
  notify_failures    INTEGER NOT NULL DEFAULT 1,
  min_amount_cents   INTEGER NOT NULL DEFAULT 0
);

-- Suivi du backfill pour ne rejouer l'historique qu'une fois par projet.
CREATE TABLE IF NOT EXISTS sync_state (
  project_id         TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  backfill_done      INTEGER NOT NULL DEFAULT 0,
  last_backfill_at   INTEGER,
  last_event_at      INTEGER,
  last_error         TEXT
);

-- Taux de change mis en cache, rafraîchis périodiquement.
CREATE TABLE IF NOT EXISTS fx_rates (
  currency    TEXT PRIMARY KEY,
  rate        REAL NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Réglages globaux, sous forme clé/valeur : peu nombreux et hétérogènes,
-- une table dédiée par réglage serait disproportionnée.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
