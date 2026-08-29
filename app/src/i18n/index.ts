import { getLocales } from 'expo-localization';
import { en, fr, type Strings } from './strings';

/**
 * Sélection de la langue.
 *
 * L'anglais est la langue par défaut — c'est celle d'un projet public — et le
 * français s'applique si le téléphone est réglé ainsi. La détection a lieu une
 * fois au chargement : changer la langue du système redémarre l'application de
 * toute façon.
 */
const TABLES: Record<string, Strings> = { en, fr };

function detect(): { code: string; strings: Strings } {
  try {
    const code = getLocales()[0]?.languageCode?.toLowerCase() ?? 'en';
    return { code, strings: TABLES[code] ?? en };
  } catch {
    return { code: 'en', strings: en };
  }
}

const detected = detect();

export const locale = detected.code;
export const isFrench = detected.code === 'fr';

/** Étiquette de langue pour `Intl`, à laquelle se conforme tout le formatage. */
export const intlLocale = isFrench ? 'fr-FR' : 'en-US';

/**
 * Traduit une clé, en substituant les marqueurs `{nom}` par les valeurs
 * fournies. Le typage garantit qu'une clé inconnue ne compile pas.
 */
export function t(key: keyof Strings, vars?: Record<string, string | number>): string {
  const template = detected.strings[key] ?? en[key];
  if (!vars) return template;

  return Object.entries(vars).reduce(
    (text, [name, value]) => text.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value)),
    template as string,
  );
}

/** Accord en nombre, limité au pluriel simple qui suffit aux deux langues. */
export function plural(count: number, one: keyof Strings, many: keyof Strings): string {
  return count > 1 ? t(many) : t(one);
}
