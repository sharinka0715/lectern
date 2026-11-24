import assert from 'node:assert/strict';
import test from 'node:test';
import { backgroundCounts, backgroundSummary } from '../src/core/background-work';
import { observedSessionStatus } from '../src/core/observed-status';
import { closeConfirmation } from '../src/renderer/close-confirmation';
import type { SessionActivity } from '../src/shared/activity';

const item = (id: string, kind: SessionActivity['kind'], changes: Partial<SessionActivity> = {}): SessionActivity =>
  ({ id, kind, status: 'running', title: id, events: [], ...changes });

test('background shells, subagents, monitors and pending workflows are summed up', () => {
  assert.equal(backgroundSummary([]), undefined);
  // A foreground shell or agent belongs to the reply itself.
  assert.equal(backgroundSummary([item('fg', 'shell'), item('agent', 'agent')]), undefined);
  assert.equal(backgroundSummary([item('a', 'shell', { background: true }), item('b', 'shell', { background: true, status: 'completed' }),
    item('c', 'agent', { background: true }), item('d', 'monitor')], { agents: 2, workflows: 1 }),
  '1 个终端、2 个子代理、1 个监控、1 个工作流仍在运行');
  // Ended or no longer observable work is not running.
  assert.equal(backgroundSummary([item('a', 'shell', { background: true, status: 'unobserved' })]), undefined);
  // Claude Code's own "shell" state covers shells the transcript has no record of.
  assert.equal(backgroundSummary([], undefined, 'shell'), '终端仍在运行');
  assert.equal(backgroundSummary([item('d', 'monitor')], undefined, 'shell'), '终端、1 个监控仍在运行');
});

test('Claude Code\'s own state and process start rule out work that died with an earlier process', () => {
  const shell = item('a', 'shell', { background: true, startedAt: '2026-11-20T10:00:00.000Z' });
  const agent = item('c', 'agent', { background: true, startedAt: '2026-11-20T10:00:00.000Z' });
  const monitor = item('d', 'monitor', { startedAt: '2026-11-20T10:00:00.000Z' });
  // Native "idle": no background shells, subagents or workflows (monitors are not part of it).
  assert.equal(backgroundSummary([shell, agent, monitor], { agents: 1, workflows: 1 }, 'idle'), '1 个监控仍在运行');
  // Native "shell": shells, but no subagents or workflows.
  assert.equal(backgroundSummary([shell, agent], { agents: 1, workflows: 1 }, 'shell'), '1 个终端仍在运行');
  assert.equal(backgroundSummary([shell, agent], undefined, 'busy'), '1 个终端、1 个子代理仍在运行');
  // Started before the current process registered: gone with the old process.
  const restarted = Date.parse('2026-11-20T11:00:00.000Z');
  assert.equal(backgroundSummary([shell, agent, monitor], { agents: 1, workflows: 0, at: '2026-11-20T10:00:05.000Z' }, 'busy', restarted), undefined);
  assert.equal(backgroundSummary([{ ...monitor, startedAt: '2026-11-20T11:00:02.000Z' }], undefined, 'idle', restarted), '1 个监控仍在运行');
});

test('a subagent resumed in the current process counts from its resume; counts are also there for a close confirmation', () => {
  const restarted = Date.parse('2026-11-20T11:00:00.000Z');
  const resumed = item('r', 'agent', { background: true, startedAt: '2026-11-20T10:00:00.000Z', resumedAt: '2026-11-20T11:05:00.000Z', resumes: 1 });
  assert.equal(backgroundSummary([resumed], undefined, 'busy', restarted), '1 个子代理仍在运行');
  assert.deepEqual(backgroundCounts([resumed, item('d', 'monitor')], { agents: 0, workflows: 2 }, 'busy', restarted),
    { shells: 0, agents: 1, monitors: 1, workflows: 2 });
  assert.deepEqual(backgroundCounts([], undefined, 'shell'), { shells: 0, agents: 0, monitors: 0, workflows: 0, unknownShells: true });
});

test('busy after a finished turn with background subagents or workflows is not a reply in progress', () => {
  assert.equal(observedSessionStatus('idle', 'busy'), 'working');
  assert.equal(observedSessionStatus('idle', 'busy', false, true), 'idle');
  assert.equal(observedSessionStatus('working', 'busy', false, true), 'working');
  assert.equal(observedSessionStatus('idle', 'waiting', false, true), 'waiting');
  assert.equal(observedSessionStatus('idle', 'busy', true, true), 'error');
});

test('closing a conversation always asks, and names what it stops with counts', () => {
  const idle = closeConfirmation(false, { shells: 0, agents: 0, monitors: 0, workflows: 0 });
  assert.equal(idle.title, '关闭这个对话？');
  assert.match(idle.message, /Claude Code 将退出.*可以续接/);
  assert.equal(idle.detail, undefined);
  assert.equal(idle.danger, true);
  assert.equal(closeConfirmation(true, { shells: 1, agents: 2, monitors: 1, workflows: 1 }).detail,
    '以下仍在运行，将被停止：正在进行的回复、1 个终端、2 个子代理、1 个监控、1 个工作流。');
  assert.equal(closeConfirmation(false, { shells: 0, agents: 0, monitors: 0, workflows: 0, unknownShells: true }).detail, '回复完成。以下仍在运行，将被停止：终端。');
  assert.equal(closeConfirmation(true).detail, '以下仍在运行，将被停止：正在进行的回复。');
});
