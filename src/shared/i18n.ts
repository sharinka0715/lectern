// Localization shared by the renderer, the main process and the backend.
//
// Messages live in src/shared/locales/: one namespace per area, each entry a
// `[中文, English]` pair, so a missing translation fails `tsc`. Keys are typed
// (`t('sidebar.unread')`); tests/i18n.test.ts checks that both languages use
// the same placeholders.
//
// Templates are ICU-lite: `{name}` inserts a parameter, `{n, number}` formats
// it for the locale, `{n, plural, =0 {…} one {# file} other {# files}}` picks a
// plural form (`#` is the number) and `{kind, select, ssh {…} other {…}}` picks
// a branch by value. Braces that do not open such a placeholder (code samples,
// JSON) stay literal.
//
// The current locale is process-wide. The main process sets it at startup and
// when the user switches language; the renderer sets it before its first render.
// It starts as zh-CN, the source language, so unit tests read Chinese.
import { dictionaries } from './locales';

export const locales = ['zh-CN', 'en'] as const;
export type Locale = typeof locales[number];
/** What the user picked in Settings. `system` follows the OS language. */
export type LocalePreference = 'system' | Locale;
export type MessageParams = Record<string, string | number | undefined>;
type Dictionaries = typeof dictionaries;
export type MessageKey = { [N in keyof Dictionaries & string]: `${N}.${keyof Dictionaries[N] & string}` }[keyof Dictionaries & string];

let current: Locale = 'zh-CN';
const listeners = new Set<(locale: Locale) => void>();

export const isLocale = (value: unknown): value is Locale => value === 'zh-CN' || value === 'en';
export const isLocalePreference = (value: unknown): value is LocalePreference => value === 'system' || isLocale(value);
export const getLocale = (): Locale => current;
/** BCP 47 tag for Intl and `<html lang>`. */
export const localeTag = (locale: Locale = current) => locale === 'zh-CN' ? 'zh-CN' : 'en-US';

export function setLocale(locale: Locale) {
  if (!isLocale(locale) || locale === current) return;
  current = locale;
  // One failing listener must not keep the others from switching.
  for (const listener of [...listeners]) {
    try { listener(locale); } catch (error) { console.error('Locale listener failed', error); }
  }
}

export function onLocaleChange(listener: (locale: Locale) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * The app language for an OS language tag. Every Chinese variant (zh-CN, zh-TW,
 * zh-HK, zh-Hant…) maps to Simplified Chinese, the only Chinese we ship:
 * Traditional readers generally read it more easily than English.
 */
export function localeForLanguage(tag: string | undefined): Locale | undefined {
  const language = tag?.trim().toLowerCase().replace(/_/g, '-').split(/[-.@]/)[0];
  if (!language || language === 'c' || language === 'posix') return undefined;
  return language === 'zh' ? 'zh-CN' : 'en';
}

/** The app language for the OS's preferred languages: Chinese → zh-CN, anything else → en. */
export function systemLocale(preferred: readonly (string | undefined)[]): Locale {
  for (const tag of preferred) {
    const locale = localeForLanguage(tag);
    if (locale) return locale;
  }
  return 'en';
}

/** Startup language: a valid LECTERN_LOCALE wins, then the saved choice, then the OS. */
export function resolveLocale(options: { env?: string; preference?: unknown; system: Locale }): Locale {
  if (isLocale(options.env)) return options.env;
  if (isLocale(options.preference)) return options.preference;
  return options.system;
}

/** The message for `key` in the current locale. Unknown keys return the key itself. */
export function t(key: MessageKey, params?: MessageParams): string {
  return translate(current, key, params);
}

export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  const dot = key.indexOf('.');
  const space = (dictionaries as unknown as Record<string, Record<string, readonly [string, string]> | undefined>)[key.slice(0, dot)];
  const entry = space?.[key.slice(dot + 1)];
  if (!entry) return key;
  const template = (locale === 'en' ? entry[1] : entry[0]) || entry[0];
  return template.includes('{') ? formatMessage(template, params ?? {}, locale) : template;
}

/** Every translation of `key`, for matching text that may come from either language. */
export function allTranslations(key: MessageKey, params?: MessageParams): string[] {
  return locales.map(locale => translate(locale, key, params));
}

/** Items in a running sentence: 「a、b」 in Chinese, "a, b" in English. */
export function joinList(items: readonly string[], locale: Locale = current): string {
  return items.join(locale === 'en' ? ', ' : '、');
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions, locale: Locale = current): string {
  return new Intl.NumberFormat(localeTag(locale), options).format(value);
}

/** The index of the brace closing the one at `open`, or -1. */
function closing(text: string, open: number): number {
  for (let depth = 0, i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

/** `one {…} other {…}` → a map from selector to branch text. */
function branches(text: string): Map<string, string> {
  const result = new Map<string, string>();
  const pattern = /\s*(=?[\w-]+)\s*\{/y;
  for (let i = 0; i < text.length;) {
    pattern.lastIndex = i;
    const match = pattern.exec(text);
    if (!match) break;
    const open = pattern.lastIndex - 1, end = closing(text, open);
    if (end < 0) break;
    result.set(match[1], text.slice(open + 1, end));
    i = end + 1;
  }
  return result;
}

const placeholder = /^\s*([A-Za-z_]\w*)\s*(?:,\s*(plural|select|number)\s*(?:,([\s\S]*))?)?$/;

/** Fills an ICU-lite template (see the header) with `params`. */
export function formatMessage(template: string, params: MessageParams, locale: Locale = current): string {
  let out = '';
  for (let i = 0; i < template.length;) {
    const open = template.indexOf('{', i);
    const end = open < 0 ? -1 : closing(template, open);
    const match = end < 0 ? null : placeholder.exec(template.slice(open + 1, end));
    if (!match) {
      // Not a placeholder: copy through the brace (or the rest) literally.
      const stop = open < 0 ? template.length : open + 1;
      out += template.slice(i, stop);
      i = stop;
      continue;
    }
    out += template.slice(i, open);
    const [, name, kind, rest] = match, value = params[name];
    if (!kind) out += value === undefined ? `{${name}}` : String(value);
    else if (kind === 'number') out += typeof value === 'number' ? formatNumber(value, undefined, locale) : String(value ?? '');
    else {
      const options = branches(rest ?? '');
      const n = Number(value);
      const branch = kind === 'plural'
        ? (options.get(`=${n}`) ?? options.get(new Intl.PluralRules(localeTag(locale)).select(n)) ?? options.get('other'))?.replace(/#/g, String(value))
        : options.get(String(value)) ?? options.get('other');
      out += formatMessage(branch ?? '', params, locale);
    }
    i = end + 1;
  }
  return out;
}

/** Parameter names a template uses, including plural/select arguments. */
export function placeholders(template: string): string[] {
  const names = new Set<string>();
  for (let i = 0; i < template.length;) {
    const open = template.indexOf('{', i);
    if (open < 0) break;
    const end = closing(template, open);
    const match = end < 0 ? null : placeholder.exec(template.slice(open + 1, end));
    if (!match) { i = open + 1; continue; }
    names.add(match[1]);
    if (match[2] === 'plural' || match[2] === 'select') {
      for (const branch of branches(match[3] ?? '').values()) for (const name of placeholders(branch)) names.add(name);
    }
    i = end + 1;
  }
  return [...names].sort();
}

/** Date and time the way `Date#toLocaleString` shows them in the current language. */
export function dateTimeText(value: Date | number | string, options?: Intl.DateTimeFormatOptions, locale: Locale = current): string {
  return new Date(value).toLocaleString(localeTag(locale), options);
}
