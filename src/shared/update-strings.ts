// Texts of the update check. They live in the i18n dictionary (locales/update.ts);
// this module keeps the update code's small API on top of it.
import { getLocale, translate, type Locale, type MessageKey } from './i18n';
import { update } from './locales/update';

export type UpdateTextKey = keyof typeof update;

const column = (index: 0 | 1) =>
  Object.fromEntries(Object.entries(update).map(([key, entry]) => [key, entry[index]])) as Record<UpdateTextKey, string>;

/** Both languages side by side, for tests that compare placeholders. */
export const updateStrings = { zh: column(0), en: column(1) };

/** 'en' for English locales, otherwise Chinese (the app's default language). */
export const updateLanguage = (locale?: string) => (locale && /^en\b/i.test(locale) ? 'en' : 'zh');

/** The text in `locale`, or in the app's current language when no locale is given. */
export function updateText(locale: string | undefined, key: UpdateTextKey, values: Record<string, string | number> = {}): string {
  const target: Locale = locale === undefined ? getLocale() : updateLanguage(locale) === 'en' ? 'en' : 'zh-CN';
  return translate(target, `update.${key}` as MessageKey, values);
}
