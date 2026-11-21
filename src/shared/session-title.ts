import { t } from './i18n';
/** A single-line native name. Claude normalizes formatting characters and
 * measures its 200-character limit in Unicode code points. */
export function normalizeSessionTitle(value: string): string {
  if (typeof value !== 'string') throw new Error(t('shared.titleRequired'));
  if (/[\p{Cc}\p{Cs}\u2028\u2029]/u.test(value)) {
    throw new Error(t('shared.titleSingleLine'));
  }
  const title = value.replace(/\p{Cf}+/gu, ' ').trim();
  if (!title) throw new Error(t('shared.titleRequired'));
  if ([...title].length > 200) throw new Error(t('shared.titleTooLong'));
  return title;
}
