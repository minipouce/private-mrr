import Stripe from 'stripe';
import { config, type ProjectConfig } from '../config.js';

const clients = new Map<string, Stripe>();

/**
 * Per-project Stripe client, memoised.
 * Returns `null` when a project has no key (demo mode, or an archived project),
 * letting callers degrade gracefully instead of crashing.
 */
export function stripeFor(project: ProjectConfig): Stripe | null {
  if (!project.stripeKey) return null;

  const existing = clients.get(project.id);
  if (existing) return existing;

  const client = new Stripe(project.stripeKey, {
    maxNetworkRetries: 3,
    timeout: 20_000,
    telemetry: false,
    appInfo: { name: 'private-mrr', version: '1.0.0' },
  });
  clients.set(project.id, client);
  return client;
}

/** Projects actually connected to Stripe (key present). */
export function liveProjects(): ProjectConfig[] {
  return config.projects.filter((p) => p.stripeKey);
}

/**
 * Checks that every configured key is valid and readable.
 * Runs at startup so failures surface early rather than on the first webhook.
 */
export async function verifyKeys(): Promise<void> {
  for (const project of liveProjects()) {
    const stripe = stripeFor(project)!;
    try {
      // Probe a resource the application actually uses rather than the balance:
      // requiring Balance read would widen the keys' scope for nothing, since
      // the balance is never read.
      await stripe.subscriptions.list({ limit: 1 });
      const mode = project.stripeKey!.includes('_live_') ? 'live' : 'test';
      const restricted = project.stripeKey!.startsWith('rk_');
      console.log(
        `[stripe] ${project.id}: valid ${mode}${restricted ? ' restricted' : ''} key`,
      );
      if (!restricted) {
        console.warn(
          `[stripe] ${project.id}: full secret key detected. ` +
            `A read-only restricted key (rk_live_…) is strongly recommended.`,
        );
      }
    } catch (err) {
      // Never log the key itself, only the project id.
      console.error(
        `[stripe] ${project.id}: invalid key or insufficient permissions: ${(err as Error).message}`,
      );
    }
  }
}
