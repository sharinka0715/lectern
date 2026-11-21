// node scripts/host-check-e2e.mjs [packaged-executable]
// The check that tmux and Claude Code are usable on a machine, on a local folder whose
// PATH lacks them. Nothing is uninstalled: LECTERN_LOCAL_PATH points local commands at a
// sandbox that links every system command except tmux and claude, and tools are
// "installed" by linking them into it. Covers the notice (both languages, with
// screenshots), the install commands, Recheck, the blocked new chat / resume, the
// gentle outdated-version warning, the normal path, and an SSH machine whose check
// fails to connect (shown as "signed out", never as a missing tool). No Claude process
// starts and no model or real SSH machine is contacted (ssh is a local stub that refuses).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron } from 'playwright';

const root = await realpath(await mkdtemp('/tmp/lectern-host-check-'));
const results = path.resolve('test-results');
const profile = path.join(root, 'profile'), config = path.join(root, 'claude'), cwd = path.join(root, 'work');
const sys = path.join(root, 'sys'), tools = path.join(root, 'tools'), stubs = path.join(root, 'stubs');
const project = path.join(config, 'projects', cwd.replace(/[^a-z0-9-]/gi, '-'));
const sessionId = randomUUID(), sshHost = 'auth-fail.example';
const realTmux = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8',
  env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` } }).stdout.trim();
assert.ok(realTmux.startsWith('/'), 'tmux is installed on this machine (the test only hides it)');

/** Every system command except tmux and claude, plus Homebrew's launcher (for realistic macOS hints). */
async function systemShim() {
  await mkdir(sys, { recursive: true });
  for (const directory of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
    for (const name of await readdir(directory).catch(() => [])) {
      if (name === 'tmux' || name === 'claude') continue;
      await symlink(path.join(directory, name), path.join(sys, name)).catch(() => { /* already linked */ });
    }
  }
  for (const brew of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) if (existsSync(brew)) { await symlink(brew, path.join(sys, 'brew')).catch(() => {}); break; }
}
const fakeClaude = version => writeFile(path.join(tools, 'claude'),
  `#!/bin/sh\n[ "$1" = --version ] && { echo '${version} (Claude Code)'; exit 0; }\necho 'fake claude: not for sessions' >&2; exit 1\n`, { mode: 0o755 });
const uninstall = async () => { for (const name of ['tmux', 'claude']) await unlink(path.join(tools, name)).catch(() => {}); };
const history = [
  { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: '检查主机工具' } },
  { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '历史仍可阅读。' }], stop_reason: 'end_turn' } },
].map(record => JSON.stringify({ ...record, cwd, sessionId, timestamp: new Date().toISOString() })).join('\n') + '\n';

async function launch(locale) {
  const env = { ...process.env, LECTERN_LOCALE: locale, LECTERN_USER_DATA: profile, LECTERN_LOG_DIR: path.join(root, 'logs'), TMUX_TMPDIR: root,
    LECTERN_DIAGNOSTIC_CONTENT: '0', LECTERN_LOCAL_PATH: `${tools}:${sys}`, PATH: `${stubs}:${process.env.PATH}` };
  delete env.LECTERN_DEV_URL; delete env.ELECTRON_RUN_AS_NODE; delete env.TMUX; delete env.TMUX_PANE;
  const exe = process.argv[2];
  const app = await _electron.launch({ args: exe ? [] : ['.'], ...(exe && { executablePath: path.resolve(exe) }), env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Copy buttons write here instead of the system clipboard.
  await app.evaluate(({ ipcMain }) => {
    globalThis.__copied = [];
    ipcMain.removeHandler('lectern:copyText');
    ipcMain.handle('lectern:copyText', (_event, text) => { globalThis.__copied.push(text); });
  });
  return { app, page, errors };
}
const local = page => page.locator('.machine-section[data-machine-key="local"]');
const notice = page => page.locator('.host-tools-notice[data-machine-key="local"]');
const missing = (page, tools) => page.locator(`.host-tools-notice[data-machine-key="local"][data-missing="${tools}"]`);
const composer = (page, locale = 'zh-CN') => page.getByLabel(locale === 'en' ? 'Message to Claude' : '发送给 Claude 的消息', { exact: true });
const sessionRow = page => page.locator(`.session-row[data-session-id="${sessionId}"]`);
/** What starting a chat in the folder answers (the backend refuses on its own, whatever the UI shows). */
const startChat = page => page.evaluate(() => window.desktop.createSession('local-folder', {}).then(() => 'started', error => error.message));

let app;
try {
  await Promise.all([profile, cwd, project, tools, stubs].map(directory => mkdir(directory, { recursive: true })));
  await systemShim();
  // ssh: the target refuses the key, as an SSH machine that needs a login would.
  await writeFile(path.join(stubs, 'ssh'), `#!/bin/sh\necho "dev@${sshHost}: Permission denied (publickey)." >&2\nexit 255\n`, { mode: 0o755 });
  await writeFile(path.join(project, `${sessionId}.jsonl`), history);
  await writeFile(path.join(profile, 'workspaces.json'), JSON.stringify([
    { id: 'local-folder', name: '主机检查', kind: 'local', cwd, claudeDir: config },
    { id: 'ssh-folder', name: '远程目录', kind: 'ssh', host: sshHost, cwd: '/srv/work' },
  ]));

  // 1. Neither tool: a notice that names both, with commands for this system, and no way to close it.
  let launched = await launch('zh-CN'), page = launched.page;
  app = launched.app;
  await missing(page, 'tmux claude').waitFor();
  const text = await notice(page).innerText();
  assert.match(text, /本机缺少 tmux 和 Claude Code/);
  assert.match(text, /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/, 'the official Claude Code installer');
  if (process.platform === 'darwin') assert.match(text, /brew install tmux/);
  else if (existsSync('/usr/bin/apt-get')) assert.match(text, /sudo apt install tmux|apt install tmux/);
  else if (existsSync('/usr/bin/dnf')) assert.match(text, /dnf install tmux/);
  assert.deepEqual(await notice(page).getByRole('button').evaluateAll(buttons => buttons.map(b => b.getAttribute('aria-label') ?? b.textContent?.trim())).then(names => [...new Set(names)]),
    ['复制命令', '重新检查'], 'only copy buttons and Recheck: the notice cannot be dismissed');
  await local(page).locator('.machine-connection.state-missing', { hasText: '缺少工具' }).waitFor();
  await local(page).locator('.tree-note-error', { hasText: '缺少 tmux，无法列出对话' }).waitFor();
  // The folder could not be listed (no tmux); the notice already says why, so no second error bar.
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.error-banner').count(), 0);
  await page.locator('.new-chat-button').click();
  await page.waitForFunction(() => document.querySelector('textarea')?.placeholder.includes('本机缺少 tmux 和 Claude Code'));
  assert.equal(await composer(page).isDisabled(), true, 'a new chat cannot start');
  const refused = await startChat(page);
  assert.match(refused, /本机找不到 tmux 和 Claude Code。/);
  assert.match(refused, /安装后点「重新检查」/);
  await notice(page).locator('[data-tool="tmux"] .host-tools-command button').first().click();
  const copied = await app.evaluate(() => globalThis.__copied);
  assert.equal(copied.length, 1);
  assert.match(copied[0], /tmux/);
  await mkdir(results, { recursive: true });
  await page.screenshot({ path: path.join(results, 'host-check-notice-zh-CN.png') });

  // 2. tmux installed: Recheck leaves only Claude Code. History can be listed and read, but not resumed.
  await symlink(realTmux, path.join(tools, 'tmux'));
  await notice(page).getByRole('button', { name: '重新检查' }).click();
  await missing(page, 'claude').waitFor();
  assert.match(await notice(page).locator('strong').innerText(), /^本机缺少 Claude Code$/);
  await sessionRow(page).click();
  await page.locator('.message-assistant').getByText('历史仍可阅读。').waitFor();
  const resume = page.locator('.resume-bar').getByRole('button', { name: '续接会话' });
  await resume.waitFor();
  assert.equal(await resume.isDisabled(), true, 'a saved conversation cannot be resumed without Claude Code');
  assert.match(await composer(page).getAttribute('placeholder'), /本机缺少 Claude Code/);
  assert.match(await startChat(page), /HostToolsError: 本机找不到 Claude Code。/, 'only what is still missing');
  assert.match(await page.evaluate(id => window.desktop.resumeSession('local-folder', id).then(() => 'resumed', error => error.message), sessionId), /找不到 Claude Code/);

  // 3. Claude Code installed (an old one): the notice goes, only a gentle warning stays; a new chat can be typed.
  await fakeClaude('2.1.250');
  await notice(page).getByRole('button', { name: '重新检查' }).click();
  await notice(page).waitFor({ state: 'detached' });
  const outdated = page.locator('.host-tools-outdated[data-machine-key="local"]');
  await outdated.waitFor();
  assert.match(await outdated.innerText(), /本机的 Claude Code 2\.1\.250 早于 Lectern 测试过的最早版本 2\.1\.300/);
  assert.match(await outdated.innerText(), /claude update/);
  assert.equal(await local(page).locator('.machine-connection').count(), 0, 'the sidebar mark is gone');
  assert.equal(await resume.isDisabled(), false, 'resuming is allowed again');
  await page.locator('.new-chat-button').click();
  await page.waitForFunction(() => !document.querySelector('textarea')?.disabled);
  await composer(page).fill('不会发送');
  await outdated.getByRole('button', { name: '关闭提示' }).click();
  await outdated.waitFor({ state: 'detached' });
  const result = await page.evaluate(() => window.desktop.checkHost({ kind: 'local' }));
  assert.ok(result.ok && result.tools.tmux.path && result.tools.claude.version === '2.1.250 (Claude Code)', JSON.stringify(result));

  // 4. An SSH machine that refuses the connection: the check fails, which is not a missing tool.
  const sshCheck = await page.evaluate(host => window.desktop.checkHost({ kind: 'ssh', host }), sshHost);
  assert.equal(sshCheck.ok, false);
  assert.match(sshCheck.message, /Permission denied/);
  const remote = page.locator(`.machine-section[data-machine-key='${JSON.stringify(['ssh', sshHost, null])}']`);
  await remote.locator('.machine-connection.state-login', { hasText: '未登录' }).waitFor();
  await remote.locator('.machine-open').click();
  // Said by the machine's login prompt, or by the folder's error bar with its login button.
  await page.locator('.machine-prompt, .error-banner').filter({ hasText: /尚未登录|Permission denied/ }).first().waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.host-tools-notice').count(), 0, 'no tool is claimed missing on a machine that could not be reached');
  assert.equal(await page.locator('.host-check-failed').count(), 0, 'the login prompt already explains it');
  assert.equal(await remote.locator('.state-missing').count(), 0);
  assert.match(await page.evaluate(() => window.desktop.createSession('ssh-folder', {}).then(() => 'started', error => error.message)), /Permission denied/);
  assert.deepEqual(launched.errors, []);
  await app.close(); app = undefined;

  // 5. English: the same notice, both tools missing again.
  await uninstall();
  launched = await launch('en'); app = launched.app; page = launched.page;
  await local(page).locator('.machine-open').click();
  await missing(page, 'tmux claude').waitFor();
  const english = await notice(page).innerText();
  assert.match(english, /This computer is missing tmux and Claude Code/);
  assert.match(english, /Install tmux[\s\S]*Install Claude Code/);
  assert.match(english, /Official installer \(recommended\):/);
  await page.waitForFunction(() => document.querySelector('textarea')?.placeholder.includes('This computer is missing tmux and Claude Code'));
  // Going to the machine rechecked it: the screenshot waits for the answer.
  await notice(page).getByRole('button', { name: 'Recheck' }).and(page.locator(':enabled')).waitFor();
  await page.screenshot({ path: path.join(results, 'host-check-notice-en.png') });
  assert.deepEqual(launched.errors, []);
  console.log(JSON.stringify({ ok: true, platform: process.platform, screenshots: ['host-check-notice-zh-CN.png', 'host-check-notice-en.png'] }));
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
