// Several SSH machines, some not logged in. Every target IPC is replaced inside
// the app: no SSH process, no remote command and no model request.
// - Startup checks each machine once; problems show in the sidebar, not on top.
// - Settings and the folder dialog list every machine, also those known only from folders.
// - Going to a machine prompts for it; every login button targets the machine that failed.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from './fixtures/electron.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'lectern-ssh-status-'));
const results = path.resolve('test-results');
await mkdir(results, { recursive: true });
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: path.join(root, 'profile'), LECTERN_LOG_DIR: path.join(root, 'logs'),
  LECTERN_TEST_SSH_CONTROL_ROOT: root };
delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL;
const sessions = { alpha: randomUUID(), beta: randomUUID() };
let app;
try {
  const executablePath = process.argv[2];
  app = await _electron.launch({ args: executablePath ? [] : ['.'], ...(executablePath && { executablePath: path.resolve(executablePath) }), env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: '添加 SSH 机器', exact: true }).waitFor();
  await app.evaluate(({ ipcMain }, sessions) => {
    const fixture = globalThis.__sshStatus = { checks: [], logins: [], created: [], watches: [], loggedIn: new Set(['alpha-host']) };
    const denied = host => new Error(`${host}: Permission denied (publickey,password).`);
    const replace = (method, handler) => { ipcMain.removeHandler(`lectern:${method}`); ipcMain.handle(`lectern:${method}`, handler); };
    const workspaces = event => event.sender.executeJavaScript('window.desktop.listWorkspaces()');
    const folder = async (event, id) => (await workspaces(event)).find(item => item.id === id);
    replace('sshMasterState', async (_event, target) => fixture.loggedIn.has(target.host) ? 'private' : 'none');
    replace('checkSshConnection', async (_event, target) => {
      fixture.checks.push(target.host);
      return fixture.loggedIn.has(target.host) ? { ok: true } : { ok: false, message: denied(target.host).message };
    });
    // The machine's tmux / Claude Code check stays inside the fixture too: both are there.
    replace('checkHost', async (_event, target) => !fixture.loggedIn.has(target.host) ? { ok: false, message: denied(target.host).message }
      : { ok: true, tools: { system: 'Linux', distro: ['ubuntu'], managers: ['apt-get'], root: false,
        tmux: { path: '/usr/bin/tmux', version: 'tmux 3.4' }, claude: { path: '/home/dev/.local/bin/claude', version: '2.1.329 (Claude Code)' } } });
    replace('discover', async (event, id) => {
      const workspace = await folder(event, id);
      if (!fixture.loggedIn.has(workspace.host)) throw denied(workspace.host);
      return { workspace, panes: [], sessions: [{ id: sessions[id], title: `${workspace.name} 的对话`, path: `/r/${id}.jsonl`, updatedAt: '2026-11-01T00:00:00Z', mapping: 'unbound', status: 'history' }] };
    });
    replace('watchSession', async (event, id, sessionId) => {
      const workspace = await folder(event, id);
      fixture.watches.push(id);
      if (!fixture.loggedIn.has(workspace.host)) throw denied(workspace.host);
      return { workspaceId: id, sessionId, status: 'idle', navigationStatus: 'history', screen: '', viewport: '',
        messages: [{ id: `${sessionId}-a`, role: 'assistant', text: `来自 ${workspace.host} 的历史`, tools: [], source: 'jsonl', status: 'complete' }] };
    });
    replace('unwatchSession', async () => {});
    replace('resolveArtifactReferences', async () => []);
    replace('prefetchSession', async () => {});
    replace('prefetchFileIndex', async () => {});
    replace('gitChanges', async () => ({ kind: 'none' }));
    replace('modelCatalog', async () => ({ status: 'failed', error: 'synthetic: no model list' }));
    // Before launching, the app reads the settings files on the target: on a machine that is
    // not logged in that read fails the same way the launch would.
    replace('inspectConversationSettings', async (event, id) => {
      const workspace = await folder(event, id);
      if (!fixture.loggedIn.has(workspace.host)) throw denied(workspace.host);
      return { settingsFile: null, overrides: [] };
    });
    replace('createSession', async (event, id) => {
      const workspace = await folder(event, id);
      fixture.created.push(id);
      throw denied(workspace.host);
    });
    replace('sshLogin', async (_event, _loginId, target) => {
      fixture.logins.push(target.host);
      fixture.loggedIn.add(target.host);
      return 'connected';
    });
  }, sessions);
  // Folders on two machines, neither saved as a connection; the restored view is on the one not logged in.
  for (const [id, host] of [['alpha', 'alpha-host'], ['beta', 'beta-host']])
    await page.evaluate(workspace => window.desktop.saveWorkspace(workspace), { id, name: `${id} 项目`, kind: 'ssh', host, cwd: `/srv/${id}` });
  await page.evaluate(({ beta }) => {
    const key = 'lectern.desktop.preferences.v1', prefs = JSON.parse(localStorage.getItem(key) || '{}');
    localStorage.setItem(key, JSON.stringify({ ...prefs, panes: { primary: { workspaceId: 'beta', sessionId: beta, title: '' }, secondary: null } }));
    localStorage.setItem('lectern.expanded-projects.v1', JSON.stringify(['alpha', 'beta']));
  }, sessions);
  await page.reload();
  const fixture = () => app.evaluate(() => { const f = globalThis.__sshStatus; return { ...f, loggedIn: [...f.loggedIn] }; });

  const machine = host => page.locator(`.machine-section[data-machine-key='${JSON.stringify(['ssh', host, null])}']`);
  await machine('beta-host').locator('.machine-connection', { hasText: '未登录' }).waitFor();
  await page.waitForFunction(() => document.querySelector('.machine-section[data-connection="ok"]'));
  assert.equal(await machine('alpha-host').locator('.machine-connection').count(), 0);
  for (let i = 0; i < 20 && !(await fixture()).watches.includes('beta'); i++) await page.waitForTimeout(100);
  assert.ok((await fixture()).watches.includes('beta'), 'the restored conversation was opened');
  await page.waitForTimeout(800);
  assert.equal(await page.locator('.error-banner, .machine-prompt').count(), 0, 'startup problems stay in the sidebar');
  assert.deepEqual((await fixture()).checks.sort(), ['alpha-host', 'beta-host'], 'each machine is checked once at startup');
  await machine('beta-host').locator('.tree-note-error').getByRole('button', { name: '登录 beta-host', exact: true }).waitFor();

  // Settings and the folder dialog list both machines, though none is a saved connection.
  await page.getByRole('button', { name: '界面与连接设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.getByRole('button', { name: 'SSH 连接', exact: true }).click();
  assert.deepEqual(await settings.locator('[data-ssh-machine]').evaluateAll(rows => rows.map(row => row.dataset.sshMachine)), ['alpha-host', 'beta-host']);
  assert.match(await settings.locator('[data-ssh-machine="beta-host"]').innerText(), /未登录/);
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
  // Each machine adds folders to itself; adding one does not connect or prompt.
  await page.getByRole('button', { name: '在 beta-host 添加项目文件夹', exact: true }).click();
  const add = page.getByRole('dialog', { name: '添加项目文件夹' });
  assert.equal(await add.locator('.machine-endpoint').innerText(), 'beta-host');
  await page.keyboard.press('Escape');
  await add.waitFor({ state: 'detached' });

  // Going to the other machine is what raises a prompt, and its login targets that machine.
  await page.locator(`.session-row[data-session-id="${sessions.alpha}"]`).click();
  await page.getByText('来自 alpha-host 的历史').waitFor();
  assert.equal(await page.locator('.machine-prompt').count(), 0);
  await machine('beta-host').locator('.machine-toggle').click();
  const prompt = page.locator('.machine-prompt');
  await prompt.getByText('beta-host 尚未登录', { exact: false }).waitFor();
  assert.doesNotMatch(await prompt.innerText(), /invoking remote method/, 'the SSH error, without the IPC wrapper');
  await page.screenshot({ path: path.join(results, 'ssh-status-prompt.png') });
  // 重试 checks this machine again and keeps the prompt while it still fails.
  await prompt.getByRole('button', { name: '重试', exact: true }).click();
  for (let i = 0; i < 50 && (await fixture()).checks.length < 3; i++) await page.waitForTimeout(100);
  assert.deepEqual((await fixture()).checks.slice(2), ['beta-host']);
  await prompt.getByText('beta-host 尚未登录', { exact: false }).waitFor();
  await prompt.getByRole('button', { name: '登录 beta-host', exact: true }).click();
  await page.getByRole('dialog', { name: '登录 SSH' }).waitFor({ state: 'detached' });
  assert.deepEqual((await fixture()).logins, ['beta-host']);
  await prompt.waitFor({ state: 'detached' });
  await page.waitForFunction(() => !document.querySelector('.machine-connection'));

  // A new chat on the other machine fails to start: its banner logs in to that machine.
  await app.evaluate(() => globalThis.__sshStatus.loggedIn.delete('beta-host'));
  await machine('beta-host').locator('.machine-toggle').click();
  await page.getByRole('button', { name: '在 beta 项目 新建对话', exact: true }).click();
  await page.getByRole('textbox', { name: '发送给 Claude 的消息' }).fill('第一条消息');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const banner = page.locator('.error-banner');
  await banner.getByText('beta-host: Permission denied', { exact: false }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '发送给 Claude 的消息' }).inputValue(), '第一条消息', 'the message is kept');
  assert.equal(await banner.getByRole('button', { name: '登录 alpha-host' }).count(), 0, 'not another machine');
  await banner.getByRole('button', { name: '登录 beta-host', exact: true }).click();
  await page.getByRole('dialog', { name: '登录 SSH' }).waitFor({ state: 'detached' });
  assert.deepEqual((await fixture()).logins, ['beta-host', 'beta-host']);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks: (await fixture()).checks, logins: (await fixture()).logins }));
} finally {
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
