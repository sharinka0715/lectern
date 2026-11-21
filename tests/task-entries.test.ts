import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionActivity } from '../src/shared/activity';
import { defaultTask, shownTask, taskEntries } from '../src/renderer/task-entries';

const item = (id: string, kind: SessionActivity['kind'], status: SessionActivity['status'], extra: Partial<SessionActivity> = {}): SessionActivity =>
  ({ id, kind, status, title: id, events: [], ...(kind !== 'agent' && { background: true }), ...extra });

test('the task column groups subagents, background shells and monitors; a foreground shell is not listed', () => {
  const items = [item('a1', 'agent', 'completed', { taskId: 'agent1', agentType: 'Explore' }), item('s1', 'shell', 'running', { title: 'Build', command: 'npm run build \\\n  --verbose' }),
    item('s2', 'shell', 'completed', { background: undefined, command: 'ls' }), item('m1', 'monitor', 'running', { title: 'tail -f log', command: 'tail -f log' })];
  const groups = taskEntries(items, [{ agentId: 'old0001', size: 10, description: 'Earlier helper', finished: true }]);
  assert.deepEqual(groups.agent.map(entry => [entry.key, entry.note, entry.status]), [['a1', 'Explore', 'completed'], ['agent:old0001', undefined, 'completed']]);
  assert.deepEqual(groups.shell.map(entry => [entry.key, entry.note]), [['s1', 'npm run build']], 'the first command line, without its continuation');
  assert.deepEqual(groups.monitor.map(entry => [entry.key, entry.note]), [['m1', undefined]], 'no note repeating the title');
});

test('opening without a choice: a running entry of the kind asked for; the default subagent otherwise', () => {
  const items = [item('a1', 'agent', 'completed', { taskId: 'agent1' }), item('a2', 'agent', 'running', { taskId: 'agent2' }),
    item('s1', 'shell', 'completed'), item('s2', 'shell', 'running'), item('m1', 'monitor', 'completed')];
  const groups = taskEntries(items, []);
  assert.equal(defaultTask(groups, 'shell')?.key, 's2');
  assert.equal(defaultTask(groups, 'monitor')?.key, 'm1');
  assert.equal(defaultTask(groups, 'agent')?.key, 'a2');
  assert.equal(defaultTask(groups)?.key, 'a2');
  assert.equal(defaultTask(taskEntries([item('m1', 'monitor', 'running')], []), 'shell')?.key, 'm1', 'nothing of that kind: any entry');
  assert.equal(defaultTask(taskEntries([], [])), undefined);
  // The chosen entry wins; a subagent is found again by its agent ID when its key changed.
  assert.equal(shownTask(groups, 'm1', undefined, 'shell')?.key, 'm1');
  const earlier = taskEntries([], [{ agentId: 'agent1', size: 10, description: 'Helper' }]);
  assert.equal(shownTask(earlier, 'a1', 'agent1')?.key, 'agent:agent1');
  assert.equal(shownTask(groups, 'gone', undefined, 'shell')?.key, 's2', 'an entry that left the card: the default of the kind');
});

const time = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`;

test('each group lists running entries first, then ended ones, each newest first by its latest start', () => {
  // In card order (newest launch first), as session-activity.ts gives them.
  const items = [
    item('a4', 'agent', 'completed', { taskId: 'agent4', startedAt: time(4) }), item('s3', 'shell', 'completed', { startedAt: time(13) }),
    item('a3', 'agent', 'running', { taskId: 'agent3', startedAt: time(3) }), item('m2', 'monitor', 'stopped', { startedAt: time(22) }),
    item('a2', 'agent', 'stopped', { taskId: 'agent2', startedAt: time(2) }), item('s2', 'shell', 'running', { startedAt: time(12) }),
    // Resumed with SendMessage: its latest run began later than any launch.
    item('a1', 'agent', 'running', { taskId: 'agent1', startedAt: time(1), resumedAt: time(5) }), item('m1', 'monitor', 'running', { startedAt: time(21) }),
    item('a0', 'agent', 'completed', { taskId: 'agent0', startedAt: time(0), resumedAt: time(6), endedAt: time(7) }),
    item('s1', 'shell', 'failed', { startedAt: time(11) }), item('s0', 'shell', 'running', { startedAt: time(14) })];
  // Earlier subagents (launch not in the loaded history) come last whatever their meta says.
  const groups = taskEntries(items, [{ agentId: 'old0002', size: 10, description: 'Unfinished earlier' }, { agentId: 'old0001', size: 10, description: 'Earlier', finished: true }]);
  assert.deepEqual(groups.agent.map(entry => [entry.key, entry.status]), [['a1', 'running'], ['a3', 'running'], ['a0', 'completed'], ['a4', 'completed'], ['a2', 'stopped'],
    ['agent:old0002', 'unobserved'], ['agent:old0001', 'completed']]);
  assert.deepEqual(groups.shell.map(entry => entry.key), ['s0', 's2', 's3', 's1']);
  assert.deepEqual(groups.monitor.map(entry => entry.key), ['m1', 'm2']);
  assert.equal(defaultTask(groups)?.key, 'a1', 'the default is still the first running subagent');
  assert.equal(defaultTask(groups, 'shell')?.key, 's0');
});

test('entries without a time keep their places in their group; equal times keep their order', () => {
  const items = [item('x', 'shell', 'completed'), item('y', 'shell', 'completed', { startedAt: time(1) }), item('r1', 'shell', 'running', { startedAt: 'not a time' }),
    item('z', 'shell', 'stopped'), item('w', 'shell', 'failed', { startedAt: time(3) }), item('r2', 'shell', 'running', { startedAt: time(2) }),
    item('v', 'shell', 'completed', { startedAt: time(3) }), item('r3', 'shell', 'running', { startedAt: time(4) })];
  // Running: r1 has no readable time and keeps the first place; r3 and r2 fill the others.
  // Ended: x and z keep the first and third places; w and v (same time, w first) and y fill the rest.
  assert.deepEqual(taskEntries(items, []).shell.map(entry => entry.key), ['r1', 'r3', 'r2', 'x', 'w', 'z', 'v', 'y']);
  assert.deepEqual(taskEntries(items.map(entry => ({ ...entry, startedAt: undefined })), []).shell.map(entry => entry.key), ['r1', 'r2', 'r3', 'x', 'y', 'z', 'w', 'v'],
    'without any times: card order within each group');
});

test('the shown entry stays shown when its state changes and the order with it', () => {
  const before = [item('s_new', 'shell', 'running', { startedAt: time(3) }), item('s_old', 'shell', 'running', { startedAt: time(1) }),
    item('m_done', 'monitor', 'completed', { startedAt: time(2) }), item('a_live', 'agent', 'running', { taskId: 'alive', startedAt: time(4) }),
    item('a_done', 'agent', 'completed', { taskId: 'adone', startedAt: time(0) })];
  const groups = taskEntries(before, []);
  assert.deepEqual(groups.shell.map(entry => entry.key), ['s_new', 's_old']);
  assert.equal(shownTask(groups, 's_new')?.key, 's_new');
  // s_new ends: it moves below s_old, and stays the one shown (not the new first entry or the default).
  const ended = taskEntries(before.map(entry => entry.id === 's_new' ? { ...entry, status: 'completed' as const } : entry), []);
  assert.deepEqual(ended.shell.map(entry => entry.key), ['s_old', 's_new']);
  assert.equal(shownTask(ended, 's_new', undefined, 'shell')?.key, 's_new');
  assert.equal(shownTask(ended, 's_new', undefined, 'shell')?.status, 'completed');
  // A finished subagent resumed with SendMessage moves to the top while shown.
  const resumed = taskEntries(before.map(entry => entry.id === 'a_done' ? { ...entry, status: 'running' as const, resumedAt: time(9) } : entry), []);
  assert.deepEqual(resumed.agent.map(entry => entry.key), ['a_done', 'a_live']);
  assert.equal(shownTask(resumed, 'a_live', 'alive')?.key, 'a_live', 'the one shown before stays shown, though no longer first');
  assert.equal(shownTask(resumed, 'a_done', 'adone')?.key, 'a_done');
  // An earlier subagent shown when older history reaches its launch: another key and another group.
  const earlier = taskEntries([before[3]], [{ agentId: 'adone', size: 10, finished: true }]);
  assert.deepEqual(earlier.agent.map(entry => entry.key), ['a_live', 'agent:adone']);
  const loaded = taskEntries(resumed.agent.map(entry => entry.item!), [{ agentId: 'adone', size: 10, finished: true }]);
  assert.equal(shownTask(loaded, 'agent:adone', 'adone')?.key, 'a_done');
});
