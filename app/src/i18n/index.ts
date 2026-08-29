import { getLocales } from 'expo-localization';
import { en, fr, type Strings } from './strings';

/**
 * Language selection.
 *
 * English is the default, as befits a public project, and French applies if the
 * phone is set to it. Detection happens once at load time: changing the system
 * language restarts the application anyway.
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

/** Language tag for `Intl`, which all formatting follows. */
export const intlLocale = isFrench ? 'fr-FR' : 'en-US';

/**
 * Translates a key, substituting `{name}` placeholders with the given values.
 * Typing guarantees an unknown key does not compile.
 */
export function t(key: keyof Strings, vars?: Record<string, string | number>): string {
  const template = detected.strings[key] ?? en[key];
  if (!vars) return template;

  return Object.entries(vars).reduce(
    (text, [name, value]) => text.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value)),
    template as string,
  );
}

/** Number agreement, limited to the simple plural both languages need. */
export function plural(count: number, one: keyof Strings, many: keyof Strings): string {
  return count > 1 ? t(many) : t(one);
}
