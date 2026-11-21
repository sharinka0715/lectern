import { Fragment, useSyncExternalStore, type ReactNode } from 'react';
import { getLocale, localeTag, onLocaleChange, setLocale, t, type Locale, type MessageKey, type MessageParams } from '../shared/i18n';

export { t };

/** The current language; the calling component re-renders when it changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(onLocaleChange, getLocale, getLocale);
}

/** Shows this window in `locale`: messages, Intl formatting and `<html lang>`. */
export function applyLocale(locale: Locale) {
  setLocale(locale);
  document.documentElement.lang = localeTag(locale);
}

/**
 * A message with React elements in it: `rich('app.noPanes', { command: <code>…</code> })`
 * fills `{command}` with the element. Plain `params` fill the other placeholders.
 */
export function rich(key: MessageKey, nodes: Record<string, ReactNode>, params?: MessageParams): ReactNode[] {
  const marks = Object.fromEntries(Object.keys(nodes).map(name => [name, `\u0000${name}\u0000`]));
  return t(key, { ...params, ...marks }).split('\u0000').map((part, i) => i % 2 ? <Fragment key={i}>{nodes[part]}</Fragment> : part);
}
