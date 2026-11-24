// Run after npm run build. An optional first argument selects a packaged Electron executable.
// Each folder lists its five newest conversations, "展开更多" adds ten at a time, and a
// folder added without history scanning lists nothing until "扫描所有对话".
import { createPrivateTmux } from './fixtures/private-tmux.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from './fixtures/electron.mjs';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lectern-sidebar-paging-')));
const privateServer = createPrivateTmux(root);
const profile = path.join(root, 'profile'), claudeDir = path.join(root, 'config');
const env = { ...privateServer.env, LECTERN_LOCALE: 'zh-CN', CLAUDE_CONFIG_DIR: claudeDir, LECTERN_USER_DATA: profile, LECTERN_LOG_DIR: path.join(root, 'logs') };
delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL;

async function history(cwd, titles) {
  const project = path.join(claudeDir, 'projects', cwd.replace(/[^a-z0-9-]/gi, '-'));
  await mkdir(project, { recursive: true }); await mkdir(cwd, { recursive: true });
  await Promise.all(titles.map((title, index) => {
    const sessionId = randomUUID(), timestamp = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
    const rows = [
      { type: 'user', uuid: randomUUID(), sessionId, cwd, timestamp, message: { role: 'user', content: title } },
      { type: 'assistant', uuid: randomUUID(), sessionId, cwd, timestamp, message: { role: 'assistant', content: [{ type: 'text', text: '好的。' }], stop_reason: 'end_turn' } },
    ];
    return writeFile(path.join(project, `${sessionId}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  }));
}

let app;
try {
  const many = path.join(root, 'many'), later = path.join(root, 'later');
  const titles = Array.from({ length: 17 }, (_, i) => `对话 ${String(i + 1).padStart(2, '0')}`);
  await history(many, titles);
  await history(later, ['稍后扫描的对话 A', '稍后扫描的对话 B']);
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, 'workspaces.json'), JSON.stringify([
    { id: 'many', name: '很多对话', kind: 'local', cwd: many },
    { id: 'later', name: '新加的目录', kind: 'local', cwd: later, historyScan: false },
  ]));
  const executablePath = process.argv[2];
  const launch = async () => {
    app = await _electron.launch({ executablePath, args: executablePath ? [] : ['.'], env });
    const page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    return page;
  };
  let page = await launch();
  const group = name => page.getByRole('group', { name: `${name} 的会话`, exact: true });
  const expand = async name => {
    const toggle = page.getByRole('button', { name: `展开 ${name}`, exact: true });
    if (await toggle.count()) await toggle.click();
    await group(name).waitFor();
  };
  const shown = name => group(name).locator('.session-title').allTextContents();
  await expand('很多对话');
  await group('很多对话').getByText('对话 17', { exact: true }).waitFor();
  assert.deepEqual(await shown('很多对话'), ['对话 17', '对话 16', '对话 15', '对话 14', '对话 13'], 'five newest first');
  const more = group('很多对话').getByRole('button', { name: '展开更多 很多对话 的对话' });
  await expand('新加的目录');
  await group('新加的目录').getByText('尚未扫描此目录的对话', { exact: true }).waitFor();
  await page.locator('.sidebar').screenshot({ path: path.resolve('test-results', 'sidebar-paging.png') });
  assert.match(await more.innerText(), /还有 12 个/);
  await more.click();
  assert.equal((await shown('很多对话')).length, 15);
  assert.match(await more.innerText(), /还有 2 个/);
  await more.click();
  assert.deepEqual(await shown('很多对话'), titles.slice().reverse());
  assert.equal(await more.count(), 0, 'no button once everything is listed');
  // "收起对话" returns an expanded folder to its five newest: beside the folder,
  // under the list, and in the folder's context menu.
  const newestFive = titles.slice(-5).reverse();
  await page.getByRole('button', { name: '收起 很多对话 的对话', exact: true }).click();
  assert.deepEqual(await shown('很多对话'), newestFive, 'the folder button collapses to five');
  assert.match(await more.innerText(), /还有 12 个/);
  assert.equal(await page.getByRole('button', { name: '收起 很多对话 的对话', exact: true }).count(), 0, 'nothing left to collapse');
  await more.click();
  await group('很多对话').getByRole('button', { name: '收起 很多对话 的更多对话', exact: true }).click();
  assert.deepEqual(await shown('很多对话'), newestFive, 'the button under the list collapses too');
  await more.click();
  await page.locator('.workspace-row[data-workspace-id="many"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /收起对话/ }).click();
  assert.deepEqual(await shown('很多对话'), newestFive, 'the context menu collapses too');
  await page.locator('.workspace-row[data-workspace-id="many"]').click({ button: 'right' });
  assert.equal(await page.getByRole('menuitem', { name: /收起对话/ }).count(), 0, 'only offered after expanding');
  await page.keyboard.press('Escape');
  await more.click(); await more.click();

  await expand('新加的目录');
  await group('新加的目录').getByText('尚未扫描此目录的对话', { exact: true }).waitFor();
  assert.deepEqual(await shown('新加的目录'), []);
  await group('新加的目录').getByRole('button', { name: '扫描所有对话', exact: true }).click();
  await group('新加的目录').getByText('稍后扫描的对话 B', { exact: true }).waitFor();
  assert.equal(await group('新加的目录').getByText('尚未扫描此目录的对话').count(), 0);
  const stored = JSON.parse(await readFile(path.join(profile, 'workspaces.json'), 'utf8'));
  assert.equal(stored.find(item => item.id === 'later').historyScan, undefined, 'the choice is saved');
  await app.close();
  page = await launch();
  await expand('新加的目录');
  await group('新加的目录').getByText('稍后扫描的对话 A', { exact: true }).waitFor();
  console.log('PASS: sidebar lists five newest conversations per folder and ten more per click; a new folder scans history only on request, and the choice persists.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await app?.close();
  privateServer.killAll();
  await rm(root, { recursive: true, force: true });
}
