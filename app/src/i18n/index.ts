import { getLocales } from 'expo-localization';
import * as SecureStore from 'expo-secure-store';
import { en, fr, type Strings } from './strings';

/**
 * Language selection.
 *
 * Three settings: `auto` follows the phone, `en` and `fr` force a language.
 * English is the fallback, as befits a public project.
 *
 * The preference is read synchronously at load because `t()` is a plain
 * function, called at module scope in several files rather than through a hook.
 * `SecureStore.getItem` is the only synchronous storage the app already
 * depends on, which avoids both an extra dependency and a first paint in the
 * wrong language.
 */
export type LanguagePref = 'auto' | 'en' | 'fr';

const KEY = 'mrr.language';
const TABLES: Record<string, Strings> = { en, fr };

/** Language the phone itself is set to, or English if it cannot be read. */
function deviceCode(): string {
  try {
    return getLocales()[0]?.languageCode?.toLowerCase() ?? 'en';
  } catch {
    return 'en';
  }
}

function readPref(): LanguagePref {
  try {
    const stored = SecureStore.getItem(KEY);
    return stored === 'en' || stored === 'fr' || stored === 'auto' ? stored : 'auto';
  } catch {
    // Storage unavailable (headless widget task, locked device): follow the
    // phone rather than fail.
    return 'auto';
  }
}

function resolve(pref: LanguagePref): string {
  const code = pref === 'auto' ? deviceCode() : pref;
  return TABLES[code] ? code : 'en';
}

let pref: LanguagePref = readPref();
let code: string = resolve(pref);
let strings: Strings = TABLES[code] ?? en;

const listeners = new Set<() => void>();

/** The setting itself, as chosen: `auto`, `en` or `fr`. */
export function languagePref(): LanguagePref {
  return pref;
}

/** The language actually in force once `auto` is resolved. */
export function activeLanguage(): string {
  return code;
}

/**
 * Language tag for `Intl`, which all formatting follows.
 *
 * A function rather than a constant: the value changes when the setting does,
 * and an exported constant would keep every caller on the startup language.
 */
export function intlLocale(): string {
  return code === 'fr' ? 'fr-FR' : 'en-US';
}

/**
 * Changes the language and notifies the interface.
 *
 * Persisting can fail on a locked device, so the in-memory switch happens
 * regardless: the language then applies for this session and is simply not
 * remembered, which beats appearing to ignore the tap.
 */
export function setLanguage(next: LanguagePref): void {
  if (next === pref) return;

  pref = next;
  code = resolve(next);
  strings = TABLES[code] ?? en;

  try {
    SecureStore.setItem(KEY, next);
  } catch {
    // Ignored on purpose, see above.
  }

  for (const listener of listeners) listener();
}

/** Subscribes to language changes. Returns the unsubscribe function. */
export function onLanguageChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Translates a key, substituting `{name}` placeholders with the given values.
 * Typing guarantees an unknown key does not compile.
 */
export function t(key: keyof Strings, vars?: Record<string, string | number>): string {
  const template = strings[key] ?? en[key];
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
