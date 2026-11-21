import test from 'node:test';
import assert from 'node:assert/strict';
import type { Workspace } from '../src/shared/types';
import { checkSshMachines, machineConnection, reportMachineResult, sshConnectionError, sshMachineKey, sshMachines } from '../src/renderer/ssh-machines';
import { machineKey } from '../src/renderer/workspace-machines';

const folder = (id: string, host: string, port?: number): Workspace => ({ id, name: id, kind: 'ssh', cwd: '/w/' + id, host, ...(port ? { port } : {}) });

test('every SSH machine is listed: saved connections, then machines known only from their folders', () => {
  const saved = [{ id: 'c1', name: 'GPU 开发机', host: 'dev-server' }];
  const workspaces = [folder('a', 'gpu-box'), folder('b', 'dev-server'), folder('c', 'gpu-box'), folder('d', 'lab', 2222),
    { id: 'local', name: 'local', kind: 'local', cwd: '/tmp' } as Workspace];
  const machines = sshMachines(saved, workspaces);
  assert.deepEqual(machines.map(m => [m.name, m.host, m.port, !!m.profile, m.folders]), [
    ['GPU 开发机', 'dev-server', undefined, true, 1],
    ['gpu-box', 'gpu-box', undefined, false, 2],
    ['lab:2222', 'lab', 2222, false, 1],
  ]);
  // The sidebar groups folders under the same key.
  assert.equal(machines[1].key, machineKey({ kind: 'ssh', host: 'gpu-box' }));
  assert.equal(machines[2].key, machineKey({ kind: 'ssh', host: 'lab', port: 2222 }));
});

test('only connection failures change a machine: login, unreachable, then ok after a success', () => {
  const key = sshMachineKey('gpu-box');
  reportMachineResult('gpu-box', undefined, new Error("Error invoking remote method 'lectern:discover': Error: 当前目录不存在"));
  assert.equal(machineConnection(key), undefined, 'a folder problem says nothing about the connection');
  reportMachineResult('gpu-box', undefined, new Error("Error invoking remote method 'lectern:discover': Error: dev@192.0.2.10: Permission denied (publickey,password)."));
  assert.deepEqual(machineConnection(key), { state: 'login', message: 'dev@192.0.2.10: Permission denied (publickey,password).' });
  reportMachineResult('gpu-box', undefined, new Error('ssh: connect to host 192.0.2.10 port 22: Operation timed out'));
  assert.equal(machineConnection(key)?.state, 'unreachable');
  reportMachineResult('gpu-box', undefined);
  assert.deepEqual(machineConnection(key), { state: 'ok' });
  for (const message of ['Host key verification failed.', 'ssh: Could not resolve hostname devbox: nodename nor servname provided', 'kex_exchange_identification: read: Connection reset by peer'])
    assert.ok(sshConnectionError(message), message);
  assert.ok(!sshConnectionError('请等 Claude 回到空闲输入框后再重命名'));
});

test('the startup check asks each unknown machine once and classifies the answer', async () => {
  const asked: string[] = [];
  (globalThis as any).window = { desktop: { checkSshConnection: async ({ host }: { host: string }) => {
    asked.push(host);
    return host === 'needs-login' ? { ok: false, message: 'Permission denied (keyboard-interactive).' }
      : host === 'down' ? { ok: false, message: 'ssh: connect to host down port 22: No route to host' } : { ok: true };
  } } };
  try {
    const machines = sshMachines([], [folder('a', 'needs-login'), folder('b', 'down'), folder('c', 'fine'), folder('d', 'fine')]);
    await checkSshMachines(machines);
    assert.deepEqual(asked.sort(), ['down', 'fine', 'needs-login']);
    assert.equal(machineConnection(sshMachineKey('needs-login'))?.state, 'login');
    assert.equal(machineConnection(sshMachineKey('down'))?.state, 'unreachable');
    assert.equal(machineConnection(sshMachineKey('fine'))?.state, 'ok');
    await checkSshMachines(machines);
    assert.equal(asked.length, 3, 'known machines are not checked again');
    await checkSshMachines(machines.filter(m => m.host === 'down'), { force: true });
    assert.deepEqual(asked.slice(3), ['down'], 'a retry checks again');
  } finally { delete (globalThis as any).window; }
});

test('the backend check runs one non-interactive command and returns the SSH error instead of throwing', async () => {
  const { Backend } = await import('../src/backend');
  const backend = new Backend({ claudeCommand: 'false' });
  const calls: { host?: string; port?: number; tag?: string; script: string }[] = [];
  let failure: Error | undefined;
  (backend as any).transport.run = async (workspace: Workspace, script: string, options: { tag?: string }) => {
    calls.push({ host: workspace.host, port: workspace.port, tag: options.tag, script });
    if (failure) throw failure;
    return { stdout: Buffer.alloc(0), stderr: '' };
  };
  try {
    assert.deepEqual(await backend.checkSshConnection({ host: 'gpu-box' }), { ok: true });
    failure = new Error('dev@192.0.2.10: Permission denied (publickey,password).');
    assert.deepEqual(await backend.checkSshConnection({ host: 'lab', port: 2222 }), { ok: false, message: failure.message });
    assert.deepEqual(calls.map(c => [c.host, c.port, c.tag, c.script]), [['gpu-box', undefined, 'ssh.check', 'exit 0'], ['lab', 2222, 'ssh.check', 'exit 0']]);
    await assert.rejects(backend.checkSshConnection({ host: '-oProxyCommand=x' }));
  } finally { await backend.dispose(); }
});
