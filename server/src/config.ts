import 'dotenv/config';
import { randomBytes } from 'node:crypto';

/**
 * Multi-account configuration.
 *
 * Each project maps to a distinct Stripe account and is declared through a
 * group of prefixed environment variables. For a project named `saas-a`:
 *
 *   PROJECTS=saas-a,saas-b
 *   PROJECT_SAAS_A_NAME="SaaS A"
 *   PROJECT_SAAS_A_STRIPE_KEY=rk_live_xxx
 *   PROJECT_SAAS_A_WEBHOOK_SECRET=whsec_xxx
 *   PROJECT_SAAS_A_COLOR="#6366f1"
 *
 * Stripe keys never leave the server: they are not stored in the database, not
 * exposed by the API, and never logged.
 */

/**
 * RevenueCat side of a project: the App Store and Google Play subscriptions.
 *
 * Separate from Stripe because the two answer different questions. Stripe bills
 * and tells you the amount. A store bills, keeps its commission, and only then
 * pays out — so what lands in the bank is not what the customer paid.
 */
export interface RevenueCatConfig {
  /** Secret API v2 key (`sk_...`). A v1 key will not work. */
  apiKey: string | null;
  /** RevenueCat project id, which its API paths are built from. */
  projectId: string | null;
  /**
   * Exact value of the `Authorization` header set in RevenueCat's dashboard.
   * RevenueCat does not sign its webhooks: it repeats this secret instead, so
   * without it anyone could post fake revenue.
   */
  webhookAuth: string | null;
  /**
   * Store commission to assume when an event does not carry one, in percent.
   *
   * RevenueCat marks `commission_percentage` as only sometimes present. The
   * rate is 30% by default, 15% under Apple's Small Business Program and for
   * Google Play's first million, so it has to be told per project rather than
   * guessed. When neither the event nor this says, 30% is applied and logged —
   * understating revenue is the safer error for a forecast.
   */
  commissionPct: number | null;
}

export interface ProjectConfig {
  /** Stable id used in the database and the API (for example `saas-a`). */
  id: string;
  name: string;
  /** Stripe secret key. Absent in demo mode, or on a store-only project. */
  stripeKey: string | null;
  /** Stripe webhook signing secret for this account. */
  webhookSecret: string | null;
  /** Store subscriptions, when the project has any. `null` when it has none. */
  revenuecat: RevenueCatConfig | null;
  /** Accent colour the app uses to identify the project. */
  color: string;
}

/** Default palette, assigned in declaration order. */
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

/** `saas-a` -> `SAAS_A`, to rebuild the environment variable prefix. */
function envKey(projectId: string): string {
  return projectId.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/**
 * Reads an environment variable, treating an empty string as absent.
 *
 * Necessary because `??` does not fall back for `''`: an unquoted colour such
 * as `COLOR=#6366f1` is truncated by dotenv, which reads everything after `#`
 * as a comment, silently yielding an empty string.
 */
function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

/** Reads a project's RevenueCat block, or `null` when it declares none. */
function readRevenueCat(prefix: string): RevenueCatConfig | null {
  const apiKey = env(`${prefix}_REVENUECAT_KEY`);
  const projectId = env(`${prefix}_REVENUECAT_PROJECT_ID`);
  const webhookAuth = env(`${prefix}_REVENUECAT_WEBHOOK_AUTH`);
  if (!apiKey && !projectId && !webhookAuth) return null;

  const raw = env(`${prefix}_STORE_COMMISSION_PCT`);
  const commissionPct = raw === null ? null : Number(raw);

  return {
    apiKey,
    projectId,
    webhookAuth,
    commissionPct:
      commissionPct !== null && Number.isFinite(commissionPct) && commissionPct >= 0 && commissionPct < 100
        ? commissionPct
        : null,
  };
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
        revenuecat: readRevenueCat(prefix),
        color: env(`${prefix}_COLOR`) ?? DEFAULT_COLORS[index % DEFAULT_COLORS.length]!,
      };
    });
}

function readApiToken(): string {
  const token = process.env.API_TOKEN?.trim();
  if (token) return token;

  // In development, generate an ephemeral token rather than refusing to boot.
  // In production that behaviour would be unacceptable.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'API_TOKEN is required in production. Generate one with: openssl rand -hex 32',
    );
  }

  const generated = randomBytes(32).toString('hex');
  console.warn(
    `\n  API_TOKEN missing — ephemeral token generated for this session:\n  ${generated}\n` +
      `  Add it to your .env so it survives a restart.\n`,
  );
  return generated;
}

const projects = readProjects();

export const config = {
  port: Number(process.env.PORT ?? 8791),
  host: process.env.HOST ?? '0.0.0.0',
  dbPath: process.env.DB_PATH ?? './data/mrr.db',
  apiToken: readApiToken(),

  /** Base currency. Every aggregated amount is converted into it. */
  baseCurrency: (process.env.BASE_CURRENCY ?? 'eur').toLowerCase(),

  /**
   * Public URL of this server. Required for notifications: Firebase fetches the
   * logo image over the internet, so a local address would be useless to it.
   */
  publicUrl: (process.env.PUBLIC_URL ?? '').replace(/\/+$/, ''),

  /** Fills the database with fictional data instead of calling Stripe. */
  demoMode: process.env.DEMO_MODE === 'true',

  /** Replays the full Stripe history at boot if a project was never synced. */
  backfillOnBoot: process.env.BACKFILL_ON_BOOT !== 'false',

  projects,
  projectById: new Map(projects.map((p) => [p.id, p])),
} as const;

export function requireProject(id: string): ProjectConfig {
  const project = config.projectById.get(id);
  if (!project) throw new Error(`Unknown project: ${id}`);
  return project;
}
