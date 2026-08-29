import 'dotenv/config';
import { randomBytes } from 'node:crypto';

/**
 * Configuration multi-comptes.
 *
 * Chaque projet correspond à un compte Stripe distinct et se déclare via un
 * groupe de variables d'environnement préfixées. Exemple pour le projet `saas-a` :
 *
 *   PROJECTS=saas-a,saas-b
 *   PROJECT_SAAS_A_NAME="SaaS A"
 *   PROJECT_SAAS_A_STRIPE_KEY=sk_live_xxx
 *   PROJECT_SAAS_A_WEBHOOK_SECRET=whsec_xxx
 *   PROJECT_SAAS_A_COLOR=#6366f1
 *
 * Les clés Stripe ne quittent jamais le serveur : elles ne sont ni stockées en
 * base, ni exposées par l'API, ni journalisées.
 */

export interface ProjectConfig {
  /** Identifiant stable utilisé en base et dans l'API (ex. `saas-a`). */
  id: string;
  name: string;
  /** Clé secrète Stripe. Absente en mode démo. */
  stripeKey: string | null;
  /** Secret de signature du webhook Stripe pour ce compte. */
  webhookSecret: string | null;
  /** Couleur d'accent utilisée par l'app pour identifier le projet. */
  color: string;
}

/** Palette par défaut, assignée dans l'ordre de déclaration des projets. */
const DEFAULT_COLORS = [
  '#6366f1',
  '#10b981',
  '#f59e0b',
  '#ec4899',
  '#06b6d4',
  '#8b5cf6',
  '#ef4444',
  '#14b8a6',
];

/** `saas-a` -> `SAAS_A`, pour reconstituer le préfixe des variables d'env. */
function envKey(projectId: string): string {
  return projectId.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/**
 * Lit une variable d'environnement en traitant la chaîne vide comme absente.
 *
 * Nécessaire car `??` ne bascule pas sur la valeur par défaut pour `''` : une
 * couleur non quotée comme `COLOR=#6366f1` est tronquée par dotenv, qui voit
 * un commentaire après le `#`, et produit silencieusement une chaîne vide.
 */
function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function readProjects(): ProjectConfig[] {
  const raw = (process.env.PROJECTS ?? '').trim();
  if (!raw) return [];

  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((id, index) => {
      const prefix = `PROJECT_${envKey(id)}`;
      return {
        id,
        name: env(`${prefix}_NAME`) ?? id,
        stripeKey: env(`${prefix}_STRIPE_KEY`),
        webhookSecret: env(`${prefix}_WEBHOOK_SECRET`),
        color: env(`${prefix}_COLOR`) ?? DEFAULT_COLORS[index % DEFAULT_COLORS.length]!,
      };
    });
}

function readApiToken(): string {
  const token = process.env.API_TOKEN?.trim();
  if (token) return token;

  // En développement on génère un token éphémère plutôt que d'échouer au
  // démarrage, mais on refuse ce comportement en production.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'API_TOKEN est obligatoire en production. Générez-en un avec: openssl rand -hex 32',
    );
  }

  const generated = randomBytes(32).toString('hex');
  console.warn(
    `\n  API_TOKEN absent — token éphémère généré pour cette session :\n  ${generated}\n` +
      `  Ajoutez-le à votre .env pour qu'il survive au redémarrage.\n`,
  );
  return generated;
}

const projects = readProjects();

export const config = {
  port: Number(process.env.PORT ?? 8791),
  host: process.env.HOST ?? '0.0.0.0',
  dbPath: process.env.DB_PATH ?? './data/mrr.db',
  apiToken: readApiToken(),

  /** Devise de consolidation. Tous les montants agrégés y sont convertis. */
  baseCurrency: (process.env.BASE_CURRENCY ?? 'eur').toLowerCase(),

  /** Alimente la base avec des données fictives au lieu d'appeler Stripe. */
  demoMode: process.env.DEMO_MODE === 'true',

  /** Rejoue l'historique Stripe complet au démarrage si le projet n'a jamais été synchronisé. */
  backfillOnBoot: process.env.BACKFILL_ON_BOOT !== 'false',

  projects,
  projectById: new Map(projects.map((p) => [p.id, p])),
} as const;

export function requireProject(id: string): ProjectConfig {
  const project = config.projectById.get(id);
  if (!project) throw new Error(`Projet inconnu : ${id}`);
  return project;
}
