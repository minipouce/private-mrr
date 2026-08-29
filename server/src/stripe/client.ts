import Stripe from 'stripe';
import { config, type ProjectConfig } from '../config.js';

const clients = new Map<string, Stripe>();

/**
 * Client Stripe par projet, mémoïsé.
 * Retourne `null` si le projet n'a pas de clé (mode démo ou projet archivé),
 * ce qui permet aux appelants de dégrader proprement plutôt que de planter.
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

/** Projets réellement connectés à Stripe (clé présente). */
export function liveProjects(): ProjectConfig[] {
  return config.projects.filter((p) => p.stripeKey);
}

/**
 * Vérifie que chaque clé configurée est valide et lisible.
 * Exécuté au démarrage pour échouer tôt plutôt qu'au premier webhook.
 */
export async function verifyKeys(): Promise<void> {
  for (const project of liveProjects()) {
    const stripe = stripeFor(project)!;
    try {
      // On sonde une ressource réellement utilisée par l'application plutôt que
      // le solde : exiger la permission Balance élargirait inutilement la portée
      // des clés, alors que le solde n'est jamais lu.
      await stripe.subscriptions.list({ limit: 1 });
      const mode = project.stripeKey!.includes('_live_') ? 'live' : 'test';
      const restricted = project.stripeKey!.startsWith('rk_');
      console.log(
        `[stripe] ${project.id} : clé ${mode}${restricted ? ' restreinte' : ''} valide`,
      );
      if (!restricted) {
        console.warn(
          `[stripe] ${project.id} : clé secrète complète détectée. ` +
            `Une clé restreinte en lecture seule (rk_live_…) est fortement recommandée.`,
        );
      }
    } catch (err) {
      // On ne journalise jamais la clé elle-même, seulement l'identifiant projet.
      console.error(
        `[stripe] ${project.id} : clé invalide ou permissions insuffisantes — ${(err as Error).message}`,
      );
    }
  }
}
