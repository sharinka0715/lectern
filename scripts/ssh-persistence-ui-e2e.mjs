// Exercise the production shutdown and startup paths against a disposable loopback sshd.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron } from './fixtures/electron.mjs';
import { startLoopback, waitUntil } from './fixtures/loopback-ssh.mjs';

if (process.platform === 'win32' || !await access('/usr/sbin/sshd').then(() => true, () => false)) {
  console.log('SKIP: OpenSSH multiplexing and a local sshd are required');
  process.exit(0);
}

const root = await mkdtemp('/tmp/ltp-');
const exec = promisify(execFile);
const target = { host: 'lectern-loopback-persistence' };
const client = '/usr/bin/ssh';
const pids = new Set();
const mux = (socket, operation) => exec(client, ['-F', '/dev/null', '-S', socket, '-O', operation, target.host], { timeout: 2000 });
const masterPid = async socket => {
  const pid = Number((await mux(socket, 'check')).stderr.match(/pid=(\d+)/)?.[1]);
  assert.ok(pid > 1);
  pids.add(pid);
  return pid;
};
const sockets = async () => (await Promise.all((await readdir(root)).filter(name => name.startsWith('lssh-')).map(async name => {
  const dir = path.join(root, name);
  return (await readdir(dir, { withFileTypes: true })).filter(entry => entry.isSocket()).map(entry => path.join(dir, entry.name));
}))).flat();
const gone = pid => waitUntil(async () => {
  const stat = await exec('ps', ['-o', 'stat=', '-p', String(pid)]).then(value => value.stdout.trim(), () => '');
  return !stat || stat.startsWith('Z');
}, `SSH master ${pid} is still running`, 5000);
let sshd, app;
try {
  sshd = await startLoopback({ root, alias: target.host, env: { HOME: root }, ssh: client });
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'ssh'), `#!/bin/sh
case "$1" in -F|-V) exec ${client} "$@";; esac
exec ${client} -F ${JSON.stringify(sshd.configPath)} "$@"
`, { mode: 0o700 });
  const env = { ...process.env, LECTERN_USER_DATA: path.join(root, 'profile'), LECTERN_TEST_SSH_CONTROL_ROOT: root,
    PATH: `${bin}:${process.env.PATH}` };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.LECTERN_DEV_URL;
  const launch = async () => {
    app = await _electron.launch({ args: ['.'], env });
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!window.desktop);
    return page;
  };
  const check = page => page.evaluate(target => window.desktop.checkSshConnection(target), target);
  console.log('Opening a private master through the running app');
  const first = await launch();
  assert.equal((await first.evaluate(() => window.desktop.sshConnectionPreferences())).keepAliveSeconds, 3600);
  assert.deepEqual(await check(first), { ok: true });
  const [socket] = await sockets();
  assert.ok(socket, 'the app uses a persistent socket in the disposable control root');
  const pid = await masterPid(socket);
  await app.close(); app = undefined;
  assert.equal(await masterPid(socket), pid, 'closing Electron leaves the master running');

  console.log('Restarting the app with the private key removed');
  await rename(path.join(root, 'client'), path.join(root, 'held-client'));
  const restarted = await launch();
  assert.equal(await restarted.evaluate(target => window.desktop.sshMasterState(target), target), 'private');
  assert.deepEqual(await check(restarted), { ok: true });
  assert.equal(await masterPid(socket), pid, 'the new Electron process reuses the authenticated master');
  await restarted.evaluate(async () => {
    const preferences = await window.desktop.sshConnectionPreferences();
    await window.desktop.setSshConnectionPreferences({ ...preferences, keepAliveSeconds: 0 });
  });
  await app.close(); app = undefined;
  await gone(pid);
  await assert.rejects(mux(socket, 'check'));
  console.log('PASS: the app reused the same authenticated master after restart and closed it with Disconnect on quit');
} finally {
  try {
    await app?.close();
  } finally {
    try {
      for (const socket of await sockets()) {
        await masterPid(socket).catch(() => {});
        await mux(socket, 'exit').catch(() => {});
      }
      for (const pid of pids) await gone(pid);
    } finally {
      sshd?.stop();
      await rm(root, { recursive: true, force: true });
    }
  }
}
