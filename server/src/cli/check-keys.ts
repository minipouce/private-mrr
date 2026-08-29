import 'dotenv/config';
import { config } from '../config.js';
import { stripeFor } from '../stripe/client.js';

/**
 * Vérifie que chaque clé donne accès aux quatre ressources dont l'application a
 * besoin — et à elles seules. Une clé qui échoue ici manque d'une permission ;
 * une clé qui passe est suffisante, inutile de lui en accorder davantage.
 */
const PROBES = [
  ['Subscriptions', (s: any) => s.subscriptions.list({ limit: 1 })],
  ['Invoices', (s: any) => s.invoices.list({ limit: 1 })],
  ['Charges', (s: any) => s.charges.list({ limit: 1 })],
  ['Customers', (s: any) => s.customers.list({ limit: 1 })],
] as const;

let failures = 0;

for (const project of config.projects) {
  const stripe = stripeFor(project);
  if (!stripe) {
    console.log(`  ${project.id.padEnd(12)} ⚠️  pas de clé`);
    failures++;
    continue;
  }

  const missing: string[] = [];
  for (const [label, probe] of PROBES) {
    try {
      await probe(stripe);
    } catch (err) {
      const message = (err as Error).message;
      missing.push(/permission/i.test(message) ? label : `${label} (${message.slice(0, 40)})`);
    }
  }

  if (missing.length === 0) {
    console.log(`  ${project.id.padEnd(12)} ✓ les 4 permissions requises sont présentes`);
  } else {
    console.log(`  ${project.id.padEnd(12)} ✗ manque : ${missing.join(', ')}`);
    failures++;
  }
}

console.log(failures === 0 ? '\nToutes les clés sont exploitables.' : `\n${failures} clé(s) à corriger.`);
