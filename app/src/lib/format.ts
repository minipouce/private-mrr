/**
 * Amount and date formatting.
 *
 * The locale follows the detected language: an amount written "1 234,50 €" in
 * French must read "€1,234.50" in English, otherwise a translated interface
 * would keep foreign typography.
 */
import { intlLocale, t } from '../i18n';

// Keyed by language and precision as well as currency: a cache keyed on
// currency alone would keep serving the formatter built at startup after a
// language change, and the two precisions have to coexist.
const FORMATTERS = new Map<string, Intl.NumberFormat>();

function formatter(currency: string, digits: 0 | 2): Intl.NumberFormat {
  const code = currency.toUpperCase();
  const key = `${intlLocale()}:${code}:${digits}`;
  let fmt = FORMATTERS.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat(intlLocale(), {
      style: 'currency',
      currency: code,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    FORMATTERS.set(key, fmt);
  }
  return fmt;
}

const SYMBOLS: Record<string, string> = {
  EUR: '\u20ac', USD: '$', GBP: '\u00a3', CHF: 'CHF', CAD: '$CA', JPY: '\u00a5',
};

function symbolFor(currency: string): string {
  const key = currency.toUpperCase();
  return SYMBOLS[key] ?? key;
}

/**
 * Whether the currency symbol leads the number in the active language.
 *
 * Asked of `Intl` rather than hard-coded, by formatting a probe and looking at
 * what comes first. English writes "€99.9k" and French "99,9 k€"; deciding this
 * by testing for French would need editing every time a language is added.
 */
function symbolLeads(currency: string): boolean {
  const probe = formatter(currency, 0).format(1).trim();
  return !/^[\d\u2212+-]/.test(probe);
}

/** Assembles an abbreviated amount, placing the symbol as the language wants. */
function assemble(sign: string, digits: string, scale: string, currency: string): string {
  const symbol = symbolFor(currency);
  return symbolLeads(currency)
    ? `${sign}${symbol}${digits}${scale}`
    : `${sign}${digits}\u202f${scale}${symbol}`;
}

/**
 * Exact amount, with cents only when there are any: "€2,279.75", "€27,357".
 *
 * Rounding to the unit was losing real money on screen: a $49 payment converts
 * to 42.09 € and was displayed "42 €", and above 50 cents the rounding went the
 * other way and announced more than was collected. Cents are therefore shown
 * whenever they are non-zero — and dropped when they are, so a round amount
 * stays as short as it was.
 *
 * Reserved for figures that are exact by nature (MRR, cash collected, an MRR
 * movement). Estimates go through `moneyRounded`.
 */
export function money(cents: number, currency = 'eur'): string {
  return formatter(currency, cents % 100 === 0 ? 0 : 2).format(cents / 100);
}

/**
 * Deliberately rounded amount, for a figure whose cents mean nothing: a
 * projection, a goal, a notification threshold.
 */
export function moneyRounded(cents: number, currency = 'eur'): string {
  return formatter(currency, 0).format(cents / 100);
}

/**
 * Abbreviated amount: "€128.7k", "€1.34M".
 *
 * Hermes does not implement `Intl.NumberFormat` compact notation: asking for it
 * silently returns an unabbreviated number. The thresholds are therefore
 * computed here rather than relying on the runtime.
 */
export function moneyCompact(cents: number, currency = 'eur'): string {
  const units = cents / 100;
  const abs = Math.abs(units);
  const sign = units < 0 ? '\u2212' : '';

  // Below 10,000, abbreviating loses more information than it saves in space:
  // "€3,669" reads better than "€3.7k". Rounded, like the abbreviation itself:
  // this family is the glanceable one, cents belong to `money`.
  if (abs < 10_000) return formatter(currency, 0).format(units);

  // The decimal separator follows the language: a comma in French, a period in
  // English. Hard-coding it produced "131,7 k€" in an English interface.
  const decimals = (value: number, digits: number) =>
    new Intl.NumberFormat(intlLocale(), {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);

  if (abs < 1_000_000) {
    return assemble(sign, decimals(abs / 1000, 1), 'k', currency);
  }

  return assemble(sign, decimals(abs / 1_000_000, 2), 'M', currency);
}

/** Amount with cents, for individual event rows. */
export function moneyPrecise(cents: number, currency = 'eur'): string {
  return formatter(currency, 2).format(cents / 100);
}

/** Signed delta: "+€9,701" / "−€251". */
export function signed(cents: number, currency = 'eur'): string {
  const sign = cents > 0 ? '+' : cents < 0 ? '−' : '';
  return `${sign}${money(Math.abs(cents), currency)}`;
}

/**
 * Plain percentage, spaced as the language wants: "26.0%" in English, "26,0 %"
 * in French. For a rate, not a variation — `percentSigned` carries the sign.
 */
export function percentPlain(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(intlLocale(), {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value / 100);
}

/**
 * Signed percentage, spaced as the language wants: "+3.5%" in English, "+3,5 %"
 * in French. `style: 'percent'` carries that rule, so the value is divided by
 * 100 to feed it a ratio rather than appending the sign by hand.
 */
export function percent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${new Intl.NumberFormat(intlLocale(), {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(Math.abs(value) / 100)}`;
}

/** Compact elapsed time: "just now", "12 min", "3 h", "5 d". */
export function timeAgo(unixSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 45) return t('justNow');
  // Between 45 and 59 seconds the division floors to zero, and "0 min" is meaningless.
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))} ${t('minutesShort')}`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)} ${t('hoursShort')}`;
  if (diff < 604_800) return `${Math.floor(diff / 86_400)} ${t('daysShort')}`;

  return new Date(unixSeconds * 1000).toLocaleDateString(intlLocale(), {
    day: 'numeric',
    month: 'short',
  });
}

export function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString(intlLocale(), {
    day: 'numeric',
    month: 'short',
  });
}

export function monthLabel(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y!, m! - 1, 1)
    .toLocaleDateString(intlLocale(), { month: 'short' })
    .replace('.', '');
}

/** Displayable customer name, falling back to email then a neutral label. */
export function customerLabel(name: string | null, email: string | null): string {
  return name ?? email?.split('@')[0] ?? t('customer');
}
