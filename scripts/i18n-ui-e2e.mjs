// Run after npm run build. The workbench in English and a live switch of the
// language: LECTERN_LOCALE=en, the welcome screen, sidebar, composer, settings,
// release notes and the application menu; then Settings › Appearance switches
// to Chinese and back without a restart, and the choice survives a relaunch.
// Screenshots go to LECTERN_SHOT_DIR (default test-results/i18n).
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from './fixtures/electron.mjs';

const profile = await mkdtemp(path.join(tmpdir(), 'lectern-i18n-'));
const shots = path.resolve(process.env.LECTERN_SHOT_DIR || path.join('test-results', 'i18n'));
await mkdir(shots, { recursive: true });
const executablePath = process.env.LECTERN_E2E_EXECUTABLE;
const han = /[一-鿿]/u;
// The OS says Chinese; LECTERN_LOCALE or the saved choice must win over it.
const base = { ...process.env, LANGUAGE: 'zh_CN', LC_ALL: 'zh_CN.UTF-8', LANG: 'zh_CN.UTF-8',
  LECTERN_USER_DATA: profile, LECTERN_NODE_BINARY: process.execPath, LECTERN_LOG_DIR: path.join(profile, 'diagnostics') };
delete base.ELECTRON_RUN_AS_NODE; delete base.LECTERN_DEV_URL; delete base.LECTERN_LOCALE;

/** A demo window; `ready` is what to wait for (a relaunch restores the previous, now stale, selection). */
// macOS takes the system languages from its preferences, not from the variables above:
// the argument domain (`-AppleLanguages`) sets them for this process only.
const systemChinese = process.platform === 'darwin' ? ['-AppleLanguages', '(zh-Hans)'] : [];
async function launch(env, ready = '.message-assistant') {
  const app = await _electron.launch({ executablePath, args: [...(executablePath ? [] : ['.']), '--demo', ...systemChinese], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.locator(ready).first().waitFor();
  return { app, page };
}
/** Closes the app, or kills it when its shutdown hangs. */
async function quit(app) {
  const closed = app.close().then(() => true, () => true);
  // Cleared once closed: a pending timer would keep the script alive for the whole 15 s.
  let timer;
  const hung = new Promise(resolve => { timer = setTimeout(() => resolve(false), 15000); });
  if (!await Promise.race([closed, hung])) app.process().kill('SIGKILL');
  clearTimeout(timer);
}
const menuLabels = app => app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map(item => item.label));
/** Visible text of the element, without the language picker's own endonym. */
const visibleText = locator => locator.evaluate(node => node.innerText.replace(/简体中文/g, ''));
async function noChinese(locator, where) {
  const text = await visibleText(locator);
  const lines = text.split('\n').filter(line => /[一-鿿]/u.test(line));
  assert.deepEqual(lines, [], `no Chinese left in ${where}`);
}

let app, page;
try {
  ({ app, page } = await launch({ ...base, LECTERN_LOCALE: 'en' }));
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en-US');
  assert.equal((await page.evaluate(() => window.desktop.localeState())).locale, 'en');
  const sidebar = page.locator('.sidebar');
  await sidebar.getByRole('button', { name: /New conversation/ }).first().waitFor();
  await sidebar.getByText('Machines', { exact: true }).waitFor();
  await sidebar.getByText('Product Studio').first().waitFor();
  await page.getByRole('button', { name: 'What\'s new', exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Message to Claude' }).waitFor();
  assert.ok((await menuLabels(app)).includes('Edit'), 'the application menu is in English');
  await page.waitForTimeout(500);
  await noChinese(page.locator('body'), 'the main window');
  await page.screenshot({ path: path.join(shots, 'en-main.png') });
  // The narrowest window and a split pane: longer English labels must still fit.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 760));
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(shots, 'en-main-narrow.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 880));
  await page.waitForTimeout(300);
  console.log('stage: English main window');
  // Tooltips, labels and placeholders are translated too.
  const attributes = await page.evaluate(() => [...document.querySelectorAll('[data-tip],[data-tip-detail],[title],[aria-label],[placeholder]')]
    .flatMap(node => ['data-tip', 'data-tip-detail', 'title', 'aria-label', 'placeholder'].map(name => node.getAttribute(name) ?? '')));
  assert.deepEqual(attributes.filter(value => han.test(value)), [], 'no Chinese in tooltips, titles, labels or placeholders');

  console.log('stage: tooltips and labels');
  // A new conversation: the welcome screen and the draft's input box.
  await page.locator('.sidebar').getByRole('button', { name: /New conversation/ }).first().click();
  await page.getByRole('heading', { name: 'Start a new conversation' }).waitFor();
  const placeholder = await page.getByRole('textbox', { name: 'Message to Claude' }).getAttribute('placeholder');
  assert.match(placeholder, /first message/i, 'the draft input box explains when Claude Code starts');
  await noChinese(page.locator('main').first(), 'the welcome screen');
  await page.screenshot({ path: path.join(shots, 'en-welcome.png') });
  const draft = 'keeps this draft';
  await page.getByRole('textbox', { name: 'Message to Claude' }).fill(draft);

  console.log('stage: welcome screen');
  // Release notes in English, falling back to Chinese only where a pending item has no translation.
  await page.getByRole('button', { name: 'What\'s new', exact: true }).click();
  const notes = page.getByRole('dialog', { name: 'What\'s new' });
  await notes.waitFor();
  await page.waitForTimeout(400);
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  await notes.getByText(`v${version}Current`, { exact: true }).waitFor();
  assert.deepEqual([...new Set(await notes.locator('h4').allTextContents())].sort(), ['Fixes', 'New features']);
  await noChinese(notes.locator('.release-note').filter({ hasText: `v${version}Current` }), 'the release notes of the running version');
  // A click inside lets the modal finish painting before the screenshot.
  await notes.locator('.release-note h3').first().click();
  await page.screenshot({ path: path.join(shots, 'en-release-notes.png') });
  await page.keyboard.press('Escape');
  await notes.waitFor({ state: 'detached' });

  console.log('stage: release notes');
  // Settings: every tab is in English.
  await page.getByRole('button', { name: 'Interface and connection settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.waitFor();
  await page.waitForTimeout(400);
  const language = settings.getByRole('combobox', { name: 'Interface language' });
  assert.equal(await language.inputValue(), 'system', 'LECTERN_LOCALE does not change the saved choice');
  for (const tab of ['Appearance', 'Chat layout', 'File preview', 'Chat history', 'Session', 'Project folders', 'SSH connections', 'Trash']) {
    await settings.locator('nav').getByRole('button', { name: tab, exact: true }).click();
    await settings.getByRole('heading', { name: tab === 'Project folders' ? 'Project folders' : tab, exact: true }).first().waitFor();
    await noChinese(settings, `Settings › ${tab}`);
    if (tab === 'Appearance') await page.screenshot({ path: path.join(shots, 'en-settings.png') });
    if (tab === 'Session') await page.screenshot({ path: path.join(shots, 'en-settings-session.png') });
  }
  await page.screenshot({ path: path.join(shots, 'en-settings-trash.png') });

  console.log('stage: settings tabs');
  // Switch to Chinese live: the open dialog, the workbench and the menu follow at once.
  await settings.locator('nav').getByRole('button', { name: 'Appearance', exact: true }).click();
  await language.selectOption('zh-CN');
  await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
  const zhSettings = page.getByRole('dialog', { name: '设置' });
  await zhSettings.getByRole('heading', { name: '外观', exact: true }).waitFor();
  assert.equal(await zhSettings.getByRole('combobox', { name: '界面语言' }).inputValue(), 'zh-CN');
  await page.locator('.sidebar').getByRole('button', { name: /新建对话/ }).first().waitFor();
  assert.ok((await menuLabels(app)).includes('编辑'), 'the application menu was rebuilt in Chinese');
  await page.screenshot({ path: path.join(shots, 'zh-settings.png') });
  await page.keyboard.press('Escape');
  await zhSettings.waitFor({ state: 'detached' });
  const input = page.getByRole('textbox', { name: '发送给 Claude 的消息' });
  assert.equal(await input.inputValue(), draft, 'switching language keeps the typed draft (no remount)');
  await page.getByRole('heading', { name: '开始新对话' }).waitFor();
  await page.locator('.sidebar .session-row').first().click();
  await page.locator('.message-assistant').waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(shots, 'zh-main.png') });
  const saved = JSON.parse(await readFile(path.join(profile, 'locale-settings.json'), 'utf8'));
  assert.equal(saved.preference, 'zh-CN', 'the choice is saved');

  console.log('stage: switched to Chinese');
  // And back to English, keeping what is on screen.
  await page.getByRole('button', { name: '界面与连接设置' }).click();
  await page.getByRole('dialog', { name: '设置' }).getByRole('combobox', { name: '界面语言' }).selectOption('en');
  await page.waitForFunction(() => document.documentElement.lang === 'en-US');
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('heading', { name: 'Appearance', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.ok((await menuLabels(app)).includes('Edit'), 'the application menu is English again');
  await page.waitForTimeout(500);
  await noChinese(page.locator('.sidebar'), 'the sidebar after switching back');
  await quit(app);
  app = undefined;

  console.log('stage: back to English, closing');
  // Relaunch without LECTERN_LOCALE on a Chinese system: the saved English wins.
  ({ app, page } = await launch(base, '.sidebar .session-row'));
  console.log('stage: relaunched');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en-US', 'the saved choice survives a restart');
  assert.deepEqual(await page.evaluate(() => window.desktop.localeState()), { locale: 'en', preference: 'en', system: 'zh-CN' });
  await page.getByRole('button', { name: 'Interface and connection settings' }).click();
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('combobox', { name: 'Interface language' }).selectOption('system');
  await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
  assert.equal(JSON.parse(await readFile(path.join(profile, 'locale-settings.json'), 'utf8')).preference, 'system', '“System” follows the OS again');
  console.log('PASS: English workbench, settings, release notes and menu; live switch to Chinese and back; the choice survives a restart.');
} catch (error) {
  console.error(error);
  if (page) await Promise.race([page.screenshot({ path: path.join(shots, 'failure.png') }).catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000))]);
  process.exitCode = 1;
} finally {
  if (app) await quit(app);
  await rm(profile, { recursive: true, force: true });
}
