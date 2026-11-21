import { app } from 'electron';
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getLocale, isLocalePreference, localeTag, resolveLocale, setLocale, systemLocale, type Locale, type LocalePreference } from '../shared/i18n';
import type { LocaleState } from '../shared/types';

// The language choice lives in the main process: the application menu, native
// dialogs and backend errors need it before any window exists. It is saved in
// userData/locale-settings.json as { "preference": "system" | "zh-CN" | "en" }.
let preference: LocalePreference = 'system';
let system: Locale = 'en';
let saving: Promise<void> = Promise.resolve();

const directory = () => app.getPath('userData');
const settingsFile = () => path.join(directory(), 'locale-settings.json');

/** The OS's preferred languages, most preferred first. */
function osLanguages(): string[] {
  try {
    const preferred = app.getPreferredSystemLanguages();
    if (preferred.length) return preferred;
  } catch { /* Fall back to the POSIX locale variables. */ }
  const env = process.env;
  return [env.LANGUAGE?.split(':')[0], env.LC_ALL, env.LC_MESSAGES, env.LANG].filter((tag): tag is string => !!tag);
}

/**
 * Picks the startup language before `ready`: LECTERN_LOCALE (zh-CN or en) wins,
 * then the saved choice, then the OS (any Chinese → zh-CN, else English).
 * Chromium's own strings follow it through `--lang`.
 */
export function initializeLocale() {
  try {
    const saved = JSON.parse(readFileSync(settingsFile(), 'utf8'));
    if (isLocalePreference(saved?.preference)) preference = saved.preference;
  } catch { /* First run or unreadable: follow the system. */ }
  system = systemLocale(osLanguages());
  setLocale(resolveLocale({ env: process.env.LECTERN_LOCALE, preference, system }));
  app.commandLine.appendSwitch('lang', localeTag());
}

export const localeState = (): LocaleState => ({ locale: getLocale(), preference, system });

/** Applies a choice from Settings at once and saves it. LECTERN_LOCALE only decides the startup language. */
export async function setLocalePreference(value: unknown): Promise<LocaleState> {
  if (!isLocalePreference(value)) throw new Error('Invalid language');
  preference = value;
  const content = JSON.stringify({ preference: value }, null, 2);
  saving = saving.catch(() => {}).then(async () => {
    await mkdir(directory(), { recursive: true, mode: 0o700 });
    const file = settingsFile();
    await writeFile(file + '.tmp', content, { mode: 0o600 });
    await rename(file + '.tmp', file);
  });
  // Saved first: what the switch triggers below cannot lose the choice.
  await saving;
  setLocale(value === 'system' ? system : value);
  return localeState();
}
