/**
 * Formatage des montants et des dates.
 *
 * La locale suit la langue détectée : un montant écrit « 1 234,50 € » en
 * français doit se lire « €1,234.50 » en anglais, sans quoi l'interface
 * traduite garderait une typographie étrangère.
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
 * Montant abrégé : « 128,7 k€ », « 1,34 M€ ».
 *
 * Hermes n'implémente pas `Intl.NumberFormat` en notation compacte — la
 * demander produit silencieusement un nombre non abrégé. On calcule donc les
 * paliers nous-mêmes plutôt que de dépendre du moteur d'exécution.
 */
export function moneyCompact(cents: number, currency = 'eur'): string {
  const units = cents / 100;
  const abs = Math.abs(units);
  const sign = units < 0 ? '\u2212' : '';
  const symbol = symbolFor(currency);

  // En dessous de 10 000, abréger ferait perdre plus d'information qu'il n'en
  // ferait gagner en place : « 3 669 € » se lit mieux que « 3,7 k€ ».
  if (abs < 10_000) return fullFormatter(currency).format(units);

  // Le séparateur décimal suit la langue : une virgule en français, un point
  // en anglais. Le coder en dur donnait « 131,7 k€ » dans une interface anglaise.
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

/** Montant avec centimes, pour les lignes d'événement individuelles. */
export function moneyPrecise(cents: number, currency = 'eur'): string {
  return new Intl.NumberFormat(intlLocale, {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

/** Delta signé : « +9 701 € » / « −251 € ». */
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

/** Temps écoulé, compact : « à l'instant », « 12 min », « 3 h », « 5 j ». */
export function timeAgo(unixSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 45) return t('justNow');
  // Entre 45 et 59 secondes, la division tomberait à zéro : « 0 min » n'a aucun sens.
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

/** Nom affichable d'un client, avec repli sur l'e-mail puis un libellé neutre. */
export function customerLabel(name: string | null, email: string | null): string {
  return name ?? email?.split('@')[0] ?? t('customer');
}
