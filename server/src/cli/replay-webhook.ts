/**
 * Replays a real Stripe payment as a signed webhook.
 *
 *   npm run replay -- <project-id>
 *
 * Fetches a genuine invoice from the account, removes its local row, then
 * re-emits `invoice.paid` and `charge.succeeded` exactly as Stripe would. This
 * exercises the ingestion path on authentic payloads, and above all the
 * deduplication between an invoice and its charge.
 */
import 'dotenv/config';
import Stripe from 'stripe';
import { createHmac } from 'node:crypto';
import Database from 'better-sqlite3';

const projectId = process.argv[2] ?? (process.env.PROJECTS ?? '').split(',')[0]?.trim();
if (!projectId) {
  console.error('Usage: npm run replay -- <project-id>');
  process.exit(1);
}

const prefix = `PROJECT_${projectId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing variable: ${name}`);
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

// Most recent real invoice, with its subscription and payment intent.
const invoice = (await stripe.invoices.list({ status: 'paid', limit: 1, expand: ['data.payments'] })).data[0]!;
const raw = invoice as any;
const intent = raw.payments?.data?.[0]?.payment?.payment_intent as string | undefined;

console.log('Real invoice selected:', invoice.id);
console.log('  amount        :', (invoice.amount_paid / 100).toFixed(2), invoice.currency);
console.log('  subscription  :', raw.parent?.subscription_details?.subscription ?? 'aucun');
console.log('  payment intent:', intent ?? 'none');

// The matching charge, as Stripe would send it.
let charge: Stripe.Charge | undefined;
if (intent) {
  for await (const c of stripe.charges.list({ limit: 100 })) {
    if ((c as any).payment_intent === intent && c.paid && c.status === 'succeeded') { charge = c; break; }
  }
}
console.log('  linked charge :', charge?.id ?? 'none');

// Clear the row left by the backfill to start from a neutral state.
const db = new Database(process.env.DB_PATH ?? './data/real.db');
const before = db.prepare("SELECT COUNT(*) n FROM events WHERE kind='payment'").get() as { n: number };
db.prepare('DELETE FROM events WHERE payment_intent = ?').run(intent ?? '');
const cleaned = db.prepare("SELECT COUNT(*) n FROM events WHERE kind='payment'").get() as { n: number };
console.log(`\nPayments in database: ${before.n} -> ${cleaned.n} (existing row removed)`);
db.close();

console.log('\n--- 1. invoice.paid ---');
const r1 = await post('invoice.paid', invoice);
console.log('   HTTP', r1.status, await r1.text());
await new Promise((r) => setTimeout(r, 2500));

if (charge) {
  console.log('--- 2. charge.succeeded (same payment) ---');
  const r2 = await post('charge.succeeded', charge);
  console.log('   HTTP', r2.status, await r2.text());
  await new Promise((r) => setTimeout(r, 2500));
}

const db2 = new Database(process.env.DB_PATH ?? './data/real.db', { readonly: true });
const after = db2.prepare("SELECT COUNT(*) n FROM events WHERE kind='payment'").get() as { n: number };
const rows = db2
  .prepare("SELECT stripe_object_id, subscription_id, payment_intent, amount_base_cents FROM events WHERE payment_intent = ?")
  .all(intent ?? '') as any[];
console.log(`\nPayments in database: ${cleaned.n} -> ${after.n}`);
console.log(`Rows for this payment: ${rows.length}`);
for (const r of rows) {
  console.log(`  ${r.stripe_object_id} | sub=${r.subscription_id ?? 'NULL'} | ${(r.amount_base_cents / 100).toFixed(2)} €`);
}
console.log(
  rows.length === 1
    ? '\n✅ A single row: deduplication works on real data.'
    : `\n❌ ${rows.length} rows: deduplication failed.`,
);
db2.close();
