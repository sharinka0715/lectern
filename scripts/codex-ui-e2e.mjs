// Run through npm run test:all -- --only codex-ui-e2e after npm run build.
// Real Electron, the normal Codex IPC, and the existing offline Claude TUI.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';

if (process.platform === 'win32') {
  console.log('SKIP: Windows does not expose local Codex workspaces.');
  process.exit(0);
}

const root = await realpath(await mkdtemp('/tmp/lectern-codex-ui-'));
const cwd = path.join(root, 'work'), config = path.join(root, 'claude');
const profile = path.join(root, 'profile'), bin = path.join(root, 'bin');
const project = path.join(config, 'projects', cwd.replace(/[^a-zA-Z0-9-]/g, '-'));
const historyId = randomUUID();
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const fixture = name => fileURLToPath(new URL(name, import.meta.url));
const tmux = spawnSync('/bin/sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
const isolatedPath = [bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter);
const env = {
  ...process.env,
  PATH: isolatedPath,
  LECTERN_LOCAL_PATH: isolatedPath,
  LECTERN_USER_DATA: profile,
  LECTERN_LOCALE: 'zh-CN',
  LECTERN_NODE_BINARY: process.execPath,
  LECTERN_DIAGNOSTIC_CONTENT: '0',
  TMUX_TMPDIR: root,
  CLAUDE_CONFIG_DIR: config,
  CODEX_HOME: path.join(root, 'codex'),
  NVM_DIR: path.join(root, 'nvm'),
};
for (const name of ['ELECTRON_RUN_AS_NODE', 'LECTERN_DEV_URL', 'TMUX', 'TMUX_PANE']) delete env[name];

async function setup() {
  assert.ok(path.isAbsolute(tmux), 'tmux is required for the offline Claude fixture');
  await Promise.all([cwd, profile, bin, project].map(dir => mkdir(dir, { recursive: true })));
  await writeFile(path.join(bin, 'tmux'), '#!/bin/sh\nexec ' + quote(tmux) + ' -f /dev/null "$@"\n', { mode: 0o700 });
  await writeFile(path.join(bin, 'claude'), [
    '#!/bin/bash',
    'if [ "$1" = --version ]; then echo "2.1.329 (Claude Code)"; exit; fi',
    'if [ "$1" = auth ]; then exit 0; fi',
    'exec -a claude ' + [process.execPath, fixture('./mock-claude.mjs'), '--fixture-config', config].map(quote).join(' ') + ' "$@"',
    '',
  ].join('\n'), { mode: 0o700 });
  await writeFile(path.join(bin, 'codex'), '#!/bin/sh\nexec ' +
    [process.execPath, fixture('./fixtures/codex-app-server.mjs'), path.join(root, 'rollout.json')].map(quote).join(' ') + ' "$@"\n', { mode: 0o700 });
  await writeFile(path.join(profile, 'workspaces.json'), JSON.stringify([
    { id: 'codex-fixture', name: 'Codex worktree', kind: 'local', cwd, claudeDir: config },
  ]));
  const history = [
    { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'Claude fixture conversation' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: {
      id: 'm1', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Claude fixture reply' }],
    } },
  ];
  await writeFile(path.join(project, historyId + '.jsonl'), history.map(record => JSON.stringify({
    ...record, sessionId: historyId, cwd, timestamp: new Date().toISOString(),
  })).join('\n') + '\n');
}

let app, page;
const pageErrors = [];
async function launch() {
  app = await _electron.launch({ args: ['.'], env, timeout: 60_000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => pageErrors.push(error.message));
}

async function openPanel() {
  await page.getByRole('button', { name: '打开 Codex 会话', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Codex 会话', exact: true });
  await panel.waitFor();
  return panel;
}

async function closePanel(panel) {
  await panel.getByRole('button', { name: '关闭 Codex 面板', exact: true }).click();
  await panel.waitFor({ state: 'detached' });
}

async function sendMessage(panel, text) {
  await panel.getByRole('textbox', { name: '给 Codex 发消息…', exact: true }).fill(text);
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await panel.locator('.codex-transcript').getByText(text, { exact: true }).waitFor();
}

const claudeRow = () => page.locator(`.session-row[data-session-id="${historyId}"]`);
const chat = (panel, title) => panel.locator('.codex-thread').filter({ hasText: title });

try {
  await setup();
  await launch();
  await page.locator('.workspace-row[data-workspace-id="codex-fixture"]').waitFor();
  const expand = page.getByRole('button', { name: '展开 Codex worktree', exact: true });
  if (await expand.isVisible() && !(await claudeRow().isVisible())) await expand.click();
  await claudeRow().click();
  await page.getByText('Claude fixture reply', { exact: true }).waitFor();

  let panel = await openPanel();
  const newChat = () => panel.getByRole('button', { name: '新建 Codex 会话', exact: true });
  await panel.getByText('在此文件夹中新建 Codex 会话。', { exact: false }).waitFor();
  await newChat().click();
  await sendMessage(panel, 'Codex approval');
  await panel.locator('.codex-assistant strong', { hasText: 'Partial Codex reply' }).waitFor();
  await panel.getByText('printf offline-demo', { exact: false }).waitFor();
  await panel.getByRole('button', { name: '允许本次操作', exact: true }).click();
  await panel.getByText('Approval received: accept', { exact: true }).waitFor();

  await sendMessage(panel, 'Keep Codex running');
  await panel.getByText('Codex is still working', { exact: true }).waitFor();
  await newChat().click();
  await sendMessage(panel, 'Newer Codex chat');
  await panel.getByText('Newer Codex reply', { exact: true }).waitFor();

  const sort = () => panel.getByRole('combobox', { name: '排序方式', exact: true });
  const threadTitles = () => panel.locator('.codex-thread').evaluateAll(threads => threads.map(thread => thread.title));
  assert.deepEqual(await threadTitles(), ['Newer Codex chat', 'Codex approval']);
  await sort().selectOption({ label: '对话优先' });
  assert.deepEqual(await threadTitles(), ['Codex approval', 'Newer Codex chat']);
  assert.equal(await chat(panel, 'Newer Codex chat').getAttribute('aria-current'), 'true');

  // Switching back to the active Claude session must not stop the other agent.
  await closePanel(panel);
  assert.equal(await claudeRow().getAttribute('aria-current'), 'page');
  await page.getByRole('button', { name: '续接会话', exact: true }).click();
  await page.getByRole('textbox', { name: '发送给 Claude 的消息', exact: true }).fill('Claude during Codex');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.locator('.message-assistant[data-source="jsonl"]').filter({ hasText: 'Claude during Codex' }).last().waitFor();

  panel = await openPanel();
  await chat(panel, 'Codex approval').click();
  const stop = panel.getByRole('button', { name: '停止回复', exact: true });
  await stop.click();
  await stop.waitFor({ state: 'detached' });
  assert.equal(await panel.locator('.codex-approval').count(), 0);
  await closePanel(panel);
  await app.close();
  app = undefined;

  await launch();
  panel = await openPanel();
  await chat(panel, 'Codex approval').click();
  await panel.getByText('Approval received: accept', { exact: true }).waitFor();
  await panel.getByText('Keep Codex running', { exact: true }).last().waitFor();
  await panel.getByText('Codex is still working', { exact: true }).waitFor();
  await chat(panel, 'Newer Codex chat').click();
  await panel.getByText('Newer Codex reply', { exact: true }).waitFor();
  assert.equal(await sort().locator('option:checked').textContent(), '对话优先');
  await closePanel(panel);
  assert.equal(await claudeRow().getAttribute('aria-current'), 'page');
  await page.locator('.message-assistant').filter({ hasText: 'Claude during Codex' }).last().waitFor();
  assert.deepEqual(pageErrors, []);
  console.log('PASS: Codex streaming, approvals, sorting, interruption and restart alongside live Claude.');
} catch (error) {
  await mkdir('test-results', { recursive: true });
  await page?.screenshot({ path: 'test-results/codex-ui-failure.png', timeout: 5_000 }).catch(() => {});
  throw error;
} finally {
  if (app) {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }).catch(() => {});
    await app.close().catch(() => {});
  }
  if (tmux) spawnSync(tmux, ['kill-server'], { env, stdio: 'ignore' });
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
