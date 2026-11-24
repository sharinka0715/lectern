// Run after npm run build. An optional first argument selects a packaged Electron executable.
// What the user opens and closes in the sidebar stays put: a folded folder, an open one, a
// folder's "展开更多", a folded machine and a folded group of the list across projects all
// survive switching the sort mode and a restart; opening a conversation from that list does
// not open its folder in the tree, nor does restoring it at launch. Folds of folders and
// machines no longer in the sidebar are dropped at launch.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lectern-sidebar-folds-')));
const profile = path.join(root, 'profile'), claudeDir = path.join(root, 'config');
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', CLAUDE_CONFIG_DIR: claudeDir, TMUX_TMPDIR: root, LECTERN_USER_DATA: profile, LECTERN_LOG_DIR: path.join(root, 'logs') };
delete env.TMUX; delete env.TMUX_PANE; delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL;
const preferences = 'lectern.desktop.preferences.v1';

/** One history file per title, the first the oldest; returns their session ids. */
async function history(cwd, titles, day) {
  const project = path.join(claudeDir, 'projects', cwd.replace(/[^a-z0-9-]/gi, '-'));
  await mkdir(project, { recursive: true }); await mkdir(cwd, { recursive: true });
  return Promise.all(titles.map(async (title, index) => {
    const sessionId = randomUUID(), timestamp = new Date(Date.UTC(2026, 0, day, 0, index)).toISOString();
    const rows = [
      { type: 'user', uuid: randomUUID(), sessionId, cwd, timestamp, message: { role: 'user', content: title } },
      { type: 'assistant', uuid: randomUUID(), sessionId, cwd, timestamp, message: { role: 'assistant', content: [{ type: 'text', text: `回复：${title}` }], stop_reason: 'end_turn' } },
    ];
    await writeFile(path.join(project, `${sessionId}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    return sessionId;
  }));
}

let app, page;
const launch = async () => {
  const executablePath = process.argv[2];
  app = await _electron.launch({ executablePath, args: executablePath ? [] : ['.'], env });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
};
const group = name => page.getByRole('group', { name: `${name} 的会话`, exact: true });
const shown = name => group(name).locator('.session-title').allTextContents();
const button = name => page.getByRole('button', { name, exact: true });
const row = id => page.locator(`.session-row[data-session-id="${id}"]`);
const across = () => page.getByRole('group', { name: '所有对话', exact: true });
async function sortBy(label) {
  await button('对话排序').click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
  await page.locator(`.sidebar-tree[data-sidebar-sort="${label === '按项目' ? 'projects' : 'recent'}"]`).waitFor();
}
/** The project tree as the user left it: 甲 folded with its paging kept, 乙 open. */
async function expectTree(why) {
  await group('乙项目').getByText('乙 对话 3', { exact: true }).waitFor();
  assert.equal(await group('甲项目').count(), 0, `甲 stays folded: ${why}`);
  assert.equal(await button('展开 甲项目').getAttribute('aria-expanded'), 'false', why);
}
const stored = () => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}').sidebarFolds, preferences);

try {
  const alpha = await history(path.join(root, 'alpha'), Array.from({ length: 7 }, (_, i) => `甲 对话 ${i + 1}`), 1);
  await history(path.join(root, 'beta'), ['乙 对话 1', '乙 对话 2', '乙 对话 3'], 2);
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, 'workspaces.json'), JSON.stringify([
    { id: 'alpha', name: '甲项目', kind: 'local', cwd: path.join(root, 'alpha'), claudeDir },
    { id: 'beta', name: '乙项目', kind: 'local', cwd: path.join(root, 'beta'), claudeDir },
  ]));
  await launch();
  // A fresh profile opens the first folder by itself.
  await group('甲项目').getByText('甲 对话 7', { exact: true }).waitFor();
  await group('甲项目').getByRole('button', { name: '展开更多 甲项目 的对话', exact: true }).click();
  assert.equal((await shown('甲项目')).length, 7);
  await button('收起 甲项目').click();
  await group('甲项目').waitFor({ state: 'detached' });
  await button('展开 乙项目').click();
  await expectTree('folded and opened by hand');

  // The list across projects: opening 甲's oldest conversation there leaves the tree alone.
  await sortBy('最近更新');
  assert.equal(await across().locator('.session-row').count(), 10);
  assert.equal(await row(alpha[0]).locator('.session-origin').innerText(), '本地 · 甲项目', 'the machine and folder under the title');
  await row(alpha[0]).click();
  await page.locator(`.session-row.active[data-session-id="${alpha[0]}"]`).waitFor();
  await page.getByRole('main').getByText('回复：甲 对话 1', { exact: true }).waitFor();
  await button('所有对话').click();
  await across().waitFor({ state: 'detached' });
  assert.equal(await button('所有对话').getAttribute('aria-expanded'), 'false');
  await sortBy('按项目');
  await expectTree('after the list across projects');
  assert.match(await page.locator('.workspace-row[data-workspace-id="alpha"]').getAttribute('class'), /\bactive\b/,
    'the folded folder holds the open conversation');

  await button('收起机器 本地').click();
  await page.locator('.machine-folders').waitFor({ state: 'detached' });
  await sortBy('最近更新');
  assert.equal(await button('所有对话').getAttribute('aria-expanded'), 'false', 'the group stays folded');
  await sortBy('按项目');
  await button('展开机器 本地').waitFor();
  assert.equal(await page.locator('.machine-folders').count(), 0, 'the machine stays folded');

  // A restart: everything as it was, though 甲's conversation is restored in the pane.
  await app.close();
  await launch();
  await page.getByRole('main').getByText('回复：甲 对话 1', { exact: true }).waitFor();
  assert.equal(await page.locator('.sidebar-tree').getAttribute('data-sidebar-sort'), 'projects');
  await button('展开机器 本地').click();
  await expectTree('after a restart');
  await button('展开 甲项目').click();
  await group('甲项目').getByText('甲 对话 1', { exact: true }).waitFor();
  assert.equal((await shown('甲项目')).length, 7, 'its 展开更多 is kept');
  await sortBy('最近更新');
  assert.equal(await button('所有对话').getAttribute('aria-expanded'), 'false', 'the group stays folded after a restart');
  await button('所有对话').click();
  await across().locator('.session-row').nth(9).waitFor();
  await sortBy('按项目');

  // Folds of folders and machines that are gone are dropped at launch; the rest stay. A
  // folded group goes in with them: it tells that the reload read this write (the app saves
  // its whole state at every change and may overwrite it first).
  for (let attempt = 1; ; attempt++) {
    await page.evaluate(key => {
      const state = JSON.parse(localStorage.getItem(key));
      const folds = state.sidebarFolds;
      folds.expandedFolders.push('gone');
      folds.collapsedMachines.push(JSON.stringify(['ssh', 'gone.invalid', null]));
      folds.folderListed.gone = 25;
      folds.collapsedGroups = ['other'];
      localStorage.setItem(key, JSON.stringify(state));
    }, preferences);
    await page.reload();
    await group('甲项目').getByText('甲 对话 1', { exact: true }).waitFor();
    if ((await stored()).collapsedGroups.includes('other')) break;
    if (attempt === 3) throw new Error('The app overwrote the written folds before every reload');
  }
  await page.waitForFunction(key => !JSON.parse(localStorage.getItem(key)).sidebarFolds.expandedFolders.includes('gone'), preferences);
  assert.deepEqual(await stored(), {
    expandedFolders: ['beta', 'alpha'], collapsedMachines: [], collapsedGroups: ['other'], folderListed: { alpha: 15 }, groupListed: {},
  });
  console.log('PASS: sidebar folds (folders, paging, machine, list group) survive sort switching and restarts; stale folds are dropped.');
} catch (error) {
  console.error(error);
  if (page) await page.screenshot({ path: path.resolve('test-results', 'sidebar-folds-failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
