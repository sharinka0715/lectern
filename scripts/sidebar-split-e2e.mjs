// Run after npm run build. An optional first argument selects a packaged Electron executable.
// Split screen in the sidebar: the focused pane's conversation keeps the raised cream
// highlight, the other pane's is pale blue (data-split-open); the two swap with the focus,
// the blue one stays listed past the newest five, marks its collapsed folder faintly, a
// draft there marks its folder, and one pane alone marks nothing. The list across all
// projects (sorted by recency) marks the two the same way and keeps the blue one past its
// first page. Screenshots (Chinese and English, light; one dark) in test-results/sidebar-split/.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron, resizeWindow } from './fixtures/electron.mjs';

const output = path.resolve('test-results', 'sidebar-split');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const locales = {
  'zh-CN': {
    designs: '设计稿', notes: '开发笔记', chat: n => `对话 ${n}`, note: n => `笔记 ${n}`, reply: title => `回复：${title}`,
    expand: name => `展开 ${name}`, collapse: name => `收起 ${name}`, group: name => `${name} 的会话`,
    showMore: name => `展开更多 ${name} 的对话`, more: count => `还有 ${count} 个`, openBeside: '在旁边分屏打开', closePane: '关闭此分屏',
    splitOpen: '在另一侧分屏中打开', inFolder: '另一侧分屏打开了此文件夹中的对话', draft: '另一侧分屏是此文件夹的新对话草稿',
    logs: '日志', log: n => `日志 ${n}`, sort: '对话排序', recent: '最近更新', byProject: '按项目',
  },
  en: {
    designs: 'Designs', notes: 'Notes', chat: n => `Chat ${n}`, note: n => `Note ${n}`, reply: title => `Reply: ${title}`,
    expand: name => `Expand ${name}`, collapse: name => `Collapse ${name}`, group: name => `Conversations in ${name}`,
    showMore: name => `Show more conversations in ${name}`, more: count => `${count} more`, openBeside: 'Open in split view', closePane: 'Close this pane',
    splitOpen: 'Open in the other pane', inFolder: 'The other pane shows a conversation from this folder', draft: 'The other pane has a new conversation draft in this folder',
    logs: 'Logs', log: n => `Log ${n}`, sort: 'Sort conversations', recent: 'Most recently updated', byProject: 'By project',
  },
};

/** One history file per title, the first the oldest (from 1 January, or `day`); returns their session ids. */
async function history(claudeDir, cwd, titles, reply, day = 1) {
  const project = path.join(claudeDir, 'projects', cwd.replace(/[^a-z0-9-]/gi, '-'));
  await mkdir(project, { recursive: true }); await mkdir(cwd, { recursive: true });
  return Promise.all(titles.map(async (title, index) => {
    const sessionId = randomUUID(), timestamp = new Date(Date.UTC(2026, 0, day, 0, index)).toISOString();
    const rows = [
      { type: 'user', uuid: randomUUID(), sessionId, cwd, timestamp, message: { role: 'user', content: title } },
      { type: 'assistant', uuid: randomUUID(), sessionId, cwd, timestamp, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: reply(title) }], stop_reason: 'end_turn' } },
    ];
    await writeFile(path.join(project, `${sessionId}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    return sessionId;
  }));
}

// Colors of a row as the user sees them, once its transitions end: background, text
// and their contrast ratio (of the text in `text`, a selector, if given). A canvas reads
// any CSS color syntax (rgb, color(), oklab).
async function rowColors(element, text) {
  await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
  const context = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
  const parse = value => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    if (a !== 255) throw new Error(`Translucent color: ${value}`);
    return [r, g, b];
  };
  const luminance = rgb => {
    const [r, g, b] = rgb.map(v => v / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const style = getComputedStyle(element);
  const background = parse(style.backgroundColor), color = parse(getComputedStyle(text ? element.querySelector(text) : element).color);
  const [hi, lo] = [luminance(background), luminance(color)].sort((a, b) => b - a);
  return { background, text: color, contrast: Math.round((hi + 0.05) / (lo + 0.05) * 10) / 10 };
}

async function run(locale) {
  const L = locales[locale];
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lectern-sidebar-split-')));
  const profile = path.join(root, 'profile'), claudeDir = path.join(root, 'config');
  const env = { ...process.env, LECTERN_LOCALE: locale, CLAUDE_CONFIG_DIR: claudeDir, TMUX_TMPDIR: root, LECTERN_USER_DATA: profile, LECTERN_LOG_DIR: path.join(root, 'logs') };
  delete env.TMUX; delete env.TMUX_PANE; delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL;
  const chats = ['01', '02', '03', '04', '05', '06', '07'].map(L.chat);
  const designs = await history(claudeDir, path.join(root, 'designs'), chats, L.reply);
  await history(claudeDir, path.join(root, 'notes'), [L.note(1), L.note(2)], L.reply);
  // Twenty newer ones: the list across projects (25 a page) leaves the oldest designs off it.
  await history(claudeDir, path.join(root, 'logs'), Array.from({ length: 20 }, (_, i) => L.log(i + 1)), L.reply, 2);
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, 'workspaces.json'), JSON.stringify([
    { id: 'designs', name: L.designs, kind: 'local', cwd: path.join(root, 'designs') },
    { id: 'notes', name: L.notes, kind: 'local', cwd: path.join(root, 'notes') },
    { id: 'logs', name: L.logs, kind: 'local', cwd: path.join(root, 'logs') },
  ]));
  const [oldest, newest] = [designs[0], designs[6]];
  let app, page;
  const shot = name => page.screenshot({ path: path.join(output, `${name}-${locale}.png`) });
  const sidebarShot = name => page.locator('.sidebar').screenshot({ path: path.join(output, `${name}-${locale}-sidebar.png`) });
  const pane = view => page.locator(`.desk-pane[data-view="${view}"]`);
  const row = id => page.locator(`.session-row[data-session-id="${id}"]`);
  const folder = id => page.locator(`.workspace-row[data-workspace-id="${id}"]`);
  const group = name => page.getByRole('group', { name: L.group(name), exact: true });
  const focusedPane = view => page.waitForFunction(view => document.querySelector(`.desk-pane[data-view="${view}"]`)?.dataset.active === 'true', view);
  const marks = () => page.evaluate(() => ({
    focused: [...document.querySelectorAll('.session-row[aria-current="page"]')].map(el => el.dataset.sessionId),
    other: [...document.querySelectorAll('.session-row[data-split-open]')].map(el => el.dataset.sessionId),
  }));
  // One row at most has the focused highlight, one at most the blue mark of the other pane.
  async function expectMarks(focused, other, why) {
    const want = { focused: focused ? [focused] : [], other: other ? [other] : [] };
    let got;
    for (const until = Date.now() + 10000; Date.now() < until; await page.waitForTimeout(100))
      if (JSON.stringify(got = await marks()) === JSON.stringify(want)) break;
    assert.deepEqual(got, want, why);
    if (focused) assert.match(await row(focused).getAttribute('class'), /\bactive\b/, why);
    if (!other) return;
    assert.match(await row(other).getAttribute('class'), /\bsplit-open\b/, why);
    assert.ok((await row(other).getAttribute('aria-label')).endsWith(L.splitOpen), 'a screen reader hears it');
    assert.ok((await row(other).getAttribute('title')).includes(`\n${L.splitOpen}\n`), 'the hover tip says it');
  }
  const bluish = ([r, , b], by = 12) => b - r >= by;
  // Hover colors would hide the resting ones.
  const moveAway = async () => { const box = await pane('primary').boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + 60); };
  const designsShown = () => group(L.designs).locator('.session-row').evaluateAll(rows => rows.map(row => row.dataset.sessionId));
  try {
    app = await _electron.launch({ executablePath: process.argv[2], args: process.argv[2] ? [] : ['.'], env });
    page = await app.firstWindow();
    page.setDefaultTimeout(11000);
    await resizeWindow(app, page, 1440, 900);
    // Light, whatever the system's theme. The app saves its whole state at every change (the first
    // folder opening at launch is one), which on a slow machine can overwrite this before the reload.
    for (let attempt = 1; ; attempt++) {
      await page.evaluate(() => {
        const key = 'lectern.desktop.preferences.v1';
        localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? '{}'), theme: 'light' }));
      });
      await page.reload();
      const light = await page.waitForFunction(() => document.documentElement.dataset.theme === 'light', null, { timeout: 4000 }).catch(error => error);
      if (!(light instanceof Error)) break;
      if (attempt === 3) throw light;
    }
    // The first folder opens by itself at launch.
    await group(L.designs).waitFor();
    await group(L.designs).getByRole('button', { name: L.showMore(L.designs) }).click();
    await row(oldest).click();
    await pane('primary').getByText(L.reply(chats[0]), { exact: true }).waitFor();
    await expectMarks(oldest, null, 'one pane: no blue row');
    assert.equal(await page.locator('[data-split-open]').count(), 0);

    // Split: the newest conversation opens beside it and takes the focus.
    await row(newest).click({ button: 'right' });
    await page.getByRole('menuitem', { name: L.openBeside }).click();
    await pane('secondary').getByText(L.reply(chats[6]), { exact: true }).waitFor();
    await focusedPane('secondary');
    await expectMarks(newest, oldest, 'split: the focused pane cream, the other blue');
    await moveAway();
    const light = { focused: await row(newest).evaluate(rowColors), other: await row(oldest).evaluate(rowColors) };
    assert.ok(bluish(light.other.background), `the other pane's row is blue: ${JSON.stringify(light)}`);
    assert.ok(!bluish(light.focused.background, 1), `the focused row stays cream: ${JSON.stringify(light)}`);
    assert.ok(light.other.contrast >= 7, `text on the blue row reads clearly: ${JSON.stringify(light)}`);
    // Back to the newest five: the blue row stays listed past them, like the focused one.
    await group(L.designs).locator('.tree-collapse').click();
    const fiveAndOldest = [6, 5, 4, 3, 2, 0].map(i => designs[i]);
    await page.waitForFunction(([name, count]) => document.querySelectorAll(`[role="group"][aria-label="${name}"] .session-row`).length === count, [L.group(L.designs), 6]);
    assert.deepEqual(await designsShown(), fiveAndOldest);
    assert.match(await group(L.designs).locator('.tree-more').first().innerText(), new RegExp(L.more(1)));
    await expectMarks(newest, oldest, 'listed past the newest five');
    await moveAway();
    await shot('split');
    await sidebarShot('split');
    if (locale === 'zh-CN') {
      await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
      const dark = { focused: await row(newest).evaluate(rowColors), other: await row(oldest).evaluate(rowColors) };
      assert.ok(bluish(dark.other.background) && dark.other.contrast >= 7, `dark: ${JSON.stringify(dark)}`);
      assert.ok(!bluish(dark.focused.background, 1), `dark: ${JSON.stringify(dark)}`);
      await sidebarShot('split-dark');
      await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    }

    // Pointer: clicking into the left pane moves the focus there; the two rows swap.
    await pane('primary').getByText(L.reply(chats[0]), { exact: true }).click();
    await focusedPane('primary');
    await expectMarks(oldest, newest, 'clicked the left pane');
    await moveAway();
    await sidebarShot('swapped');
    // Keyboard: the focus moving into the right pane (Tab) swaps them back.
    await pane('secondary').getByRole('button', { name: L.closePane }).focus();
    await focusedPane('secondary');
    await expectMarks(newest, oldest, 'focus moved into the right pane');
    // Clicking the blue row focuses the pane that shows it, rather than opening a copy.
    await row(oldest).click();
    await focusedPane('primary');
    await expectMarks(oldest, newest, 'clicked the blue row');
    await row(newest).click();
    await focusedPane('secondary');
    await expectMarks(newest, oldest, 'clicked the blue row again');

    // The list across all projects (most recent first) marks the two the same way. Its
    // first page holds 25: the blue row, the oldest of 29, stays listed past it.
    const sortBy = async label => {
      await page.getByRole('button', { name: L.sort, exact: true }).click();
      await page.getByRole('menuitem', { name: label, exact: true }).click();
    };
    await sortBy(L.recent);
    await page.waitForFunction(() => document.querySelectorAll('.sidebar-global .session-row').length === 26);
    const across = await page.locator('.sidebar-global .session-row').evaluateAll(rows => rows.map(row => row.dataset.sessionId));
    assert.equal(across.at(-1), oldest, 'the blue row stays listed past the first page');
    assert.ok(across.includes(newest) && !across.includes(designs[1]), `a page of 25 and the blue row: ${across}`);
    await expectMarks(newest, oldest, 'the list across projects');
    await row(oldest).click();
    await focusedPane('primary');
    await expectMarks(oldest, newest, 'clicked the blue row in the list across projects');
    await moveAway();
    await sidebarShot('across-projects');
    // Its rows take two lines (title, then machine · folder): the blue covers both, and the
    // quieter second line still reads on it.
    const acrossColors = { title: await row(newest).evaluate(rowColors), origin: await row(newest).evaluate(rowColors, '.session-origin') };
    assert.ok(bluish(acrossColors.title.background) && acrossColors.title.contrast >= 7 && acrossColors.origin.contrast >= 3.5,
      `two-line blue row: ${JSON.stringify(acrossColors)}`);
    assert.ok(await row(newest).evaluate(el => {
      const box = el.getBoundingClientRect(), second = el.querySelector('.session-origin').getBoundingClientRect();
      return second.top >= box.top + box.height / 2 && second.bottom <= box.bottom;
    }), 'the machine · folder line is the lower half of the marked row');
    await row(newest).click();
    await focusedPane('secondary');
    await sortBy(L.byProject);
    await group(L.designs).waitFor();
    await expectMarks(newest, oldest, 'back to the project tree');

    // A collapsed folder: the focused conversation keeps the folder's existing mark (its
    // icon), the other one adds a faint blue to the row.
    await page.getByRole('button', { name: L.collapse(L.designs), exact: true }).click();
    await group(L.designs).waitFor({ state: 'detached' });
    assert.equal(await folder('designs').getAttribute('data-split-open'), 'inside');
    assert.match(await folder('designs').getAttribute('class'), /\bactive\b/);
    const folderButton = folder('designs').locator('.workspace-select');
    assert.ok((await folderButton.getAttribute('title')).includes(`\n${L.inFolder}\n`), 'the hover tip says it');
    assert.ok((await folderButton.getAttribute('aria-description')).includes(L.inFolder), 'a screen reader hears it');
    await moveAway();
    const faint = await folder('designs').evaluate(rowColors);
    assert.ok(bluish(faint.background, 8) && faint.contrast >= 7, `faint blue folder: ${JSON.stringify(faint)}`);
    await sidebarShot('folder-collapsed');
    await page.getByRole('button', { name: L.expand(L.designs), exact: true }).click();
    await expectMarks(newest, oldest, 'expanded again');
    assert.equal(await folder('designs').getAttribute('data-split-open'), null, 'its row carries the mark again');

    // One pane again (closing the left one): nothing is blue.
    await pane('primary').getByRole('button', { name: L.closePane }).click();
    await pane('secondary').waitFor({ state: 'detached' });
    await pane('primary').getByText(L.reply(chats[6]), { exact: true }).waitFor();
    await expectMarks(newest, null, 'split closed');
    assert.equal(await page.locator('[data-split-open]').count(), 0);
    assert.deepEqual(await designsShown(), [6, 5, 4, 3, 2].map(i => designs[i]), 'back to the newest five');

    // A new-chat draft has no row: the other pane's draft marks its folder instead.
    await row(designs[2]).click({ button: 'right' });
    await page.getByRole('menuitem', { name: L.openBeside }).click();
    await pane('secondary').getByText(L.reply(chats[2]), { exact: true }).waitFor();
    await expectMarks(designs[2], newest, 'split again');
    await pane('primary').getByText(L.reply(chats[6]), { exact: true }).click();
    await focusedPane('primary');
    await folder('notes').locator('.workspace-select').click();
    await page.waitForFunction(() => document.querySelector('.workspace-row[data-workspace-id="notes"] .workspace-select')?.getAttribute('aria-current') === 'page');
    await expectMarks(null, designs[2], 'the focused pane holds a draft');
    assert.equal(await folder('notes').getAttribute('data-split-open'), null, 'the focused draft keeps its own mark');
    await pane('secondary').getByRole('button', { name: L.closePane }).focus();
    await focusedPane('secondary');
    await expectMarks(designs[2], null, 'the draft is in the other pane now');
    assert.equal(await folder('notes').getAttribute('data-split-open'), 'draft');
    assert.equal(await folder('notes').locator('.workspace-select').getAttribute('aria-current'), null);
    assert.ok((await folder('notes').locator('.workspace-select').getAttribute('title')).includes(`\n${L.draft}`));
    await moveAway();
    assert.ok(bluish((await folder('notes').evaluate(rowColors)).background), 'the draft folder is blue like a row');
    await sidebarShot('draft');
    console.log(`PASS ${locale}: focused row cream, the other pane's blue; swap with the focus; listed past five; the list across projects; collapsed folder; draft folder; none in one pane.`);
  } catch (error) {
    await page?.screenshot({ path: path.join(output, `failure-${locale}.png`) }).catch(() => {});
    throw error;
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
}

try {
  for (const locale of ['zh-CN', 'en']) await run(locale);
  console.log(`Screenshots in ${output}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
