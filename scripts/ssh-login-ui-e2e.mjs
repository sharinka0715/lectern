// In-app SSH login: password, one-time code and a new host key are asked in the
// dialog, relayed through the real askpass helper (Electron as Node) to a scripted
// OpenSSH, and never written to diagnostics. No real machine is contacted.
// Optional argument: a packaged executable or electron-builder output directory
// (on macOS the relay must then run in the app's LSUIElement helper, not the app).
import assert from 'node:assert/strict';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from './fixtures/electron.mjs';
import { packagedExecutable } from './package-executable.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'lectern-ssh-login-ui-'));
const controlRoot = await mkdtemp('/tmp/ltc-ui-');
const profile = path.join(root, 'profile'), state = path.join(root, 'ssh');
await mkdir(state, { recursive: true });
const results = path.resolve('test-results');
await mkdir(results, { recursive: true });
const password = 'pa ss"word', code = '482913';
// -G prints config, -O check reports the master, -f -N authenticates through
// $SSH_ASKPASS. Other commands need a master, as BatchMode=yes would.
await writeFile(path.join(state, 'ssh'), `#!/bin/sh
state=${JSON.stringify(state)}
printf '%s\\n' "$*" >> "$state/calls"
# With user-config, ssh_config multiplexes with ControlPersist and master-user is the user's own master.
case " $* " in *" -o ControlPath="*) socket=private;; *) socket=; [ -f "$state/user-config" ] && socket=user;; esac
case " $* " in
  *" -V "*) printf 'OpenSSH_9.8p1, LibreSSL 3.3.6\\n' >&2; exit 0;;
  *" -G "*) if [ -f "$state/user-config" ]; then printf 'hostname lab\\ncontrolpath /tmp/ssh-user-%%C\\ncontrolmaster auto\\ncontrolpersist 600\\n'; else printf 'hostname lab\\ncontrolpath none\\n'; fi; exit 0;;
  *" -O check "*) [ -n "$socket" ] && [ -f "$state/master-$socket" ] && exit 0; exit 255;;
  *" -O stop "*|*" -O exit "*) [ -n "$socket" ] && rm -f "$state/master-$socket"; exit 0;;
  *" -f -N "*)
    printf '%s\\n' "$LECTERN_ASKPASS_NODE" > "$state/askpass-node"
    printf '%s\\n' "\${DISPLAY-unset}" > "$state/display"
    printf 'Welcome to the lab cluster\\n' >&2
    if [ -f "$state/hostkey" ]; then
      reply=$("$SSH_ASKPASS" "The authenticity of host 'lab (192.0.2.2)' can't be established.
ED25519 key fingerprint is SHA256:Q2xhdWRlIFRldGhlciBsb2dpbiB0ZXN0.
Are you sure you want to continue connecting (yes/no/[fingerprint])? ") || exit 255
      [ "$reply" = yes ] || { printf 'Host key verification failed.\\n' >&2; exit 255; }
      rm -f "$state/hostkey"
    fi
    secret=$("$SSH_ASKPASS" "dev@lab's password: ") || { printf 'Permission denied (keyboard-interactive).\\n' >&2; exit 255; }
    printf 'Duo two-factor login required\\n' >&2
    otp=$("$SSH_ASKPASS" "Verification code: ") || { printf 'Permission denied (keyboard-interactive).\\n' >&2; exit 255; }
    if [ "$secret" = ${JSON.stringify(password)} ] && [ "$otp" = ${code} ]; then : > "$state/master-$socket"; exit 0; fi
    printf 'Permission denied (keyboard-interactive).\\n' >&2; exit 255;;
  *) [ -n "$socket" ] && [ -f "$state/master-$socket" ] && PATH="$state/host:$PATH" && exec sh -s
     printf 'dev@lab: Permission denied (keyboard-interactive).\\n' >&2; exit 255;;
esac
`, { mode: 0o700 });
// The scripted host runs its commands on this computer and has a tmux of its own on PATH:
// a version and no server (no sessions yet). Without it the host check reads the runner's
// tools, and on a runner without tmux (macos-latest) adding a folder shows "tmux missing"
// before any connection is tried, never the login error below.
await mkdir(path.join(state, 'host'));
await writeFile(path.join(state, 'host', 'tmux'), `#!/bin/sh
case " $* " in *" -V "*) printf 'tmux 3.4\\n'; exit 0;; esac
printf 'no server running on /tmp/tmux-%s/default\\n' "$(id -u)" >&2; exit 1
`, { mode: 0o700 });

const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', PATH: `${state}:${process.env.PATH}`, LECTERN_USER_DATA: profile,
  LECTERN_NODE_BINARY: process.execPath, LECTERN_TEST_SSH_CONTROL_ROOT: controlRoot };
delete env.ELECTRON_RUN_AS_NODE;
delete env.LECTERN_DEV_URL;
const exists = file => access(file).then(() => true, () => false);
let app;
try {
  const executablePath = process.argv[2] && await packagedExecutable(process.argv[2]);
  app = await electron.launch({ ...(executablePath && { executablePath }), args: executablePath ? [] : ['.'], env, timeout: 60000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const login = page.getByRole('dialog', { name: '登录 SSH' });

  // Saving a machine does not connect; login is the user's explicit step.
  await page.getByRole('button', { name: '添加 SSH 机器', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.getByLabel('连接名称').fill('实验集群');
  await settings.getByLabel('SSH 主机', { exact: true }).fill('lab-alias');
  // A stray keystroke into the focused test window would change the host and reach the real ssh.
  assert.equal(await settings.getByLabel('SSH 主机', { exact: true }).inputValue(), 'lab-alias');
  await settings.getByRole('button', { name: '保存连接' }).click();
  await settings.waitFor({ state: 'detached' });
  assert.equal(await exists(path.join(state, 'calls')), false, 'saving a machine runs no ssh');
  const machine = page.getByRole('region', { name: '实验集群', exact: true });
  await machine.getByRole('button', { name: '登录 实验集群', exact: true }).click();
  await login.waitFor();
  assert.match(await login.innerText(), /实验集群（lab-alias）/);
  const field = login.locator('#ssh-login-input');
  await login.getByText("dev@lab's password:", { exact: true }).waitFor();
  assert.equal(await field.getAttribute('type'), 'password');
  await field.fill(password);
  await field.press('Enter');
  await login.getByText('Verification code:', { exact: true }).waitFor();
  assert.equal(await field.getAttribute('type'), 'text', 'a one-time code is visible while typed');
  assert.match(await login.getByLabel('服务器消息').innerText(), /Duo two-factor login required/);
  await page.screenshot({ path: path.join(results, 'ssh-login-code.png') });
  await field.fill(code);
  await login.getByRole('button', { name: '继续', exact: true }).click();
  await login.getByText('已登录', { exact: false }).waitFor();
  await login.waitFor({ state: 'detached' });
  assert.ok(await exists(path.join(state, 'master-private')), 'the master is left running for later commands');
  const loginCall = (await readFile(path.join(state, 'calls'), 'utf8')).split('\n').find(line => line.includes('-f -N'));
  assert.match(loginCall, /BatchMode=no .*StrictHostKeyChecking=ask .*ControlMaster=yes -o ControlPersist=3600 -o ControlPath=[^ ]*\/lssh-/);
  // The relay ran as Node in Electron's helper on macOS (LSUIElement: no second Dock
  // icon), in the executable elsewhere; ssh says it is 8.4+, so no DISPLAY is made up.
  const { execPath, platform } = await app.evaluate(() => ({ execPath: process.execPath, platform: process.platform }));
  const askpassNode = (await readFile(path.join(state, 'askpass-node'), 'utf8')).trim();
  const bundle = /^(.+\.app)\/Contents\/MacOS\/([^/]+)$/.exec(execPath);
  assert.equal(askpassNode, platform === 'darwin' && bundle
    ? `${bundle[1]}/Contents/Frameworks/${bundle[2]} Helper.app/Contents/MacOS/${bundle[2]} Helper` : execPath);
  assert.equal((await readFile(path.join(state, 'display'), 'utf8')).trim(), env.DISPLAY || 'unset');
  console.log(`askpass relay ran in ${askpassNode}`);

  // Settings offers login per connection too; an existing master needs no prompt.
  await page.getByRole('button', { name: '界面与连接设置', exact: true }).click();
  await settings.getByRole('button', { name: 'SSH 连接', exact: true }).click();
  await settings.getByRole('button', { name: '登录 实验集群', exact: true }).click();
  await login.getByText('这台机器已有可复用的连接', { exact: false }).waitFor();
  await login.waitFor({ state: 'detached' });
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();

  // A new host key shows its fingerprint and needs an explicit choice; a wrong code can be retried.
  await rm(path.join(state, 'master-private'));
  await writeFile(path.join(state, 'hostkey'), '');
  await machine.getByRole('button', { name: '登录 实验集群', exact: true }).click();
  await login.getByText('SHA256:Q2xhdWRlIFRldGhlciBsb2dpbiB0ZXN0', { exact: false }).waitFor();
  await page.screenshot({ path: path.join(results, 'ssh-login-hostkey.png') });
  await login.getByRole('button', { name: '信任并继续', exact: true }).click();
  await field.fill(password); await field.press('Enter');
  await login.getByText('Verification code:', { exact: true }).waitFor();
  await field.fill('000000'); await field.press('Enter');
  await login.getByRole('alert').getByText('Permission denied', { exact: false }).waitFor();
  await login.getByRole('button', { name: '重新登录', exact: true }).click();
  await login.getByText("dev@lab's password:", { exact: true }).waitFor();
  await field.fill(password); await field.press('Enter');
  await login.getByText('Verification code:', { exact: true }).waitFor();
  await field.fill(code); await field.press('Enter');
  await login.waitFor({ state: 'detached' });
  assert.ok(await exists(path.join(state, 'master-private')));

  // Cancelling stops OpenSSH; no master is left behind.
  await rm(path.join(state, 'master-private'));
  await machine.getByRole('button', { name: '登录 实验集群', exact: true }).click();
  await login.getByText("dev@lab's password:", { exact: true }).waitFor();
  await login.getByRole('button', { name: '取消', exact: true }).click();
  await login.waitFor({ state: 'detached' });
  assert.equal(await exists(path.join(state, 'master-private')), false);

  // A folder on a machine that is not logged in offers login from the error, then reads the folder.
  const remote = path.join(root, 'remote project');
  await mkdir(remote);
  await machine.getByRole('button', { name: '在 实验集群 添加项目文件夹' }).click();
  const folder = page.getByRole('dialog', { name: '添加项目文件夹' });
  await folder.getByLabel('工作目录', { exact: true }).fill(remote);
  await folder.getByRole('button', { name: '添加目录', exact: true }).click();
  const banner = page.locator('.error-banner');
  await banner.getByText('Permission denied', { exact: false }).waitFor();
  // The login button names the machine the failure came from.
  await banner.getByRole('button', { name: '登录 实验集群', exact: true }).click();
  await field.fill(password); await field.press('Enter');
  await login.getByText('Verification code:', { exact: true }).waitFor();
  await field.fill(code); await field.press('Enter');
  await login.waitFor({ state: 'detached' });
  await page.locator('.error-banner').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '新建对话', exact: false }).first().waitFor();

  // 「复用已有的 SSH 连接」: on by default. The user's terminal now runs a master from
  // ssh_config (with ControlPersist), next to Lectern's own.
  await writeFile(path.join(state, 'user-config'), '');
  await writeFile(path.join(state, 'master-user'), '');
  const sshCalls = async () => (await readFile(path.join(state, 'calls'), 'utf8')).trim().split('\n');
  const commandsSince = async mark => (await sshCalls()).slice(mark).filter(line => line.endsWith('exec sh -s'));
  const check = () => page.evaluate(() => window.desktop.checkSshConnection({ host: 'lab-alias' }));
  await page.getByRole('button', { name: '界面与连接设置', exact: true }).click();
  await settings.getByRole('button', { name: 'SSH 连接', exact: true }).click();
  const reuse = settings.getByLabel('复用已有的 SSH 连接', { exact: true });
  const keep = settings.getByLabel('退出后保留 SSH 连接', { exact: true });
  await page.waitForFunction(() => !document.querySelector('.pref-ssh-connection input')?.disabled);
  assert.equal(await reuse.isChecked(), true, 'reuse is the default');
  assert.equal(await keep.inputValue(), '3600');
  assert.deepEqual(await keep.locator('option').allTextContents(), ['退出时断开', '15 分钟', '1 小时', '4 小时', '8 小时', '24 小时']);
  await keep.selectOption('900');
  await page.screenshot({ path: path.join(results, 'ssh-connection-setting.png') });
  // Off, then on again: sharing again, Lectern's own master for this machine stops taking sessions.
  await reuse.uncheck();
  await reuse.check();
  await page.waitForFunction(async () => (await window.desktop.sshConnectionPreferences()).reuseConnections === true);
  // Saved first, then applied: the stop follows a moment later.
  const stopped = async () => (await sshCalls()).some(line => /ControlPath=[^ ]*\/lssh-.* -O stop lab-alias$/.test(line));
  for (let i = 0; i < 100 && (!await stopped() || await exists(path.join(state, 'master-private'))); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(await stopped(), 'the private master was told to stop');
  assert.equal(await exists(path.join(state, 'master-private')), false);
  let mark = (await sshCalls()).length;
  assert.deepEqual(await check(), { ok: true });
  assert.ok((await commandsSince(mark)).every(line => line.includes('ControlMaster=no') && !line.includes('ControlPath=')), 'commands use the user\'s master');
  const disconnect = settings.getByRole('button', { name: '断开 实验集群', exact: true });
  await page.waitForFunction(() => document.querySelector('[data-ssh-machine="lab-alias"] button[disabled][title*="自己的 SSH 连接"]'));
  assert.equal(await disconnect.isDisabled(), true, 'the user master cannot be disconnected');
  await settings.getByRole('button', { name: '登录 实验集群', exact: true }).click();
  await login.getByText('这台机器已有可复用的连接', { exact: false }).waitFor();
  await login.waitFor({ state: 'detached' });
  // Off: only Lectern's own connection. With no master of its own yet, the machine asks for a login,
  // which leaves a private master even though ssh_config would persist one.
  await reuse.uncheck();
  // The transport applies the new preference after the settings file is written.
  let refused;
  for (let i = 0; i < 100; i++) {
    mark = (await sshCalls()).length;
    refused = await check();
    if (!refused.ok) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(refused.ok, false);
  assert.match(refused.message, /Permission denied/);
  assert.ok((await commandsSince(mark)).every(line => /ControlPath=[^ ]*\/lssh-/.test(line)), 'commands no longer use the user\'s master');
  assert.deepEqual(JSON.parse(await readFile(path.join(profile, 'ssh-settings.json'), 'utf8')), { reuseConnections: false, keepAliveSeconds: 900 });
  mark = (await sshCalls()).length;
  await settings.getByRole('button', { name: '登录 实验集群', exact: true }).click();
  await login.getByText("dev@lab's password:", { exact: true }).waitFor();
  await field.fill(password); await field.press('Enter');
  await login.getByText('Verification code:', { exact: true }).waitFor();
  await field.fill(code); await field.press('Enter');
  await login.waitFor({ state: 'detached' });
  const exclusiveLogin = (await sshCalls()).slice(mark).find(line => line.includes('BatchMode=no'));
  assert.match(exclusiveLogin, /^-f -N .*ControlMaster=yes -o ControlPersist=900 -o ControlPath=[^ ]*\/lssh-/);
  assert.ok(await exists(path.join(state, 'master-private')));
  assert.ok(await exists(path.join(state, 'master-user')), 'the user\'s master is left alone');
  mark = (await sshCalls()).length;
  assert.deepEqual(await check(), { ok: true });
  assert.ok((await commandsSince(mark)).every(line => /ControlPath=[^ ]*\/lssh-/.test(line)));
  await disconnect.click();
  await settings.getByText('已断开', { exact: true }).waitFor();
  assert.equal(await exists(path.join(state, 'master-private')), false);
  assert.equal(await exists(path.join(state, 'master-user')), true);
  mark = (await sshCalls()).length;
  assert.deepEqual(await check(), { ok: false, message: 'SSH 已断开。', disconnected: true });
  await new Promise(resolve => setTimeout(resolve, 2300));
  assert.deepEqual(await commandsSince(mark), [], 'background discovery stays off after disconnect');
  await settings.getByRole('button', { name: '连接 实验集群', exact: true }).click();
  await login.getByText("dev@lab's password:", { exact: true }).waitFor();
  await field.fill(password); await field.press('Enter');
  await login.getByText('Verification code:', { exact: true }).waitFor();
  await field.fill(code); await field.press('Enter');
  await login.waitFor({ state: 'detached' });
  assert.deepEqual(await check(), { ok: true });
  await disconnect.and(settings.locator('button:enabled')).waitFor();
  // The choice is kept: reopening the settings shows it.
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.getByRole('button', { name: '界面与连接设置', exact: true }).click();
  await settings.getByRole('button', { name: 'SSH 连接', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.pref-ssh-connection input')?.disabled);
  assert.equal(await reuse.isChecked(), false);
  assert.equal(await keep.inputValue(), '900');
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();

  // Replies stay out of the diagnostics and the profile.
  async function files(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat();
  }
  // Marking an incident flushes the diagnostic log to disk first.
  await page.evaluate(() => window.desktop.markDiagnosticIncident('ssh login e2e'));
  const logged = await files(profile);
  assert.ok(logged.some(file => /diagnostic/i.test(file)), 'diagnostics were written and scanned');
  for (const file of logged) {
    // Electron replaces some profile files atomically: one may vanish while scanning.
    const info = await lstat(file).catch(() => undefined);
    if (!info?.isFile() || info.size > 64 * 1024 * 1024) continue;
    const text = await readFile(file, 'latin1').catch(() => '');
    assert.ok(!text.includes(password) && !text.includes(code), `a login reply was written to ${file}`);
  }
  assert.deepEqual(errors, []);
  console.log('PASS: in-app SSH login with password, one-time code and new host key through the askpass relay; existing master reuse; wrong code retry; cancel; login from a connection error; reusing the user\'s master or only Lectern\'s own (setting, login, persistence); replies kept out of diagnostics.');
} catch (error) {
  console.error(error);
  console.error('ssh calls:\n' + await readFile(path.join(state, 'calls'), 'utf8').catch(() => '(none)'));
  process.exitCode = 1;
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
  await rm(controlRoot, { recursive: true, force: true });
}
