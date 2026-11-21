import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dictionaries } from '../src/shared/locales';
import {
  allTranslations, formatMessage, getLocale, localeForLanguage, placeholders, resolveLocale, setLocale, systemLocale, t, translate,
} from '../src/shared/i18n';

const cjk = /[　-〿一-鿿＀-￯]/u;
const han = /[一-鿿]/u;
/** Arguments a template only uses to pick a plural form: the other language may not need them. */
const pluralOnly = (template: string) => [...template.matchAll(/\{(\w+),\s*plural\b/g)].map(match => match[1])
  .filter(name => !new RegExp(`\\{${name}(?:,\\s*number)?\\}`).test(template));
const entries = Object.entries(dictionaries).flatMap(([space, messages]) =>
  Object.entries(messages as Record<string, readonly [string, string]>).map(([key, [zh, en]]) => ({ key: `${space}.${key}`, zh, en })));

test('every message has Chinese and English with the same placeholders', () => {
  assert.ok(entries.length > 1000, `all dictionaries are registered (${entries.length})`);
  for (const { key, zh, en } of entries) {
    assert.ok(zh.trim() && en.trim(), `${key} has both languages`);
    const [inZh, inEn] = [placeholders(zh), placeholders(en)];
    const missing = [...inZh.filter(name => !inEn.includes(name) && !pluralOnly(zh).includes(name)),
      ...inEn.filter(name => !inZh.includes(name) && !pluralOnly(en).includes(name))];
    assert.deepEqual(missing, [], `${key} uses the same placeholders in both languages (zh: ${inZh}, en: ${inEn})`);
  }
});

test('English messages contain no Chinese (language names excepted); the product is Lectern in both languages', () => {
  for (const { key, en } of entries) {
    if (key !== 'prefs.languageZh') assert.doesNotMatch(en, cjk, `${key} English: ${en}`);
  }
  assert.equal(translate('zh-CN', 'menu.about'), '关于 Lectern');
  assert.equal(translate('en', 'menu.about'), 'About Lectern');
});

test('English text differs from the Chinese text', () => {
  const same = entries.filter(({ zh, en }) => zh === en && cjk.test(zh)).map(entry => entry.key);
  assert.deepEqual(same, ['prefs.languageZh'], 'only the endonym of Chinese stays Chinese in English');
});

test('the OS language picks the app language: any Chinese → zh-CN, anything else → English', () => {
  for (const tag of ['zh-CN', 'zh-TW', 'zh-HK', 'zh-Hans-CN', 'zh-Hant', 'zh', 'zh_CN.UTF-8', 'ZH-cn']) assert.equal(localeForLanguage(tag), 'zh-CN', tag);
  for (const tag of ['en-US', 'en', 'fr-FR', 'ja-JP', 'de', 'es-419']) assert.equal(localeForLanguage(tag), 'en', tag);
  for (const tag of ['', 'C', 'POSIX', undefined]) assert.equal(localeForLanguage(tag), undefined, String(tag));
  assert.equal(systemLocale(['zh-TW', 'en-US']), 'zh-CN');
  assert.equal(systemLocale(['fr-FR', 'zh-CN']), 'en', 'the most preferred language decides');
  assert.equal(systemLocale(['C', 'zh_CN.UTF-8']), 'zh-CN', 'the POSIX C locale says nothing');
  assert.equal(systemLocale([]), 'en');
});

test('LECTERN_LOCALE wins over the saved choice, which wins over the OS', () => {
  assert.equal(resolveLocale({ env: 'en', preference: 'zh-CN', system: 'zh-CN' }), 'en');
  assert.equal(resolveLocale({ env: 'zh-CN', preference: 'en', system: 'en' }), 'zh-CN');
  assert.equal(resolveLocale({ env: 'fr', preference: 'en', system: 'zh-CN' }), 'en', 'an invalid LECTERN_LOCALE is ignored');
  assert.equal(resolveLocale({ preference: 'system', system: 'zh-CN' }), 'zh-CN');
  assert.equal(resolveLocale({ preference: undefined, system: 'en' }), 'en');
});

test('t() follows the current language; tests run in Chinese by default', () => {
  assert.equal(getLocale(), 'zh-CN');
  assert.equal(t('menu.copy'), '复制');
  try {
    setLocale('en');
    assert.equal(t('menu.copy'), 'Copy');
    assert.equal(t('sidebar.moreCount', { count: 3 }), '3 more');
  } finally { setLocale('zh-CN'); }
  assert.deepEqual(allTranslations('menu.copy'), ['复制', 'Copy']);
  assert.equal(translate('en', 'app.login', { machine: 'devbox' }), 'Sign in to devbox');
});

test('ICU-lite templates: parameters, plurals, select, numbers and literal braces', () => {
  assert.equal(formatMessage('Hi {name}', { name: 'Ada' }, 'en'), 'Hi Ada');
  assert.equal(formatMessage('{count, plural, one {# file} other {# files}}', { count: 1 }, 'en'), '1 file');
  assert.equal(formatMessage('{count, plural, one {# file} other {# files}}', { count: 4 }, 'en'), '4 files');
  assert.equal(formatMessage('{count, plural, =0 {none} other {#}}', { count: 0 }, 'en'), 'none');
  assert.equal(formatMessage('{count} 个文件', { count: 4 }, 'zh-CN'), '4 个文件');
  assert.equal(formatMessage('{k, select, model {Model} other {Effort}} of {name}', { k: 'model', name: 'x' }, 'en'), 'Model of x');
  assert.equal(formatMessage('{k, select, model {Model} other {Effort}}', { k: 'effort' }, 'en'), 'Effort');
  assert.equal(formatMessage('{n, number} MiB', { n: 12345.5 }, 'en'), '12,345.5 MiB');
  assert.equal(formatMessage('{day, select, Mon {周一} other {{day}}}', { day: 'Xyz' }, 'zh-CN'), 'Xyz');
  assert.equal(formatMessage('{"path": path, "n": 1} {missing}', {}, 'en'), '{"path": path, "n": 1} {missing}');
  assert.deepEqual(placeholders('{a} {n, plural, one {# {b}} other {{c}}} {d, select, x {{e}} other {}}'), ['a', 'b', 'c', 'd', 'e', 'n']);
});

/** Strips comments; a crude scanner that is enough for this codebase. */
function code(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(line => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
}

test('no Chinese text left in UI code outside the dictionaries', () => {
  // Parser inputs (text other programs print) and diagnostics-only labels stay as they are.
  const allowed = [
    /reportActionError\(/,                       // diagnostic log label, never shown
    /不是内部或外部命令\|识别为 cmdlet/,             // Windows cmd/PowerShell output (supported-targets.ts)
    /密码\|口令/,                                   // OpenSSH prompts in Chinese (ssh-login.ts)
    /未发送按键\|no keys were sent/,                // messages of either language (native-settings.ts)
  ];
  const found: string[] = [];
  for (const dir of ['renderer', 'main', 'backend', 'core', 'shared', 'diagnostics']) {
    for (const file of readdirSync(new URL(`../src/${dir}/`, import.meta.url))) {
      if (!/\.tsx?$/.test(file) || dir === 'shared' && file === 'release-notes.ts') continue;
      code(readFileSync(new URL(`../src/${dir}/${file}`, import.meta.url), 'utf8')).split('\n').forEach((line, i) => {
        if (han.test(line) && !allowed.some(pattern => pattern.test(line))) found.push(`src/${dir}/${file}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  assert.deepEqual(found, [], 'move these strings into src/shared/locales');
});

test('logic that reads message text works in both languages', async () => {
  const { keysNotSent } = await import('../src/backend/native-settings');
  const { isUnsupportedTarget, unsupportedTargetMessage } = await import('../src/shared/supported-targets');
  // A guard that refused before sending says so in a phrase the retry logic recognizes, in either language.
  for (const { key, zh, en } of entries.filter(entry => entry.zh.includes('未发送按键'))) {
    assert.match(en, /no keys were sent/i, `${key} keeps the retry marker in English`);
    assert.ok(keysNotSent(new Error(zh)) && keysNotSent(new Error(en)), key);
  }
  assert.equal(keysNotSent(new Error(translate('en', 'native.menuReadTimeout'))), false);
  const english = translate('en', 'shared.unsupportedTarget', { host: 'win', system: 'Windows', note: translate('en', 'shared.supportedTargetNote') });
  assert.ok(isUnsupportedTarget(english), 'an English message from before a switch still reads as unsupported');
  assert.ok(isUnsupportedTarget(unsupportedTargetMessage('win', 'Windows')));
});
