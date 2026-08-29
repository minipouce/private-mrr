/**
 * Rejoue un vrai encaissement Stripe sous forme de webhook signé.
 *
 *   npm run replay -- <identifiant-projet>
 *
 * Récupère une facture réelle du compte, en retire la trace locale, puis
 * réémet `invoice.paid` et `charge.succeeded` exactement comme Stripe le ferait.
 * Valide donc le chemin d'ingestion sur des charges utiles authentiques, et
 * surtout la déduplication entre la facture et sa charge.
 */
import 'dotenv/config';
import Stripe from 'stripe';
import { createHmac } from 'node:crypto';
import Database from 'better-sqlite3';

const projectId = process.argv[2] ?? (process.env.PROJECTS ?? '').split(',')[0]?.trim();
if (!projectId) {
  console.error('Usage : npm run replay -- <identifiant-projet>');
  process.exit(1);
}

const prefix = `PROJECT_${projectId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Variable manquante : ${name}`);
    process.exit(1);
  }
  return value;
}

const key = required(`${prefix}_STRIPE_KEY`);
const secret = required(`${prefix}_WEBHOOK_SECRET`);

const port = process.env.PORT ?? '8791';
const url = `http://127.0.0.1:${port}/webhooks/stripe/${projectId}`;
const stripe = new Stripe(key, { maxNetworkRetries: 2 });

function post(type: string, object: unknown) {
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    id: `evt_replay_${now}_${Math.floor(Math.random() * 1e6)}`,
    object: 'event',
    type,
    created: now,
    data: { object },
  });
  const sig = createHmac('sha256', secret).update(`${now}.${payload}`).digest('hex');
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': `t=${now},v1=${sig}` },
    body: payload,
  });
}

// Facture réelle la plus récente, avec son abonnement et son intent.
const invoice = (await stripe.invoices.list({ status: 'paid', limit: 1, expand: ['data.payments'] })).data[0]!;
const raw = invoice as any;
const intent = raw.payments?.data?.[0]?.payment?.payment_intent as string | undefined;

console.log('Facture réelle choisie :', invoice.id);
console.log('  montant       :', (invoice.amount_paid / 100).toFixed(2), invoice.currency);
console.log('  abonnement    :', raw.parent?.subscription_details?.subscription ?? 'aucun');
console.log('  payment intent:', intent ?? 'aucun');

// La charge correspondante, telle que Stripe l'enverrait.
let charge: Stripe.Charge | undefined;
if (intent) {
  for await (const c of stripe.charges.list({ limit: 100 })) {
    if ((c as any).payment_intent === intent && c.paid && c.status === 'succeeded') { charge = c; break; }
  }
}
console.log('  charge liée   :', charge?.id ?? 'aucune');

// On efface la trace laissée par le backfill pour repartir d'un état neutre.
const db = new Database(process.env.DB_PATH ?? './data/real.db');
const before = db.prepare("SELECT COUNT(*) n FROM events WHERE kind='payment'").get() as { n: number };
db.prepare('DELETE FROM events WHERE payment_intent = ?').run(intent ?? '');
const cleaned = db.prepare("SELECT COUNT(*) n FROM events WHERE kind='payment'").get() as { n: number };
console.log(`\nPaiements en base : ${before.n} -> ${cleaned.n} (trace retirée)`);
db.close();

console.log('\n--- 1. invoice.paid ---');
const r1 = await post('invoice.paid', invoice);
console.log('   HTTP', r1.status, await r1.text());
await new Promise((r) => setTimeout(r, 2500));

if (charge) {
  console.log('--- 2. charge.succeeded (même encaissement) ---');
  const r2 = await post('charge.succeeded', charge);
  console.log('   HTTP', r2.status, await r2.text());
  await new Promise((r) => setTimeout(r, 2500));
}

const db2 = new Database(process.env.DB_PATH ?? './data/real.db', { readonly: true });
const after = db2.prepare("SELECT COUNT(*) n FROM events WHERE kind='payment'").get() as { n: number };
const rows = db2
  .prepare("SELECT stripe_object_id, subscription_id, payment_intent, amount_base_cents FROM events WHERE payment_intent = ?")
  .all(intent ?? '') as any[];
console.log(`\nPaiements en base : ${cleaned.n} -> ${after.n}`);
console.log(`Lignes pour cet encaissement : ${rows.length}`);
for (const r of rows) {
  console.log(`  ${r.stripe_object_id} | sub=${r.subscription_id ?? 'NULL'} | ${(r.amount_base_cents / 100).toFixed(2)} €`);
}
console.log(
  rows.length === 1
    ? '\n✅ Un seul enregistrement : la déduplication fonctionne sur données réelles.'
    : `\n❌ ${rows.length} enregistrements — déduplication en échec.`,
);
db2.close();
