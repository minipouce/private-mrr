import { db } from '../db/index.js';
import { config } from '../config.js';

/**
 * Zero-decimal currencies in Stripe: the amount is already the whole unit
 * (1000 JPY means 1000, not 10.00). They are normalised into internal "cents"
 * by multiplying by 100, so a single arithmetic holds across the database.
 */
const ZERO_DECIMAL = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

/** Safety net if the rates API is unreachable on first boot. */
const FALLBACK_RATES: Record<string, number> = {
  eur: 1, usd: 0.92, gbp: 1.17, chf: 1.06, cad: 0.68,
  aud: 0.61, jpy: 0.0061, sek: 0.087, nok: 0.086, dkk: 0.134,
  pln: 0.23, brl: 0.17, inr: 0.011, mxn: 0.05, sgd: 0.69,
};

/** Converts a raw Stripe amount into internal cents. */
export function toInternalCents(stripeAmount: number, currency: string): number {
  return ZERO_DECIMAL.has(currency.toLowerCase())
    ? Math.round(stripeAmount * 100)
    : Math.round(stripeAmount);
}

function rateFor(currency: string): number {
  const code = currency.toLowerCase();
  if (code === config.baseCurrency) return 1;

  const row = db
    .prepare('SELECT rate FROM fx_rates WHERE currency = ?')
    .get(code) as { rate: number } | undefined;
  if (row) return row.rate;

  return FALLBACK_RATES[code] ?? 1;
}

/** Converts internal cents into the base currency. */
export function toBaseCents(cents: number, currency: string): number {
  return Math.round(cents * rateFor(currency));
}

/**
 * Normalises a recurring amount to a month, whatever the Stripe interval.
 * A yearly subscription at 1200 EUR weighs 100 EUR of MRR.
 */
export function monthlyNormalized(
  amountCents: number,
  interval: string,
  intervalCount: number,
  quantity = 1,
): number {
  const total = amountCents * Math.max(quantity, 1);
  const count = Math.max(intervalCount, 1);

  switch (interval) {
    case 'day':   return Math.round((total * 30.44) / count);
    case 'week':  return Math.round((total * 4.348) / count);
    case 'month': return Math.round(total / count);
    case 'year':  return Math.round(total / (12 * count));
    default:      return Math.round(total / count);
  }
}

/**
 * Refreshes rates from Frankfurter (public API, no key required).
 * Failure is never fatal: the existing cache is kept.
 */
export async function refreshRates(): Promise<void> {
  const base = config.baseCurrency.toUpperCase();
  const symbols = Object.keys(FALLBACK_RATES)
    .filter((c) => c !== config.baseCurrency)
    .map((c) => c.toUpperCase())
    .join(',');

  try {
    const res = await fetch(
      `https://api.frankfurter.app/latest?base=${base}&symbols=${symbols}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = (await res.json()) as { rates?: Record<string, number> };
    if (!body.rates) throw new Error('response contained no rates');

    const now = Math.floor(Date.now() / 1000);
    const upsert = db.prepare(`
      INSERT INTO fx_rates (currency, rate, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(currency) DO UPDATE SET rate = excluded.rate, updated_at = excluded.updated_at
    `);

    db.transaction(() => {
      upsert.run(config.baseCurrency, 1, now);
      for (const [code, rate] of Object.entries(body.rates!)) {
        // The API returns base -> currency; we store the inverse.
        if (rate > 0) upsert.run(code.toLowerCase(), 1 / rate, now);
      }
    })();
  } catch (err) {
    console.warn(
      `[fx] could not refresh rates, keeping cache: ${(err as Error).message}`,
    );
  }
}
