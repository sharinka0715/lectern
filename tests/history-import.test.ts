import assert from 'node:assert/strict';
import test from 'node:test';
import { findImportedWorkspace, sameHistoryTarget } from '../src/renderer/history-import';
import type { Workspace } from '../src/shared/types';

const workspace: Workspace = { id: 'project', kind: 'local', cwd: '/sample/project', name: 'Example' };

test('history import matches folders on the same endpoint', () => {
  assert.equal(sameHistoryTarget(workspace, { kind: 'local' }), true);
  assert.equal(sameHistoryTarget(workspace, { kind: 'ssh', host: 'sample' }), false);
  const ssh: Workspace = { ...workspace, kind: 'ssh', host: 'sample', port: 2222 };
  assert.equal(sameHistoryTarget(ssh, { kind: 'ssh', host: 'sample', port: 2222 }), true);
  assert.equal(sameHistoryTarget(ssh, { kind: 'ssh', host: 'another', port: 2222 }), false);
  assert.equal(sameHistoryTarget(ssh, { kind: 'ssh', host: 'sample' }), false);
  assert.deepEqual(findImportedWorkspace([workspace], { kind: 'local' }, '/sample/project/'), workspace);
  assert.equal(findImportedWorkspace([ssh], { kind: 'local' }, workspace.cwd), undefined);
});
