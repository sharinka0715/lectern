import assert from 'node:assert/strict';
import test from 'node:test';
import { machineName, workspaceMachines } from '../src/renderer/workspace-machines';
import type { Workspace } from '../src/shared/types';

const workspace = (id: string, endpoint: Partial<Workspace>): Workspace => ({ id, name: id, cwd: '/same', kind: 'local', ...endpoint });

test('保存空机器不生成项目；旧工作区按 SSH 身份和端口归组，不按目录名混合', () => {
  const machines = workspaceMachines('darwin', [{ id:'build', name:'示例机器', host:'devbox' }, { id:'empty', name:'空机器', host:'empty' }], [
    workspace('one', { kind:'ssh', host:'devbox' }), workspace('local', {}), workspace('two', {kind:'ssh', host:'devbox'}),
    workspace('port', {kind:'ssh', host:'devbox', port:22}), workspace('login', {kind:'ssh', host:'other@devbox'}),
  ]);
  assert.deepEqual(machines.map(m => [m.name, m.folders.map(w => w.id)]), [
    ['本地', ['local']], ['示例机器', ['one', 'two']], ['空机器', []], ['devbox:22', ['port']], ['other@devbox', ['login']],
  ]);
});

test('Windows 只列 SSH 机器：没有「本地」', () => {
  const machines = workspaceMachines('win32', [{ id: 'p', name: '训练机', host: 'gpu-1' }], [workspace('remote', {kind:'ssh', host:'gpu-1'})]);
  assert.deepEqual(machines.map(m => [m.name, m.endpoint.kind, m.folders.map(f => f.id)]), [['训练机','ssh',['remote']]]);
  assert.deepEqual(workspaceMachines('win32', [], []), [], 'a new Windows install starts with no machine');
  assert.deepEqual(workspaceMachines('darwin', [], []).map(m => m.name), ['本地']);
});

test('活动卡片里的机器名与侧栏一致：已保存连接用其名称，其余用主机和端口，本机为「本地」', () => {
  const profiles = [{ id: 'p', name: '训练机', host: 'gpu-1' }, { id: 'q', name: '', host: 'gpu-2', port: 2222 }];
  const name = (endpoint: Partial<Workspace>, platform = 'darwin') => machineName(workspace('w', endpoint), platform, profiles);
  assert.equal(name({}), '本地');
  assert.equal(name({ kind: 'ssh', host: 'gpu-1' }), '训练机');
  assert.equal(name({ kind: 'ssh', host: 'gpu-1', port: 2200 }), 'gpu-1:2200', 'another port is another machine');
  assert.equal(name({ kind: 'ssh', host: 'gpu-2', port: 2222 }), 'gpu-2', 'a saved connection without a name shows its host');
  assert.equal(name({ kind: 'ssh', host: 'jump-box' }), 'jump-box');
  // The sidebar groups use the same names.
  for (const endpoint of [{ kind: 'ssh' as const, host: 'gpu-1' }, { kind: 'ssh' as const, host: 'jump-box', port: 22 }]) {
    const machine = workspaceMachines('darwin', profiles, [workspace('w', endpoint)]).find(row => row.folders.length);
    assert.equal(machine?.name, name(endpoint));
  }
});
