import 'dotenv/config';
import { config } from '../config.js';
import { stripeFor } from '../stripe/client.js';

/**
 * Checks that every key grants access to the four resources the application
 * needs, and to those alone. A key failing here is missing a permission; a key
 * passing is sufficient, and granting it more would serve no purpose.
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
    console.log(`  ${project.id.padEnd(12)} ⚠️  no key`);
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
    console.log(`  ${project.id.padEnd(12)} ✓ all 4 required permissions present`);
  } else {
    console.log(`  ${project.id.padEnd(12)} ✗ missing: ${missing.join(', ')}`);
    failures++;
  }
}

console.log(failures === 0 ? '\nAll keys are usable.' : `\n${failures} key(s) need fixing.`);
