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
