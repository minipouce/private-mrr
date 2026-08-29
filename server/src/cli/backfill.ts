/**
 * Manual Stripe history import.
 *   npm run backfill              -> every project, without overwriting
 *   npm run backfill -- --force   -> replays the full history
 *   npm run backfill -- saas-a    -> a single project
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
  console.error('No matching project with a configured Stripe key.');
  process.exit(1);
}

for (const project of targets) {
  const result = await backfillProject(project, { force });
  console.log(`${project.id}: ${result.subscriptions} subscriptions, ${result.events} events`);
}

db.close();
