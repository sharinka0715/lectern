// Normal Electron mode, isolated on-disk historical transcripts. Never starts Claude.
import assert from 'node:assert/strict';
import { _electron } from 'playwright';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lectern-history-e2e-')));
const resultDirectory = path.resolve('test-results', `history-${Date.now()}`);
await mkdir(resultDirectory, { recursive: true });
const claudeDir = path.join(root, 'claude');
const projects = [path.join(root, '历史项目 A'), path.join(root, 'project-b'), path.join(root, 'deleted-project')];
const originals = new Map();
for (const cwd of projects.slice(0, 2)) await mkdir(cwd, { recursive: true });
for (const [index, cwd] of projects.entries()) {
  const directory = path.join(claudeDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  await mkdir(directory, { recursive: true });
  for (let session = 0; session < (index === 0 ? 2 : 1); session++) {
    const sessionId = randomUUID(), timestamp = `2026-01-${String(10 - index - session).padStart(2, '0')}T10:00:00.000Z`;
    const text = `历史回复 ${index}-${session}：中文 🧭`;
    const content = [
      { type: 'user', sessionId, uuid: randomUUID(), cwd, timestamp, message: { role: 'user', content: `旧问题 ${index}-${session}` } },
      { type: 'assistant', sessionId, uuid: randomUUID(), cwd, timestamp, message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } },
    ].map(record => JSON.stringify(record)).join('\n') + '\n';
    const file = path.join(directory, `${sessionId}.jsonl`);
    await writeFile(file, content);
    originals.set(file, createHash('sha256').update(content).digest('hex'));
  }
}
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', CLAUDE_CONFIG_DIR: claudeDir, LECTERN_USER_DATA: path.join(root, 'profile'), LECTERN_LOG_DIR: path.join(resultDirectory, 'diagnostics') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.LECTERN_DEV_URL;
let app;
try {
  app = await _electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.getByRole('button', { name: '发现本机会话', exact: true }).first().click();
  await page.waitForFunction(() => document.querySelectorAll('.history-project-row[data-cwd]').length === 3);
  const scan = await page.evaluate(() => window.desktop.discoverHistoryProjects({ kind: 'local' }));
  assert.equal(scan.scannedFiles, 4);
  assert.equal(scan.projects.length, 3);
  assert.equal(scan.projects.filter(project => project.exists).length, 2);
  assert.equal(scan.projects.find(project => project.cwd.endsWith('历史项目 A')).sessionCount, 2);
  const missing = page.locator('.history-project-row[data-cwd]').filter({ hasText: 'deleted-project' });
  assert.equal(await missing.getByRole('checkbox').isDisabled(), true);
  for (const cwd of projects.slice(0, 2)) {
    const row = page.locator('.history-project-row[data-cwd]').filter({ hasText: cwd });
    await row.getByRole('checkbox').check();
  }
  await page.screenshot({ path: path.join(resultDirectory, 'discover.png') });
  await page.getByRole('button', { name: '添加所选历史目录', exact: true }).click();
  await page.locator('.message-assistant').waitFor();
  assert.match(await page.locator('.message-assistant').innerText(), /历史回复 0-0：中文 🧭/);
  assert.equal(await page.locator('.session-row').count(), 2);
  assert.equal(await page.getByRole('button', { name: '续接会话', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('textbox', { name: '发送给 Claude 的消息' }).isDisabled(), true);
  const imported = await page.evaluate(() => window.desktop.listWorkspaces());
  assert.equal(imported.length, 2);
  assert.ok(imported.every(workspace => workspace.claudeDir === undefined), 'Default/inherited config scans must not add an explicit CLAUDE_CONFIG_DIR override on import');
  // Each directory owns its children; expanding another directory never changes
  // the selected conversation, and collapsing preserves the active watch.
  await page.getByRole('button', { name: '展开 project-b', exact: true }).click();
  const secondGroup = page.getByRole('group', { name: 'project-b 的会话', exact: true });
  await secondGroup.locator('.session-row').waitFor();
  assert.equal(await secondGroup.locator('.session-row').count(), 1);
  assert.match(await page.locator('.message-assistant').innerText(), /历史回复 0-0/);
  assert.equal(await page.locator('.sidebar-tree .session-row').count(), 3);
  assert.equal(await page.locator('.session-list').count(), 0, 'No independent global session list remains');
  for (const row of await page.locator('.workspace-row, .session-row').all()) {
    assert.ok((await row.boundingBox()).height <= 30, 'Every directory and session is a single compact row');
  }
  assert.equal(await page.locator('.session-row[data-status="history"]').count(), 3);
  await secondGroup.locator('.session-row').click();
  await page.waitForFunction(() => document.querySelector('.message-assistant')?.textContent.includes('历史回复 1-0'));
  assert.equal(await page.locator('.session-row.active').getAttribute('data-workspace-id'), imported.find(workspace => workspace.cwd === projects[1]).id);
  await page.getByRole('button', { name: '收起 project-b', exact: true }).click();
  assert.match(await page.locator('.message-assistant').innerText(), /历史回复 1-0/);
  assert.equal(await secondGroup.count(), 0);
  await page.getByRole('button', { name: '展开 project-b', exact: true }).click();
  await page.getByTitle('查看终端原屏').click();
  await page.locator('.terminal-panel[data-readonly="true"]').waitFor();
  assert.match(await page.locator('.terminal-panel pre').innerText(), /没有运行中的终端/);
  await page.getByRole('button', { name: '关闭终端原屏', exact: true }).click();
  await page.screenshot({ path: path.join(resultDirectory, 'imported-history.png') });
  await page.getByRole('button', { name: '发现本机会话', exact: true }).first().click();
  await page.waitForFunction(() => document.querySelectorAll('.history-project-row[data-cwd]').length === 3);
  assert.equal(await page.locator('.history-project-row[data-cwd] input[type="checkbox"]:enabled').count(), 0, 'Imported and missing directories cannot be imported again');
  for (const [file, digest] of originals) assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), digest, 'Importing and viewing never changes source JSONL');
  const report = { success: true, scannedFiles: scan.scannedFiles, projects: scan.projects.length, imported: 2, sourceFilesUnchanged: true, nestedCompactTree: true };
  await writeFile(path.join(resultDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, resultDirectory }));
} catch (error) {
  await (await app?.firstWindow())?.screenshot({ path: path.join(resultDirectory, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
