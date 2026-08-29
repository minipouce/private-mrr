/**
 * Renders every notification in both languages, without sending anything.
 *
 *   npm run check-i18n
 *
 * Translating notification copy is easy to get subtly wrong, and the only way
 * to see the result is normally to wait for a real payment. This prints what
 * each event kind produces, so a missing string or a mangled amount shows up
 * immediately.
 */
import { compose, type Locale } from '../push/index.js';
import type { EventRow } from '../db/repo.js';

const LOCALES: Locale[] = ['en', 'fr'];

function sample(overrides: Partial<EventRow>): EventRow {
  return {
    id: 1,
    project_id: 'demo',
    stripe_event_id: 'evt_test',
    stripe_object_id: 'in_test',
    kind: 'payment',
    amount_cents: 4900,
    currency: 'eur',
    amount_base_cents: 4900,
    mrr_delta_cents: 0,
    customer_id: 'cus_test',
    customer_email: 'ada@example.com',
    customer_name: 'Ada Lovelace',
    subscription_id: 'sub_test',
    payment_intent: 'pi_test',
    billing_reason: null,
    description: null,
    occurred_at: 0,
    created_at: 0,
    ...overrides,
  } as EventRow;
}

const CASES: { label: string; event: EventRow }[] = [
  { label: 'first payment', event: sample({ billing_reason: 'subscription_create' }) },
  { label: 'renewal', event: sample({ billing_reason: 'subscription_cycle' }) },
  { label: 'one-off payment', event: sample({ subscription_id: null, billing_reason: null }) },
  { label: 'new subscriber', event: sample({ kind: 'subscription_created', mrr_delta_cents: 4900 }) },
  { label: 'trial started', event: sample({ kind: 'trial_started' }) },
  { label: 'upgrade', event: sample({ kind: 'subscription_updated', mrr_delta_cents: 2000 }) },
  { label: 'downgrade', event: sample({ kind: 'subscription_updated', mrr_delta_cents: -1500 }) },
  { label: 'cancellation', event: sample({ kind: 'subscription_canceled', mrr_delta_cents: -4900 }) },
  { label: 'payment failed', event: sample({ kind: 'payment_failed' }) },
  { label: 'refund', event: sample({ kind: 'refund', amount_base_cents: -4900 }) },
];

let missing = 0;

for (const { label, event } of CASES) {
  console.log(`\n\x1b[1m${label}\x1b[0m`);
  for (const locale of LOCALES) {
    const content = compose(event, 'Buska', locale);
    if (!content) {
      console.log(`  ${locale}  \x1b[31m(no notification)\x1b[0m`);
      missing += 1;
      continue;
    }
    console.log(`  ${locale}  ${content.title}`);
    console.log(`      ${content.body}`);
  }
}

console.log(
  missing === 0
    ? '\n\x1b[32mEvery event produces copy in both languages.\x1b[0m'
    : `\n\x1b[31m${missing} case(s) produced nothing.\x1b[0m`,
);
process.exit(missing === 0 ? 0 : 1);
