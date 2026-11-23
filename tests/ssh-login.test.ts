import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transport } from '../src/backend/transport';
import { askpassNeedsDisplay, askpassNode, classifyPrompt, runInteractiveLogin, type SshPrompt } from '../src/backend/ssh-login';
import type { Workspace } from '../src/shared/types';

const posix = { skip: process.platform === 'win32' ? 'POSIX ssh multiplexing only' : false };

// A stand-in for OpenSSH: `-G` prints config, `-O check` reports the master,
// `-f -N` authenticates through $SSH_ASKPASS, anything else runs the script locally.
const fakeSsh = `#!/bin/sh
state="$FAKE_SSH_STATE"
printf '%s\\n' "$*" >> "$state/calls"
# Like OpenSSH: a master is found only at the socket path in effect.
case " $* " in *" -o ControlPath="*) socket=private;; *) socket=\${FAKE_CONTROL_PATH:+user};; esac
case " $* " in
  *" -G "*) printf 'hostname example\\ncontrolpath %s\\ncontrolmaster %s\\ncontrolpersist %s\\n' "\${FAKE_CONTROL_PATH:-none}" "\${FAKE_CONTROL_PATH:+auto}" "\${FAKE_CONTROL_PERSIST:-no}"; exit 0;;
  *" -O check "*) [ -n "$socket" ] && [ -f "$state/master-$socket" ] && exit 0; exit 255;;
  *" BatchMode=no "*)
    printf 'Welcome to the lab cluster\\n' >&2
    if [ -n "$FAKE_HOSTKEY" ]; then
      reply=$("$SSH_ASKPASS" "The authenticity of host 'lab (192.0.2.2)' can't be established.
ED25519 key fingerprint is SHA256:abc.
Are you sure you want to continue connecting (yes/no/[fingerprint])? ") || exit 255
      [ "$reply" = yes ] || { printf 'Host key verification failed.\\n' >&2; exit 255; }
    fi
    password=$("$SSH_ASKPASS" "dev@lab's password: ") || { printf 'Permission denied (keyboard-interactive).\\n' >&2; exit 255; }
    printf 'Duo two-factor login required\\n' >&2
    code=$("$SSH_ASKPASS" "Verification code: ") || { printf 'Permission denied (keyboard-interactive).\\n' >&2; exit 255; }
    if [ "$password" = 'pa ss"word' ] && [ "$code" = 123456 ]; then : > "$state/master-$socket"; exit 0; fi
    printf 'Permission denied (keyboard-interactive).\\n' >&2; exit 255;;
  *) exec sh -s;;
esac
`;

// Every fixture starts from, and restores, the environment the file started with.
const originalEnv = { PATH: process.env.PATH, FAKE_SSH_STATE: process.env.FAKE_SSH_STATE, FAKE_CONTROL_PATH: process.env.FAKE_CONTROL_PATH, FAKE_CONTROL_PERSIST: process.env.FAKE_CONTROL_PERSIST, FAKE_HOSTKEY: process.env.FAKE_HOSTKEY };
async function fixture(t: import('node:test').TestContext, env: Record<string, string> = {}) {
  const state = await mkdtemp(join(tmpdir(), 'lectern-login-test-'));
  await writeFile(join(state, 'ssh'), fakeSsh, { mode: 0o700 });
  const previous = originalEnv;
  for (const key of Object.keys(previous)) if (key !== 'PATH') delete process.env[key];
  Object.assign(process.env, { PATH: `${state}:${originalEnv.PATH}`, FAKE_SSH_STATE: state }, env);
  const transport = new Transport();
  t.after(async () => {
    await transport.dispose();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(state, { recursive: true, force: true });
  });
  const calls = async () => (await readFile(join(state, 'calls'), 'utf8')).trim().split('\n');
  return { transport, state, calls };
}
const target = { host: 'lab' };
const workspace: Workspace = { id: 'lab', name: 'lab', kind: 'ssh', cwd: '/tmp', host: 'lab' };

test('prompts are classified for the dialog', () => {
  assert.equal(classifyPrompt("dev@lab's password: "), 'secret');
  assert.equal(classifyPrompt('Enter passphrase for key "/Users/me/.ssh/id_ed25519": '), 'secret');
  assert.equal(classifyPrompt('Verification code: '), 'text');
  assert.equal(classifyPrompt('Are you sure you want to continue connecting (yes/no/[fingerprint])? '), 'hostkey');
  assert.equal(classifyPrompt('Allow use of key?', 'confirm'), 'confirm');
  assert.equal(classifyPrompt('Confirm user presence for key', 'none'), 'info');
});

test('on macOS askpass runs as Node in the LSUIElement helper next to the executable; elsewhere in the executable itself', () => {
  const only = (...files: string[]) => (file: string) => files.includes(file);
  const app = '/Applications/Lectern.app/Contents/MacOS/Lectern';
  const helper = '/Applications/Lectern.app/Contents/Frameworks/Lectern Helper.app/Contents/MacOS/Lectern Helper';
  // Packaged: electron-builder names the helpers after the executable.
  assert.equal(askpassNode({ platform: 'darwin', execPath: app, helperExecPath: undefined, isExecutable: only(helper) }), helper);
  // Development: node_modules' Electron.app, whatever app.setName says.
  const electron = '/home/dev/lectern/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron';
  const electronHelper = '/home/dev/lectern/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper';
  assert.equal(askpassNode({ platform: 'darwin', execPath: electron, helperExecPath: undefined, isExecutable: only(electronHelper) }), electronHelper);
  // A renamed bundle keeps the executable's name.
  assert.equal(askpassNode({ platform: 'darwin', execPath: '/Applications/Lectern 2.app/Contents/MacOS/Lectern', helperExecPath: undefined,
    isExecutable: only('/Applications/Lectern 2.app/Contents/Frameworks/Lectern Helper.app/Contents/MacOS/Lectern Helper') }),
  '/Applications/Lectern 2.app/Contents/Frameworks/Lectern Helper.app/Contents/MacOS/Lectern Helper');
  // Not where expected: Electron's own helper path, then the executable.
  const elsewhere = '/opt/Other.app/Contents/MacOS/Other Helper';
  assert.equal(askpassNode({ platform: 'darwin', execPath: app, helperExecPath: elsewhere, isExecutable: only(elsewhere) }), elsewhere);
  assert.equal(askpassNode({ platform: 'darwin', execPath: app, helperExecPath: elsewhere, isExecutable: only(helper, elsewhere) }), helper);
  assert.equal(askpassNode({ platform: 'darwin', execPath: app, helperExecPath: elsewhere, isExecutable: only() }), app);
  assert.equal(askpassNode({ platform: 'darwin', execPath: '/opt/homebrew/bin/node', helperExecPath: undefined, isExecutable: () => true }), '/opt/homebrew/bin/node');
  // Linux and Windows are unchanged: no Dock, and Electron's helper is the executable itself.
  for (const platform of ['linux', 'win32'] as const) {
    assert.equal(askpassNode({ platform, execPath: '/opt/Lectern/lectern', helperExecPath: '/opt/Lectern/other', isExecutable: () => true }), '/opt/Lectern/lectern');
  }
});

test('the helper must be an executable file', posix, async t => {
  const root = await mkdtemp(join(tmpdir(), 'lectern-askpass-node-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, 'Lectern.app/Contents/MacOS/Lectern');
  const helper = join(root, 'Lectern.app/Contents/Frameworks/Lectern Helper.app/Contents/MacOS/Lectern Helper');
  const options = { platform: 'darwin' as const, execPath: app, helperExecPath: undefined };
  assert.equal(askpassNode(options), app, 'no helper');
  await mkdir(helper, { recursive: true });
  assert.equal(askpassNode(options), app, 'a directory');
  await rm(helper, { recursive: true });
  await writeFile(helper, '#!/bin/sh\n', { mode: 0o644 });
  assert.equal(askpassNode(options), app, 'not executable');
  await rm(helper);
  await writeFile(helper, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(askpassNode(options), helper);
});

test('a DISPLAY is made up only for OpenSSH before 8.4', () => {
  assert.equal(askpassNeedsDisplay('OpenSSH_9.8p1, LibreSSL 3.3.6\n'), false);
  assert.equal(askpassNeedsDisplay('OpenSSH_8.6p1, LibreSSL 3.3.6\n'), false);
  assert.equal(askpassNeedsDisplay('OpenSSH_8.4p1 Debian-5+deb11u3, OpenSSL 1.1.1w  11 Sep 2023\n'), false);
  assert.equal(askpassNeedsDisplay('OpenSSH_10.0p2, OpenSSL 3.5.0\n'), false);
  assert.equal(askpassNeedsDisplay('OpenSSH_8.2p1 Ubuntu-4ubuntu0.11, OpenSSL 1.1.1f  31 Mar 2020\n'), true);
  assert.equal(askpassNeedsDisplay('OpenSSH_7.4p1, OpenSSL 1.0.2k-fips  26 Jan 2017\n'), true);
  assert.equal(askpassNeedsDisplay(''), true, 'unknown counts as old');
});

test('ssh gets the askpass wrapper, which runs the macOS helper (a path with spaces) as Node; DISPLAY only where needed', posix, async t => {
  const root = await mkdtemp(join(tmpdir(), 'lectern-askpass-env-'));
  const display = process.env.DISPLAY;
  t.after(async () => {
    if (display === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = display;
    await rm(root, { recursive: true, force: true });
  });
  // The helper stands in for "Lectern Helper": it records how it was started, then is Node.
  const helper = join(root, 'Lectern.app/Contents/Frameworks/Lectern Helper.app/Contents/MacOS/Lectern Helper');
  await mkdir(join(helper, '..'), { recursive: true });
  await writeFile(helper, `#!/bin/sh
printf '%s %s\\n' "$ELECTRON_RUN_AS_NODE" "$(basename "$1")" >> ${JSON.stringify(join(root, 'helper-runs'))}
exec ${JSON.stringify(process.execPath)} "$@"
`, { mode: 0o755 });
  const node = askpassNode({ platform: 'darwin', execPath: join(root, 'Lectern.app/Contents/MacOS/Lectern'), helperExecPath: undefined });
  assert.equal(node, helper);
  const ssh = join(root, 'ssh');
  await writeFile(ssh, `#!/bin/sh
state=${JSON.stringify(root)}
case " $* " in (*" -V "*) cat "$state/version" >&2; exit 0;; esac
{ printf 'DISPLAY=%s\\n' "\${DISPLAY-unset}"; printf 'SSH_ASKPASS_REQUIRE=%s\\n' "$SSH_ASKPASS_REQUIRE"; printf 'LECTERN_ASKPASS_NODE=%s\\n' "$LECTERN_ASKPASS_NODE"
  printf 'SSH_ASKPASS=%s\\n' "$SSH_ASKPASS"; cat "$SSH_ASKPASS"; } > "$state/env"
reply=$("$SSH_ASKPASS" "dev@lab's password: ") || exit 255
[ "$reply" = 'pa ss"word' ] || exit 255
`, { mode: 0o700 });
  const login = async (version: string, userDisplay?: string) => {
    await writeFile(join(root, 'version'), version);
    if (userDisplay === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = userDisplay;
    const prompts: string[] = [];
    await runInteractiveLogin({ command: { file: ssh, args: ['-f', '-N', 'lab'] }, node, answer: async prompt => { prompts.push(prompt.text); return 'pa ss"word'; } });
    assert.deepEqual(prompts, ["dev@lab's password: "]);
    const env = await readFile(join(root, 'env'), 'utf8');
    return { env, value: (key: string) => env.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1] };
  };
  const modern = await login('OpenSSH_9.8p1, LibreSSL 3.3.6\n');
  assert.equal(modern.value('SSH_ASKPASS_REQUIRE'), 'force');
  assert.equal(modern.value('LECTERN_ASKPASS_NODE'), helper);
  assert.match(modern.value('SSH_ASKPASS') ?? '', /^\/tmp\/lectern-login-[^/]+\/askpass$/);
  assert.match(modern.env, /ELECTRON_RUN_AS_NODE=1 exec "\$LECTERN_ASKPASS_NODE" "\$LECTERN_ASKPASS_HELPER" "\$@"/);
  assert.equal(modern.value('DISPLAY'), 'unset', 'the backgrounded master would keep a made-up DISPLAY');
  assert.equal((await readFile(join(root, 'helper-runs'), 'utf8')).trim(), '1 askpass.cjs', 'the helper ran the relay as Node');
  const { access } = await import('node:fs/promises');
  await assert.rejects(access(join(modern.value('SSH_ASKPASS')!, '..')), 'the wrapper and socket are gone after the login');
  assert.equal((await login('OpenSSH_8.2p1 Ubuntu-4ubuntu0.11, OpenSSL 1.1.1f  31 Mar 2020\n')).value('DISPLAY'), ':0');
  assert.equal((await login('')).value('DISPLAY'), ':0', 'an ssh that does not say its version');
  assert.equal((await login('OpenSSH_8.2p1\n', 'workstation:3')).value('DISPLAY'), 'workstation:3', "the user's own DISPLAY is kept");
});

test('password and one-time code reach OpenSSH through askpass; with ControlPersist in ssh_config the user master is used as is', posix, async t => {
  const { transport, calls } = await fixture(t, { FAKE_CONTROL_PATH: '/tmp/ssh-mux-%C', FAKE_CONTROL_PERSIST: '86400' });
  const seen: SshPrompt[] = [];
  const result = await transport.login(target, async prompt => {
    seen.push(prompt);
    return prompt.kind === 'secret' ? 'pa ss"word' : '123456';
  });
  assert.equal(result, 'connected');
  assert.deepEqual(seen.map(p => [p.kind, p.text]), [['secret', "dev@lab's password: "], ['text', 'Verification code: ']]);
  assert.match(seen[1].context ?? '', /Duo two-factor login required/, 'server messages are shown with the next prompt');
  const login = (await calls()).find(line => line.includes('BatchMode=no'))!;
  assert.match(login, /StrictHostKeyChecking=ask/);
  assert.match(login, / lab true$/, 'a plain command; the user\'s ControlMaster and ControlPersist do the rest');
  assert.doesNotMatch(login, /ControlPath=|ControlMaster=|ControlPersist=| -N /, 'nothing overrides the local persistence');
  assert.equal((await transport.run(workspace, 'printf ok')).stdout.toString(), 'ok');
  const command = (await calls()).at(-1)!;
  assert.match(command, /BatchMode=yes/);
  assert.match(command, /ControlMaster=no/, 'normal commands stay non-interactive and reuse the master');
  assert.equal(await transport.login(target, async () => { throw new Error('must not prompt'); }), 'existing');
});

test('without ControlPersist in ssh_config Lectern keeps its own master until it quits, and its commands reuse it', posix, async t => {
  for (const env of [{}, { FAKE_CONTROL_PATH: '/tmp/ssh-mux-%C' }] as Record<string, string>[]) {
  const { transport, calls } = await fixture(t, env);
  assert.equal(await transport.login(target, async prompt => prompt.kind === 'secret' ? 'pa ss"word' : '123456'), 'connected');
  const login = (await calls()).find(line => line.includes('BatchMode=no'))!;
  assert.match(login, /^-f -N .*ControlMaster=yes/, 'a background master with no idle timeout');
  const path = login.match(/ControlPath=(\S+)/)?.[1];
  assert.ok(path?.startsWith('/tmp/lectern-ssh-') && path.endsWith('/%C'), login);
  await transport.run(workspace, 'printf ok');
  assert.match((await calls()).at(-1)!, new RegExp(`ControlMaster=auto -o ControlPersist=yes -o ControlPath=${path!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  await transport.dispose();
  assert.match((await calls()).at(-1)!, /-O exit/, 'quitting closes the private master');
  }
});

test('a new host key needs an explicit yes; cancelling or a wrong code fails without a master', posix, async t => {
  const { transport, state } = await fixture(t, { FAKE_HOSTKEY: '1' });
  const kinds: string[] = [];
  await assert.rejects(transport.login(target, async prompt => { kinds.push(prompt.kind); return null; }), /已取消/);
  assert.deepEqual(kinds, ['hostkey']);
  await assert.rejects(transport.login(target, async prompt => prompt.kind === 'hostkey' ? 'yes' : prompt.kind === 'secret' ? 'pa ss"word' : '000000'), /Permission denied/);
  // A reply that would end the askpass line early is refused, never passed on.
  await assert.rejects(transport.login(target, async prompt => prompt.kind === 'hostkey' ? 'yes' : 'pa ss"word\n123456'), /已取消/);
  await assert.rejects(readFile(join(state, 'master-private')));
  assert.equal(await transport.login(target, async prompt => prompt.kind === 'hostkey' ? 'yes' : prompt.kind === 'secret' ? 'pa ss"word' : '123456'), 'connected');
});

test('an aborted login stops OpenSSH and answers no further prompts', posix, async t => {
  const { transport, state } = await fixture(t);
  const abort = new AbortController();
  const login = transport.login(target, () => { abort.abort(); return new Promise(() => {}); }, abort.signal);
  await assert.rejects(login, /已取消/);
  await assert.rejects(readFile(join(state, 'master-private')));
});

test('real OpenSSH: new host key and key passphrase are asked through the relay, then commands reuse the master', { timeout: 30_000, ...posix }, async t => {
  const { execFile, spawn } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { createServer } = await import('node:net');
  const { access, realpath } = await import('node:fs/promises');
  const { userInfo } = await import('node:os');
  const exec = promisify(execFile);
  try { await access('/usr/sbin/sshd'); } catch { t.skip('sshd is unavailable'); return; }
  const directory = await realpath(await mkdtemp(join('/tmp', 'lectern-login-real-')));
  let daemon: ReturnType<typeof spawn> | undefined, transport: Transport | undefined, log = '';
  t.after(async () => { await transport?.dispose(); daemon?.kill(); await rm(directory, { recursive: true, force: true }); });
  await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(directory, 'host-key')]);
  await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'open sesame', '-f', join(directory, 'client-key')]);
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer(); probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => { const address = probe.address(); probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0)); });
  });
  await writeFile(join(directory, 'authorized_keys'), await readFile(join(directory, 'client-key.pub')), { mode: 0o600 });
  await writeFile(join(directory, 'known_hosts'), '', { mode: 0o600 });
  await writeFile(join(directory, 'sshd_config'), [
    `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${join(directory, 'host-key')}`, `PidFile ${join(directory, 'sshd.pid')}`,
    `AuthorizedKeysFile ${join(directory, 'authorized_keys')}`, 'StrictModes no', 'UsePAM no', 'PasswordAuthentication no',
    'KbdInteractiveAuthentication no', 'PubkeyAuthentication yes', `AllowUsers ${userInfo().username}`, 'LogLevel ERROR',
  ].join('\n') + '\n', { mode: 0o600 });
  const config = join(directory, 'ssh_config');
  await writeFile(config, [
    'Host lectern-login', '  HostName 127.0.0.1', `  Port ${port}`, `  User ${userInfo().username}`, '  HostKeyAlias lectern-login',
    `  IdentityFile ${join(directory, 'client-key')}`, `  UserKnownHostsFile ${join(directory, 'known_hosts')}`, '  IdentitiesOnly yes',
    '  ControlPath none', '  ControlMaster no',
  ].join('\n') + '\n', { mode: 0o600 });
  daemon = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(directory, 'sshd_config')], { stdio: ['ignore', 'pipe', 'pipe'] });
  daemon.stderr?.on('data', b => { log += b.toString(); });
  await new Promise(resolve => setTimeout(resolve, 250));
  if (daemon.exitCode !== null) { t.skip(`Unprivileged sshd unavailable: ${log.trim()}`); return; }
  transport = new Transport(config);
  const remote: Workspace = { id: 'real', name: 'real', kind: 'ssh', cwd: directory, host: 'lectern-login' };
  await assert.rejects(transport.run(remote, 'printf no', { timeoutMs: 5000 }), 'BatchMode alone cannot get past the unknown host');
  const kinds: string[] = [];
  let result: string;
  try {
    result = await transport.login({ host: 'lectern-login' }, async prompt => {
      kinds.push(prompt.kind);
      if (prompt.kind === 'hostkey') { assert.match(prompt.text, /SHA256:/); return 'yes'; }
      if (prompt.kind === 'secret') { assert.match(prompt.text, /passphrase/i); return 'open sesame'; }
      return null;
    });
  } catch (error) {
    if (kinds.join() === 'hostkey,secret' && /Permission denied|Connection closed/.test(String(error))) { t.skip(`Host disallows isolated sshd authentication: ${log.trim()}`); return; }
    throw error;
  }
  assert.equal(result, 'connected');
  assert.deepEqual(kinds, ['hostkey', 'secret']);
  assert.match(await readFile(join(directory, 'known_hosts'), 'utf8'), /lectern-login/, 'OpenSSH recorded the accepted key itself');
  assert.equal((await transport.run(remote, 'printf reused', { timeoutMs: 5000 })).stdout.toString(), 'reused');
});

test('masters left by a crashed app are closed at the next start; a running owner keeps its own', posix, async t => {
  const { closeStaleMasters } = await import('../src/backend/transport');
  const { state, calls } = await fixture(t);
  const root = await mkdtemp(join(tmpdir(), 'lectern-stale-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { mkdir } = await import('node:fs/promises');
  for (const [name, owner] of [['lectern-ssh-dead', '2147483646'], ['lectern-ssh-live', String(process.pid)], ['other-dir', '2147483646']] as const) {
    await mkdir(join(root, name));
    await writeFile(join(root, name, 'owner.pid'), owner);
    await writeFile(join(root, name, 'abc123'), '');
  }
  await closeStaleMasters(root);
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual((await readdir(root)).sort(), ['lectern-ssh-live', 'other-dir']);
  assert.match((await calls()).join('\n'), new RegExp(`ControlPath=${join(root, 'lectern-ssh-dead', 'abc123').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} -O exit`));
  void state;
});
