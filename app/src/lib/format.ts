/**
 * Amount and date formatting.
 *
 * The locale follows the detected language: an amount written "1 234,50 €" in
 * French must read "€1,234.50" in English, otherwise a translated interface
 * would keep foreign typography.
 */
import { intlLocale, t } from '../i18n';

const FULL = new Map<string, Intl.NumberFormat>();

function fullFormatter(currency: string): Intl.NumberFormat {
  const key = currency.toUpperCase();
  let fmt = FULL.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat(intlLocale, {
      style: 'currency',
      currency: key,
      maximumFractionDigits: 0,
    });
    FULL.set(key, fmt);
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

/** Montant complet : « 110 251 € ». */
export function money(cents: number, currency = 'eur'): string {
  return fullFormatter(currency).format(cents / 100);
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
  const symbol = symbolFor(currency);

  // Below 10,000, abbreviating loses more information than it saves in space:
  // "€3,669" reads better than "€3.7k".
  if (abs < 10_000) return fullFormatter(currency).format(units);

  // The decimal separator follows the language: a comma in French, a period in
  // English. Hard-coding it produced "131,7 k€" in an English interface.
  const decimals = (value: number, digits: number) =>
    new Intl.NumberFormat(intlLocale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);

  if (abs < 1_000_000) {
    return `${sign}${decimals(abs / 1000, 1)}\u202fk${symbol}`;
  }

  return `${sign}${decimals(abs / 1_000_000, 2)}\u202fM${symbol}`;
}

/** Amount with cents, for individual event rows. */
export function moneyPrecise(cents: number, currency = 'eur'): string {
  return new Intl.NumberFormat(intlLocale, {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

/** Signed delta: "+€9,701" / "−€251". */
export function signed(cents: number, currency = 'eur'): string {
  const sign = cents > 0 ? '+' : cents < 0 ? '−' : '';
  return `${sign}${money(Math.abs(cents), currency)}`;
}

export function percent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${new Intl.NumberFormat(intlLocale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(Math.abs(value))} %`;
}

/** Compact elapsed time: "just now", "12 min", "3 h", "5 d". */
export function timeAgo(unixSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 45) return t('justNow');
  // Between 45 and 59 seconds the division floors to zero, and "0 min" is meaningless.
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))} ${t('minutesShort')}`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)} ${t('hoursShort')}`;
  if (diff < 604_800) return `${Math.floor(diff / 86_400)} ${t('daysShort')}`;

  return new Date(unixSeconds * 1000).toLocaleDateString(intlLocale, {
    day: 'numeric',
    month: 'short',
  });
}

export function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString(intlLocale, {
    day: 'numeric',
    month: 'short',
  });
}

export function monthLabel(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y!, m! - 1, 1)
    .toLocaleDateString(intlLocale, { month: 'short' })
    .replace('.', '');
}

/** Displayable customer name, falling back to email then a neutral label. */
export function customerLabel(name: string | null, email: string | null): string {
  return name ?? email?.split('@')[0] ?? t('customer');
}
