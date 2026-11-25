import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, chown, mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { startLoopback, waitUntil } from '../scripts/fixtures/loopback-ssh.mjs';
import { privateSshDirectory, sshControlSockets } from '../src/backend/ssh-control';
import { Transport } from '../src/backend/transport';
import { SshSettings, validSshConnectionPreferences } from '../src/main/ssh-settings';
import type { Workspace } from '../src/shared/types';

const exec = promisify(execFile);
const posix = { skip: process.platform === 'win32' ? 'OpenSSH multiplexing requires POSIX' : false };

test('an older SSH settings file keeps its reuse preference and defaults to one hour', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lectern-ssh-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'settings.json');
  await writeFile(file, '{"reuseConnections":false}');
  const settings = new SshSettings(file);
  assert.deepEqual(await settings.get(), { reuseConnections: false, keepAliveSeconds: 3600 });
  await settings.set({ reuseConnections: false, keepAliveSeconds: 0 });
  assert.deepEqual(await new SshSettings(file).get(), { reuseConnections: false, keepAliveSeconds: 0 });
  assert.throws(() => validSshConnectionPreferences({ reuseConnections: false, keepAliveSeconds: 2 }), /duration/);
});

test('persistent control directories are stable, profile-scoped, and checked before use', posix, async t => {
  const root = await mkdtemp(join('/tmp', 'lssh-t-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, 'profile'), other = join(root, 'other-profile');
  const stable = await privateSshDirectory(root, profile);
  assert.equal(stable.persistent, true);
  assert.deepEqual(await privateSshDirectory(root, profile), stable);
  assert.notEqual((await privateSshDirectory(root, other)).path, stable.path);

  await chmod(stable.path, 0o755);
  const checkFallback = async () => {
    const result = await privateSshDirectory(root, profile);
    assert.equal(result.persistent, false);
    assert.notEqual(result.path, stable.path);
  };
  await checkFallback();
  await rm(stable.path, { recursive: true });
  const elsewhere = join(root, 'elsewhere');
  await mkdir(elsewhere, { mode: 0o700 });
  await symlink(elsewhere, stable.path);
  await checkFallback();
  if (process.getuid!() === 0) {
    await rm(stable.path);
    await mkdir(stable.path, { mode: 0o700 });
    await chown(stable.path, 65534, 65534);
    await checkFallback();
  }
});

test('loopback OpenSSH reuses a master across backend shutdown, expires it when idle, and disconnects on quit', { ...posix, timeout: 45_000 }, async t => {
  try { await access('/usr/sbin/sshd'); }
  catch { t.skip('sshd is unavailable'); return; }
  const root = await mkdtemp(join('/tmp', 'lssh-r-'));
  const transports: Transport[] = [], pids = new Set<number>();
  const host = 'lectern-persistence-fixture';
  let server: Awaited<ReturnType<typeof startLoopback>> | undefined;
  const control = (socket: string, operation: string) =>
    exec('ssh', ['-F', '/dev/null', '-S', socket, '-O', operation, host], { timeout: 2000 });
  const masterPid = async (socket: string) => {
    const { stderr } = await control(socket, 'check');
    const pid = Number(stderr.match(/pid=(\d+)/)?.[1]);
    assert.ok(pid > 1, stderr);
    pids.add(pid);
    return pid;
  };
  async function checkGone(pid: number) {
    await waitUntil(async () => {
      const stat = await exec('ps', ['-o', 'stat=', '-p', String(pid)]).then(result => result.stdout.trim(), () => '');
      return !stat || stat.startsWith('Z');
    }, `Active SSH master ${pid} did not exit`, 5000);
  }
  const sockets = async () => (await Promise.all((await readdir(root, { withFileTypes: true })).filter(entry =>
    entry.isDirectory() && /^(lssh-|lectern-ssh-)/.test(entry.name)).map(entry => sshControlSockets(join(root, entry.name))))).flat();
  try {
    server = await startLoopback({ root, alias: host, env: { HOME: root } });
    const version = (await exec('ssh', ['-V'])).stderr.trim();
    t.diagnostic(`Running the loopback lifecycle test with ${version}`);
    const profile = join(root, 'profile');
    const makeTransport = async (keepAliveSeconds: number, userData = profile) => {
      const transport = new Transport(server!.configPath, { controlRoot: root, userData, keepAliveSeconds, reuseUserMasters: false, channelKinds: [] });
      transports.push(transport);
      await transport.initializeSsh();
      return transport;
    };
    const remote: Workspace = { id: 'loopback', name: 'Loopback', kind: 'ssh', cwd: root, host };
    const first = await makeTransport(30);
    assert.equal((await first.run(remote, 'printf first')).stdout.toString(), 'first');
    const [socket] = await sockets();
    assert.ok(socket, 'OpenSSH created a private socket');
    const firstPid = await masterPid(socket);
    await first.dispose();
    assert.equal(await masterPid(socket), firstPid, 'quit leaves the authenticated master alive');
    const key = join(root, 'client');
    await rename(key, key + '.held');
    const other = await makeTransport(0, join(root, 'other-profile'));
    await assert.rejects(other.run(remote, 'true'), /Permission denied/);
    await other.dispose();
    const restarted = await makeTransport(900);
    assert.equal(await restarted.sshMasterState(remote), 'private');
    assert.equal((await restarted.run(remote, 'printf reused')).stdout.toString(), 'reused');
    assert.equal(await masterPid(socket), firstPid, 'restart reuses the master even without an authentication key');
    await restarted.dispose();
    const closing = await makeTransport(0);
    await closing.dispose();
    await checkGone(firstPid);
    await assert.rejects(control(socket, 'check'), 'disconnect on quit closes an adopted master without first routing to it');
    t.diagnostic('The restarted profile reused the same master without its private key, and a different profile could not use it.');

    await rename(key + '.held', key);
    const short = await makeTransport(3);
    assert.equal(await short.login(remote, async () => assert.fail('the fixture uses an unencrypted key')), 'connected');
    const shortPid = await masterPid(socket);
    short.setKeepAliveSeconds(900);
    await short.dispose();
    await checkGone(shortPid);
    await assert.rejects(control(socket, 'check'), 'the in-app login master keeps its original idle timeout');
    t.diagnostic('The interactive login master expired with its original 3-second ControlPersist after the preference changed.');

    const temporary = await makeTransport(0);
    await temporary.run(remote, 'true');
    const [temporarySocket] = await sockets();
    assert.ok(temporarySocket.includes('/lectern-ssh-'));
    const temporaryPid = await masterPid(temporarySocket);
    temporary.setKeepAliveSeconds(900);
    await temporary.dispose();
    await checkGone(temporaryPid);
    t.diagnostic('A master opened with Disconnect on quit also closed when that setting changed before quit.');
  } finally {
    try {
      for (const transport of transports) await transport.dispose();
      for (const socket of await sockets()) {
        await masterPid(socket).catch(() => {});
        await control(socket, 'exit').catch(() => {});
      }
      for (const pid of pids) await checkGone(pid);
    } finally {
      server?.stop();
      await rm(root, { recursive: true, force: true });
    }
  }
});
