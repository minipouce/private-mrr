/**
 * Rebuilds the store subscriptions already in place.
 *
 *   npm run backfill-rc            -> every project with a RevenueCat key
 *   npm run backfill-rc mimiam     -> one project
 *
 * Deliberately a command and not a boot step: it walks every customer of the
 * project one by one, which is the only route RevenueCat offers.
 */
import { config } from '../config.js';
import { syncProjectsFromConfig, db } from '../db/index.js';
import { refreshRates } from '../lib/money.js';
import { backfillRevenueCat } from '../revenuecat/backfill.js';

const only = process.argv.slice(2).find((a) => !a.startsWith('--'));

syncProjectsFromConfig();
await refreshRates();

const targets = config.projects.filter(
  (p) => p.revenuecat?.apiKey && (!only || p.id === only),
);

if (targets.length === 0) {
  console.error('Aucun projet RevenueCat avec une clé configurée.');
  process.exit(1);
}

for (const project of targets) {
  process.stdout.write(`${project.id} : parcours des clients...\n`);
  const r = await backfillRevenueCat(project);
  console.log(
    `  ${r.customers} clients · ${r.production} abonnements production, ${r.sandbox} sandbox ecartes` +
      ` · ${r.live} actifs · MRR ${(r.mrrBaseCents / 100).toFixed(2)} ${config.baseCurrency.toUpperCase()}`,
  );
}

db.close();
