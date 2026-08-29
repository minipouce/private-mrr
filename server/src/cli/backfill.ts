/**
 * Import manuel de l'historique Stripe.
 *   npm run backfill              -> tous les projets, sans réécraser l'existant
 *   npm run backfill -- --force   -> rejoue l'historique complet
 *   npm run backfill -- saas-a    -> un seul projet
 */
import { config } from '../config.js';
import { syncProjectsFromConfig, db } from '../db/index.js';
import { refreshRates } from '../lib/money.js';
import { backfillProject } from '../stripe/backfill.js';

const args = process.argv.slice(2);
const force = args.includes('--force');
const only = args.find((a) => !a.startsWith('--'));

syncProjectsFromConfig();
await refreshRates();

const targets = config.projects.filter(
  (p) => p.stripeKey && (!only || p.id === only),
);

if (targets.length === 0) {
  console.error('Aucun projet correspondant avec une clé Stripe configurée.');
  process.exit(1);
}

for (const project of targets) {
  const result = await backfillProject(project, { force });
  console.log(`${project.id} : ${result.subscriptions} abonnements, ${result.events} événements`);
}

db.close();
