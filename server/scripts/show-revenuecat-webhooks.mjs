#!/usr/bin/env node
/**
 * Prints what each RevenueCat webhook form needs: the URL and the secret.
 *
 * Run it in your own terminal, never inside an assistant session — it prints
 * live secrets, and anything printed inside a session is read by the assistant
 * and kept in the conversation.
 */
import { readFileSync, existsSync } from 'node:fs';

const FILE = new URL('../.env.real', import.meta.url).pathname;
if (!existsSync(FILE)) {
  console.error(`${FILE} introuvable`);
  process.exit(1);
}

const env = readFileSync(FILE, 'utf8');
const value = (name) => env.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim() ?? '';

const base = (value('PUBLIC_URL') || 'https://mrr.fibroweb.fr').replace(/\/+$/, '');
const projects = value('PROJECTS').split(',').map((p) => p.trim()).filter(Boolean);

const rows = projects
  .map((id) => {
    const key = `PROJECT_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
    return {
      id,
      name: value(`${key}_NAME`).replace(/^"|"$/g, '') || id,
      secret: value(`${key}_REVENUECAT_WEBHOOK_AUTH`),
      apiKey: value(`${key}_REVENUECAT_KEY`),
    };
  })
  .filter((r) => r.secret);

if (rows.length === 0) {
  console.log('Aucun projet RevenueCat configure dans .env.real.');
  process.exit(0);
}

console.log('\nA coller dans RevenueCat : Integrations -> Add webhook\n');
for (const r of rows) {
  console.log(`  ${r.name}`);
  console.log(`    URL                   ${base}/webhooks/revenuecat/${r.id}`);
  console.log(`    Authorization header  ${r.secret}`);
  console.log(`    Environment           Production`);
  console.log(`    cle API              ${r.apiKey ? 'deja enregistree' : 'pas encore (facultatif pour demarrer)'}`);
  console.log('');
}
console.log("Ne recopie aucun de ces secrets dans une conversation : ils n'ont pas a en sortir.\n");
