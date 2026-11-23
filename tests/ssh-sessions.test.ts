import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transport, type TransportOptions } from '../src/backend/transport';
import type { Workspace } from '../src/shared/types';

// Session places per SSH host, with a stand-in for OpenSSH that runs every session
// with the local shell. `-O check` finds the user's master when `master-user` exists
// (the user's ControlPath, no -o ControlPath) and Lectern's when `master-private`
// does. Each session is counted from its start until this client exits, which is
// what sshd's MaxSessions counts too: `counts` gets the number open at each start.
// `stubborn` makes the next session ignore its input; `linger` keeps a client a
// moment after its remote shell has ended.
const fakeSsh = `#!/bin/sh
state="$FAKE_SSH_STATE"
printf '%s\\n' "$*" >> "$state/calls"
case " $* " in *" -o ControlPath="*) socket=private;; *) socket=user;; esac
case " $* " in
  *" -O check "*) [ -f "$state/master-$socket" ] && exit 0; exit 255;;
  *" -O "*) printf '%s %s\\n' "$socket" "$*" >> "$state/control"; exit 0;;
esac
mkdir -p "$state/live"; : > "$state/live/$$"
ls "$state/live" | wc -l >> "$state/counts"
if [ -f "$state/stubborn" ]; then rm -f "$state/stubborn" "$state/live/$$"; exec sleep 30; fi
# Like sshd, start the session's shell as the leader of its own process group.
perl -e 'setpgrp(0, 0); exec @ARGV or exit 127' sh -s
code=$?
[ -f "$state/linger" ] && sleep "$(cat "$state/linger")"
rm -f "$state/live/$$"
exit $code
`;
const posix = { skip: process.platform === 'win32' ? 'POSIX ssh multiplexing only' : false };
const target: Workspace = { id: 'gpu', name: 'gpu', kind: 'ssh', cwd: '/tmp', host: 'gpu-box' };
const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const originalEnv = { PATH: process.env.PATH, FAKE_SSH_STATE: process.env.FAKE_SSH_STATE };

async function fixture(t: import('node:test').TestContext, options: TransportOptions = {}, userMaster = true) {
  const state = await mkdtemp(join(tmpdir(), 'lectern-sessions-'));
  await writeFile(join(state, 'ssh'), fakeSsh, { mode: 0o700 });
  if (userMaster) await writeFile(join(state, 'master-user'), '');
  Object.assign(process.env, { PATH: `${state}:${originalEnv.PATH}`, FAKE_SSH_STATE: state });
  const transport = new Transport(undefined, options);
  // Terminal streams a failed test left open would keep the test process alive.
  const streams: ChildProcess[] = [];
  const stream = async (script: string) => { const child = await transport.stream(target, script); streams.push(child); return child; };
  t.after(async () => {
    for (const child of streams) child.kill('SIGKILL');
    await transport.dispose();
    for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(state, { recursive: true, force: true });
  });
  const lines = async (name: string) => (await readFile(join(state, name), 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const counts = async () => (await lines('counts')).map(Number);
  const sessions = async () => (await lines('counts')).length;
  const host = () => [...(transport as any).hosts.values()][0];
  return { transport, state, lines, counts, sessions, host, stream };
}
/** Until a command runs on a warm channel: its parent is the channel loop, not a one-off wrapper. */
async function warmChannel(transport: Transport, sessions: () => Promise<number>) {
  for (let i = 0; i < 100; i++) {
    transport.warmChannels(target);
    const before = await sessions();
    await transport.run(target, 'true');
    if (await sessions() === before) return;
    await settle(30);
  }
  throw new Error('no channel became ready');
}
const live = (pid: number) => new Promise<boolean>(resolve => execFile('ps', ['-o', 'stat=', '-p', String(pid)], (_error, stdout) => {
  const state = String(stdout).trim();
  resolve(!!state && !state.startsWith('Z'));
}));

test('one-off sessions: at most 4 at once over the user\'s shared master, 8 over Lectern\'s own connection', { timeout: 30_000, ...posix }, async t => {
  for (const [reuseUserMasters, limit] of [[true, 4], [false, 8]] as const) {
    const { transport, counts, lines } = await fixture(t, { channelKinds: [], reuseUserMasters });
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => transport.run(target, `sleep 0.2; printf ${i}`)));
    assert.deepEqual(results.map(r => r.stdout.toString()), Array.from({ length: 12 }, (_, i) => String(i)));
    assert.equal(Math.max(...await counts()), limit, `${reuseUserMasters ? 'shared' : 'exclusive'}: ${await counts()}`);
    const commands = (await lines('calls')).filter(line => line.endsWith('exec sh -s'));
    if (reuseUserMasters) assert.ok(commands.every(line => line.includes('ControlMaster=no') && !line.includes('ControlPath=')), 'the user\'s master, at its own path');
    else assert.ok(commands.every(line => /ControlMaster=auto -o ControlPersist=yes -o ControlPath=\/tmp\/lectern-ssh-[^/]+\/%C/.test(line)), 'Lectern\'s private master');
    if (!reuseUserMasters) assert.ok(!(await lines('calls')).some(line => line.includes('-O check')), 'the user\'s master is not even looked for');
    await transport.dispose();
  }
});

test('command channels per host: at most 2 when shared and 3 when exclusive, always within the session limit', { timeout: 30_000, ...posix }, async t => {
  for (const [reuseUserMasters, channels, limit] of [[true, 2, 4], [false, 3, 8]] as const) {
    const { transport, counts, sessions, host } = await fixture(t, { channelKinds: ['ssh'], reuseUserMasters });
    await warmChannel(transport, sessions);
    let most = 0;
    for (let round = 0; round < 6; round++) {
      await Promise.all(Array.from({ length: 10 }, (_, i) => transport.run(target, `sleep 0.05; printf ${i}`)));
      most = Math.max(most, host().channels.size);
    }
    assert.equal(most, channels, `${reuseUserMasters ? 'shared' : 'exclusive'} channels`);
    assert.ok(Math.max(...await counts()) <= limit, `sessions: ${await counts()}`);
    await transport.dispose();
  }
});

test('a queued command runs on the first channel that becomes idle instead of waiting for a place', { timeout: 30_000, ...posix }, async t => {
  const { transport, counts, sessions, host, stream } = await fixture(t, { limits: { shared: { sessions: 3, channels: 1 }, exclusive: { sessions: 3, channels: 1 } } });
  await warmChannel(transport, sessions);
  const terminals = [await stream('cat >/dev/null'), await stream('cat >/dev/null')];
  assert.equal(host().sessions.used, 3);
  await settle(200); // the terminals' sessions are counted once their clients have started
  const before = await sessions(), started = Date.now();
  const first = transport.run(target, 'sleep 0.4; printf first');
  await settle(50);
  const second = transport.run(target, 'printf second');
  await settle(50);
  assert.equal(host().sessions.queued, 1, 'the channel is busy and every place is taken');
  assert.deepEqual([(await first).stdout.toString(), (await second).stdout.toString()], ['first', 'second']);
  assert.ok(Date.now() - started < 2000);
  assert.equal(await sessions(), before, 'no new session: the waiting command took the channel');
  assert.ok(Math.max(...await counts()) <= 3);
  for (const terminal of terminals) terminal.stdin!.end();
});

test('when every place is taken, an idle channel is closed for a terminal takeover or a cancellable scan', { timeout: 30_000, ...posix }, async t => {
  const { transport, counts, sessions, host, stream } = await fixture(t, { limits: { shared: { sessions: 2, channels: 1 }, exclusive: { sessions: 2, channels: 1 } } });
  await warmChannel(transport, sessions);
  const first = await stream('cat >/dev/null');
  assert.equal(host().channels.size, 1);
  const second = await Promise.race([stream('cat >/dev/null'), settle(3000).then(() => undefined)]);
  assert.ok(second, 'the waiting takeover got the channel\'s place');
  assert.equal(host().channels.size, 0);
  assert.ok(Math.max(...await counts()) <= 2, `sessions: ${await counts()}`);
  second.stdin!.end(); first.stdin!.end();
  for (let i = 0; i < 100 && host().sessions.used; i++) await settle(20);
  // A scan cannot run on a channel either: a reopened channel yields to it too.
  await warmChannel(transport, sessions);
  const third = await stream('cat >/dev/null');
  assert.deepEqual([host().channels.size, host().sessions.used], [1, 2]);
  const scan = await transport.run(target, 'printf scanned', { signal: new AbortController().signal });
  assert.equal(scan.stdout.toString(), 'scanned');
  assert.equal(host().channels.size, 0);
  assert.ok(Math.max(...await counts()) <= 2, `sessions: ${await counts()}`);
  third.stdin!.end();
});

test('a cancelled command ends on the target and keeps its place until its client has exited', { timeout: 30_000, ...posix }, async t => {
  const { transport, state, counts, host } = await fixture(t, { channelKinds: [], limits: { shared: { sessions: 1, channels: 0 }, exclusive: { sessions: 1, channels: 0 } } });
  await transport.run(target, 'true');
  // The client stays a moment after its remote command has ended, as one over a slow link would.
  await writeFile(join(state, 'linger'), '0.5');
  const pidFile = join(state, 'remote.pid');
  const started = Date.now();
  await assert.rejects(transport.run(target, `sh -c 'echo $$ > "${pidFile}"; exec sleep 29'`, { timeoutMs: 300 }), /timed out/);
  const rejected = Date.now();
  assert.ok(rejected - started < 1500, 'the caller is not kept waiting');
  assert.equal(host().sessions.used, 1, 'the session still counts');
  const next = await transport.run(target, 'printf next');
  assert.equal(next.stdout.toString(), 'next');
  assert.ok(Date.now() - rejected >= 450, `the next session waited for the client: ${Date.now() - rejected} ms`);
  assert.equal(await live(Number(await readFile(pidFile, 'utf8'))), false, 'the remote command was ended');
  // Cancelling a scan works the same way.
  await rm(pidFile);
  const abort = new AbortController(), scan = transport.run(target, `sh -c 'echo $$ > "${pidFile}"; exec sleep 28'`, { signal: abort.signal });
  for (let i = 0; i < 100 && !(await readFile(pidFile, 'utf8').catch(() => '')).trim().length; i++) await settle(20);
  await settle(100);
  abort.abort();
  await assert.rejects(scan);
  assert.equal(host().sessions.used, 1);
  assert.equal((await transport.run(target, 'printf after')).stdout.toString(), 'after');
  assert.equal(await live(Number(await readFile(pidFile, 'utf8'))), false);
  assert.deepEqual([...new Set(await counts())], [1], 'never two sessions at once');
});

test('a client that does not end when hung up is killed, and its place is held a while longer', { timeout: 30_000, ...posix }, async t => {
  const { transport, state, counts, host } = await fixture(t, { channelKinds: [], hangUpGraceMs: 200, unconfirmedHoldMs: 700,
    limits: { shared: { sessions: 1, channels: 0 }, exclusive: { sessions: 1, channels: 0 } } });
  await transport.run(target, 'true');
  await writeFile(join(state, 'stubborn'), '');
  await assert.rejects(transport.run(target, 'printf never', { timeoutMs: 100 }), /timed out/);
  const rejected = Date.now();
  assert.equal((await transport.run(target, 'printf later')).stdout.toString(), 'later');
  const waited = Date.now() - rejected;
  assert.ok(waited >= 850, `grace (200 ms) and hold (700 ms) passed first: ${waited} ms`);
  assert.equal(host().sessions.used, 0);
  void counts;
});

test('switching off reuse moves new connections to Lectern\'s own master; a busy channel finishes first; switching back stops that master', { timeout: 30_000, ...posix }, async t => {
  const { transport, lines, sessions, host, stream } = await fixture(t);
  await warmChannel(transport, sessions);
  const terminal = await stream('while IFS= read -r line; do printf "echo %s\\n" "$line"; done');
  let echoed = '';
  terminal.stdout!.on('data', (chunk: Buffer) => { echoed += chunk.toString(); });
  await settle(200); // a channel still opening over the shared master has started
  const busy = transport.run(target, 'sleep 0.3; printf finished');
  await settle(50);
  await transport.setReuseUserMasters(false);
  const callsBefore = (await lines('calls')).length;
  assert.equal((await busy).stdout.toString(), 'finished', 'the command already on a channel completes there');
  await settle(50);
  assert.equal(host().channels.size, 0, 'channels over the old route are closed');
  assert.equal((await transport.run(target, 'printf private')).stdout.toString(), 'private');
  await warmChannel(transport, sessions);
  const after = (await lines('calls')).slice(callsBefore).filter(line => line.endsWith('exec sh -s'));
  assert.ok(after.length >= 2 && after.every(line => /ControlPath=\/tmp\/lectern-ssh-/.test(line)), after.join('\n'));
  // The takeover made before the switch keeps working over its connection.
  terminal.stdin!.write('still here\n');
  for (let i = 0; i < 50 && !echoed.includes('echo still here'); i++) await settle(20);
  assert.match(echoed, /echo still here/);
  // Back to sharing: the user's master is used again and Lectern's own stops taking sessions.
  await transport.setReuseUserMasters(true);
  const control = await lines('control');
  assert.ok(control.some(line => /^private .*ControlPath=\/tmp\/lectern-ssh-.* -O stop gpu-box$/.test(line)), control.join('\n'));
  assert.ok(!control.some(line => line.startsWith('user ')), 'the user\'s master is never sent a control command');
  const mark = (await lines('calls')).length;
  await transport.run(target, 'true');
  assert.ok((await lines('calls')).slice(mark).filter(line => line.endsWith('exec sh -s')).every(line => line.includes('ControlMaster=no') && !line.includes('ControlPath=')));
  terminal.stdin!.end();
});

test('without a user master, switching back keeps Lectern\'s own master for the machine', { timeout: 30_000, ...posix }, async t => {
  const { transport, lines } = await fixture(t, { channelKinds: [], reuseUserMasters: false }, false);
  await transport.run(target, 'true');
  await transport.setReuseUserMasters(true);
  assert.deepEqual(await lines('control'), [], 'nothing to stop: reuse would still use it');
  await transport.run(target, 'true');
  assert.match((await lines('calls')).at(-1)!, /ControlPath=\/tmp\/lectern-ssh-/);
});

/**
 * sshd's own processes by `ps` args: the listener and each connection's monitor, login and user processes. OpenSSH before 9.8
 * titles them `sshd: user@notty`, `sshd: user [priv]`; 9.8+ runs them as `sshd-session` and `sshd-auth`
 * (`sshd-session: user@notty`); where a title is not set, ps shows the path they were started with
 * (`/usr/libexec/sshd-session -D -f … -R`), or `(sshd-session)` when it cannot read the arguments.
 */
const sshdProcess = /^\(?(?:\S*\/)?sshd(?:-session|-auth)?(?:[:\s)]|$)/;
/**
 * Connections to a test sshd and the sessions open on them, from `ps -A -o pid=,ppid=,args=` rows. Within the listener's
 * process tree, a session is a process of the user's (the shell or command sshd started for it) whose parent is one of sshd's
 * own; that parent is its connection. Titles differ by version and platform (see `sshdProcess`), so only the tree is relied on.
 * The listener and the `[priv]` monitors only have sshd children; a connection with no session open is not counted.
 */
function countServerSessions(rows: string, listener: number): { connections: number; sessions: number } {
  const processes = rows.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean).map(m => ({ pid: Number(m![1]), ppid: Number(m![2]), args: m![3] }));
  const ours = new Set([listener]);
  for (let grew = true; grew;) { grew = false; for (const p of processes) if (!ours.has(p.pid) && ours.has(p.ppid)) { ours.add(p.pid); grew = true; } }
  const daemon = new Set(processes.filter(p => ours.has(p.pid) && sshdProcess.test(p.args)).map(p => p.pid));
  const sessions = processes.filter(p => ours.has(p.pid) && !daemon.has(p.pid) && daemon.has(p.ppid));
  return { connections: new Set(sessions.map(p => p.ppid)).size, sessions: sessions.length };
}
async function serverSessions(listener: number): Promise<{ connections: number; sessions: number }> {
  const rows = await new Promise<string>(resolve => execFile('ps', ['-A', '-o', 'pid=,ppid=,args='], { maxBuffer: 16 * 1024 * 1024 }, (_error, stdout) => resolve(String(stdout))));
  return countServerSessions(rows, listener);
}

test('sessions on a test sshd are counted whether sshd titles its processes `sshd:`, `sshd-session:` or not at all', () => {
  const ps = (...rows: [number, number, string][]) => rows.map(([pid, ppid, args]) => `${String(pid).padStart(6)} ${String(ppid).padStart(6)} ${args}`).join('\n') + '\n';
  const config = '-D -e -f /tmp/lectern-sessions-real-x/sshd_config';
  // OpenSSH before 9.8 (Linux): root has no separate user process; another user has a monitor and a user process.
  assert.deepEqual(countServerSessions(ps(
    [1, 0, '/sbin/init'], [100, 1, `sshd: /usr/sbin/sshd ${config} [listener] 0 of 10-100 startups`],
    [110, 100, 'sshd: root@notty'], [111, 110, 'bash -c cat >/dev/null'], [112, 110, 'sh -s'], [113, 112, 'sleep 0.3'],
    [114, 110, 'sshd: root@notty'], // forked for a session, not yet its shell
    [120, 100, 'sshd: dev [priv]'], [121, 120, 'sshd: dev@notty'], [122, 121, 'cat'],
    [130, 100, 'sshd: dev [priv]'], [131, 130, 'sshd: dev [net]'], // still logging in
    [900, 1, 'sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups'], [901, 900, 'sshd: dev [priv]'], [902, 901, 'sshd: dev@pts/0'], [903, 902, '-bash'],
  ), 100), { connections: 2, sessions: 3 });
  // OpenSSH 9.8+ (Linux, 10.2p1 on the CI runner): sshd-session and sshd-auth.
  assert.deepEqual(countServerSessions(ps(
    [1, 0, '/sbin/init'], [100, 1, `sshd: /usr/sbin/sshd ${config} [listener] 0 of 10-100 startups`],
    [110, 100, 'sshd-session: runner [priv]'], [111, 110, 'sshd-session: runner@notty'],
    [112, 111, 'bash -c cat >/dev/null'], [113, 111, 'bash -c cat >/dev/null'], [114, 111, 'sh -s'], [115, 114, 'sleep 0.3'], [116, 111, 'sleep 29.123'],
    [117, 111, 'sshd-session: runner@notty'],
    [120, 100, 'sshd-session: runner [priv]'], [121, 120, 'sshd-auth: runner [net]'],
    [900, 1, 'sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups'], [901, 900, 'sshd-session: dev [priv]'], [902, 901, 'sshd-session: dev@pts/0'], [903, 902, '-bash'],
  ), 100), { connections: 1, sessions: 4 });
  // Titles not set: the paths sshd started them with, or only the name in parentheses.
  assert.deepEqual(countServerSessions(ps(
    [1, 0, '/sbin/launchd'], [100, 60, `/usr/sbin/sshd ${config}`],
    [110, 100, `/usr/libexec/sshd-session ${config} -R`], [111, 110, `/usr/libexec/sshd-session ${config} -R`],
    [112, 111, 'zsh -c cat >/dev/null'], [113, 111, 'cat'], [114, 111, 'sh -s'], [115, 114, 'sleep 0.3'],
    [120, 100, '(sshd-session)'], [121, 120, '(sshd-session)'], [122, 121, 'sh -c sleep 29.123'], // a second connection
    [130, 100, `/usr/libexec/sshd-session ${config} -R`], [131, 130, '/usr/libexec/sshd-auth -R'],
    [200, 1, '/usr/sbin/sshd -i'], [201, 200, '/usr/libexec/sshd-session -i -R'], [202, 201, '/usr/libexec/sshd-session -i -R'], [203, 202, '-zsh'],
  ), 100), { connections: 2, sessions: 4 });
  assert.deepEqual(countServerSessions('', 100), { connections: 0, sessions: 0 });
});

test('real OpenSSH with MaxSessions 8: Lectern stays within it alone, and within 4 beside the user\'s own sessions; timed-out commands end on the server', { timeout: 90_000, ...posix }, async t => {
  const { spawn, execFile: exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { createServer } = await import('node:net');
  const { access, appendFile, realpath } = await import('node:fs/promises');
  const { userInfo } = await import('node:os');
  const run = promisify(exec);
  try { await access('/usr/sbin/sshd'); } catch { t.skip('sshd is unavailable'); return; }
  const directory = await realpath(await mkdtemp(join('/tmp', 'lectern-sessions-real-')));
  let daemon: ReturnType<typeof spawn> | undefined, log = '', userMaster = false;
  const transports: Transport[] = [], held: ChildProcess[] = [];
  const config = join(directory, 'ssh_config');
  t.after(async () => {
    for (const child of held) child.kill('SIGKILL');
    for (const transport of transports) await transport.dispose();
    if (userMaster) await run('ssh', ['-F', config, '-O', 'exit', 'lectern-sessions']).catch(() => {});
    daemon?.kill();
    await rm(directory, { recursive: true, force: true });
  });
  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(directory, 'host-key')]);
  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(directory, 'client-key')]);
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer(); probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => { const address = probe.address(); probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0)); });
  });
  await writeFile(join(directory, 'authorized_keys'), await readFile(join(directory, 'client-key.pub')), { mode: 0o600 });
  await writeFile(join(directory, 'known_hosts'), `lectern-sessions ${await readFile(join(directory, 'host-key.pub'), 'utf8')}`, { mode: 0o600 });
  await writeFile(join(directory, 'sshd_config'), [
    `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${join(directory, 'host-key')}`, `PidFile ${join(directory, 'sshd.pid')}`,
    `AuthorizedKeysFile ${join(directory, 'authorized_keys')}`, 'StrictModes no', 'UsePAM no', 'PasswordAuthentication no',
    'KbdInteractiveAuthentication no', 'PubkeyAuthentication yes', `AllowUsers ${userInfo().username}`, 'MaxSessions 8', 'LogLevel ERROR',
  ].join('\n') + '\n', { mode: 0o600 });
  await writeFile(config, [
    'Host lectern-sessions', '  HostName 127.0.0.1', `  Port ${port}`, `  User ${userInfo().username}`, '  HostKeyAlias lectern-sessions',
    `  IdentityFile ${join(directory, 'client-key')}`, `  UserKnownHostsFile ${join(directory, 'known_hosts')}`, '  IdentitiesOnly yes',
    // The user's own multiplexing; Lectern's own connection overrides it when not reusing.
    '  ControlMaster auto', `  ControlPath ${join(directory, 'user-%C')}`, '  ControlPersist 60',
  ].join('\n') + '\n', { mode: 0o600 });
  daemon = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(directory, 'sshd_config')], { stdio: ['ignore', 'pipe', 'pipe'] });
  daemon.stderr?.on('data', b => { log += b.toString(); });
  await settle(250);
  if (daemon.exitCode !== null) { t.skip(`Unprivileged sshd unavailable: ${log.trim()}`); return; }
  const remote: Workspace = { id: 'real', name: 'real', kind: 'ssh', cwd: directory, host: 'lectern-sessions' };
  // Past MaxSessions a mux client does not fail: OpenSSH falls back to a connection of its own
  // ("disabling multiplexing"), which through a relay needs a new login. So both counts matter.
  let most = 0, connections = 0, sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const seen = await serverSessions(daemon!.pid!);
      most = Math.max(most, seen.sessions); connections = Math.max(connections, seen.connections);
      await settle(15);
    }
  })();
  const marker = `29.${process.pid % 1000}`;
  const leftovers = async () => (await run('ps', ['-A', '-o', 'args=']).then(r => r.stdout)).split('\n').filter(line => line.trim() === `sleep ${marker}`).length;
  /** Takeovers, channel commands, scans and commands that time out, all at once. */
  const burst = async (transport: Transport) => {
    const terminals = [await transport.stream(remote, 'cat >/dev/null'), await transport.stream(remote, 'cat >/dev/null')];
    held.push(...terminals);
    const outcomes = await Promise.all([
      ...Array.from({ length: 12 }, (_, i) => transport.run(remote, `sleep 0.3; printf c${i}`)),
      ...Array.from({ length: 6 }, (_, i) => transport.run(remote, `sleep 0.2; printf s${i}`, { signal: new AbortController().signal })),
      ...Array.from({ length: 4 }, () => transport.run(remote, `sleep ${marker}`, { timeoutMs: 500 })),
    ].map(p => p.then(r => r.stdout.toString(), (e: Error) => `error: ${e.message}`)));
    for (const terminal of terminals) terminal.stdin.end();
    return outcomes;
  };
  const expected = [...Array.from({ length: 12 }, (_, i) => `c${i}`), ...Array.from({ length: 6 }, (_, i) => `s${i}`)];
  try {
    // Alone, over Lectern's own connection: up to 8.
    const own = new Transport(config, { reuseUserMasters: false });
    transports.push(own);
    try { await own.run(remote, 'true', { timeoutMs: 5000 }); }
    catch (error) { t.skip(`Host disallows isolated sshd authentication: ${(error as Error).message}; ${log.trim()}`); return; }
    const alone = await burst(own);
    assert.deepEqual(alone.slice(0, 18), expected, alone.join('\n'));
    assert.ok(alone.slice(18).every(outcome => /timed out/.test(outcome)), alone.slice(18).join('\n'));
    for (let i = 0; i < 150 && await leftovers(); i++) await settle(20);
    assert.equal(await leftovers(), 0, 'the timed-out commands were ended on the server');
    assert.ok(most <= 8 && most >= 5, `sessions open at once: ${most}`);
    assert.equal(connections, 1, 'every session went over the one connection');
    await own.dispose();
    // Beside four sessions of the user's own on their master: Lectern keeps to 4, so the 8 suffice.
    await run('ssh', ['-F', config, '-o', 'BatchMode=yes', '-M', '-N', '-f', 'lectern-sessions']);
    userMaster = true;
    for (let i = 0; i < 4; i++) held.push(spawn('ssh', ['-F', config, '-o', 'BatchMode=yes', 'lectern-sessions', 'cat >/dev/null'], { stdio: ['pipe', 'ignore', 'ignore'] }));
    for (let i = 0; i < 100 && (await serverSessions(daemon.pid!)).sessions < 4; i++) await settle(20);
    most = 0; connections = 0;
    const shared = new Transport(config);
    transports.push(shared);
    const beside = await burst(shared);
    assert.deepEqual(beside.slice(0, 18), expected, beside.join('\n'));
    assert.ok(beside.slice(18).every(outcome => /timed out/.test(outcome)), beside.slice(18).join('\n'));
    assert.ok(most <= 8 && most >= 6, `sessions open at once: ${most}`);
    assert.equal(connections, 1, 'Lectern and the user share the user\'s connection');
    for (let i = 0; i < 150 && await leftovers(); i++) await settle(20);
    assert.equal(await leftovers(), 0);
  } finally { sampling = false; await sampler; }
});
