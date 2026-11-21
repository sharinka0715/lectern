import assert from 'node:assert/strict';
import test from 'node:test';
import { findImportedWorkspace, historyDirectoryKey, sameHistoryTarget } from '../src/renderer/history-import';
import type { Workspace } from '../src/shared/types';

const workspace: Workspace = { id: 'project', name: 'Project', kind: 'local', cwd: '/work/project' };

test('history import keeps inherited and explicit config modes distinct even at the same path', () => {
  const resolved = '/home/user/.claude';
  assert.equal(sameHistoryTarget(workspace, { kind: 'local' }, resolved), true);
  assert.equal(sameHistoryTarget(workspace, { kind: 'local', claudeDir: resolved }, resolved), false);
  assert.equal(sameHistoryTarget({ ...workspace, claudeDir: resolved }, { kind: 'local' }, resolved), false);
  assert.equal(sameHistoryTarget(workspace, { kind: 'local', claudeDir: '~/.claude' }, resolved), false);
});

test('an inherited custom config is not assumed to be the default ~/.claude directory', () => {
  assert.equal(sameHistoryTarget(workspace, { kind: 'local' }, '/profiles/work-claude'), true);
  assert.equal(sameHistoryTarget({ ...workspace, claudeDir: '~/.claude' }, { kind: 'local' }, '/profiles/work-claude'), false);
  assert.equal(sameHistoryTarget({ ...workspace, claudeDir: '/profiles/work-claude' }, { kind: 'local' }, '/profiles/work-claude'), false);
});

test('history import deduplicates explicit target paths and known resolved aliases', () => {
  const stored = { ...workspace, claudeDir: '/profiles/work-claude' };
  assert.equal(sameHistoryTarget(stored, { kind: 'local', claudeDir: '/profiles/work-claude/' }), true);
  assert.equal(sameHistoryTarget(stored, { kind: 'local', claudeDir: '~/work-claude' }, '/profiles/work-claude'), true);
  assert.equal(sameHistoryTarget(stored, { kind: 'local', claudeDir: '/profiles/personal-claude' }, '/profiles/personal-claude'), false);
});

test('history import preserves original cwd aliases and isolates SSH targets', () => {
  assert.equal(findImportedWorkspace([workspace], { kind: 'local' }, '/work/project/')?.id, workspace.id);
  assert.equal(findImportedWorkspace([workspace], { kind: 'local' }, '/work/project-symlink'), undefined);
  assert.equal(findImportedWorkspace([workspace], { kind: 'ssh', host: 'remote' }, workspace.cwd), undefined);
  const ssh: Workspace = { ...workspace, kind: 'ssh', host: 'remote', port: 2222 };
  assert.equal(sameHistoryTarget(ssh, { kind: 'ssh', host: 'remote', port: 2222 }), true);
  assert.equal(sameHistoryTarget(ssh, { kind: 'ssh', host: 'remote' }), false);
  assert.equal(sameHistoryTarget(ssh, { kind: 'ssh', host: 'another', port: 2222 }), false);
  assert.equal(sameHistoryTarget({ ...ssh, port: undefined }, { kind: 'ssh', host: 'remote' }), true);
  assert.equal(sameHistoryTarget({ ...ssh, port: 22 }, { kind: 'ssh', host: 'remote' }), false, 'An inherited SSH config port must not be assumed to equal explicit port 22');
  assert.equal(historyDirectoryKey('/'), '/');
});
