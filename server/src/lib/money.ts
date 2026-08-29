import { db } from '../db/index.js';
import { config } from '../config.js';

/**
 * Devises sans sous-unité chez Stripe : le montant est déjà l'unité entière
 * (1000 JPY = 1000, pas 10,00). On les normalise en "centimes" internes en
 * multipliant par 100 pour garder une arithmétique unique dans toute la base.
 */
const ZERO_DECIMAL = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

/** Filet de sécurité si l'API de taux est injoignable au premier démarrage. */
const FALLBACK_RATES: Record<string, number> = {
  eur: 1, usd: 0.92, gbp: 1.17, chf: 1.06, cad: 0.68,
  aud: 0.61, jpy: 0.0061, sek: 0.087, nok: 0.086, dkk: 0.134,
  pln: 0.23, brl: 0.17, inr: 0.011, mxn: 0.05, sgd: 0.69,
};

/** Convertit un montant Stripe brut en centimes internes. */
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

/** Convertit des centimes internes vers la devise de consolidation. */
export function toBaseCents(cents: number, currency: string): number {
  return Math.round(cents * rateFor(currency));
}

/**
 * Ramène un montant récurrent au mois, quelle que soit la périodicité Stripe.
 * Un abonnement annuel à 1200 € pèse 100 € de MRR.
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
 * Rafraîchit les taux depuis Frankfurter (API publique, sans clé).
 * Un échec n'est jamais bloquant : on conserve le cache existant.
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
    if (!body.rates) throw new Error('réponse sans taux');

    const now = Math.floor(Date.now() / 1000);
    const upsert = db.prepare(`
      INSERT INTO fx_rates (currency, rate, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(currency) DO UPDATE SET rate = excluded.rate, updated_at = excluded.updated_at
    `);

    db.transaction(() => {
      upsert.run(config.baseCurrency, 1, now);
      for (const [code, rate] of Object.entries(body.rates!)) {
        // L'API donne base -> devise ; on stocke l'inverse (devise -> base).
        if (rate > 0) upsert.run(code.toLowerCase(), 1 / rate, now);
      }
    })();
  } catch (err) {
    console.warn(
      `[fx] could not refresh rates, keeping cache: ${(err as Error).message}`,
    );
  }
}
