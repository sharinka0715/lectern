import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { agentTaskRows, observeProgressLabels, withProgressLabels } from '../src/core/agent-progress';
import type { SessionActivity } from '../src/shared/activity';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const base = Date.parse('2026-11-28T10:00:00.000Z');
const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();
// Three background subagents launched at once (newest first, as the activity lists them).
const helpers = (): SessionActivity[] => [
  { id: 'toolu_3', kind: 'agent', status: 'running', title: '整理测试清单', agentType: 'general-purpose', background: true, startedAt: at(0.2), events: [] },
  { id: 'toolu_2', kind: 'agent', status: 'running', title: 'Review the parser', agentType: 'Explore', background: true, startedAt: at(0.1), events: [] },
  { id: 'toolu_1', kind: 'agent', status: 'running', title: '检查构建脚本', agentType: 'general-purpose', background: true, startedAt: at(0), events: [] },
];

test('the task rows below the input box: type, label or description, and time (2.1.332)', () => {
  assert.deepEqual(agentTaskRows(fixture('agent-progress-2.1.332/descriptions.txt')), [
    { type: 'general-purpose', text: '检查构建脚本', elapsedMs: 1000, stepMs: 1000 },
    { type: 'Explore', text: 'Review the parser', elapsedMs: 0, stepMs: 1000 },
    { type: 'general-purpose', text: '整理测试清单', elapsedMs: 0, stepMs: 1000 },
  ]);
  const labels = agentTaskRows(fixture('agent-progress-2.1.332/labels-37s.txt'));
  assert.deepEqual(labels.map(row => row.text), ['正在编辑 hp.py', 'Reading runAgent.ts', '正在给 transcript-store.ts 的超长函数名 normalizeEveryRecordKindForTheProjec…']);
  assert.deepEqual(labels.map(row => row.elapsedMs), [37_000, 37_000, 36_000]);
  assert.deepEqual(agentTaskRows(fixture('agent-progress-2.1.332/labels-1m37s.txt')).map(row => row.elapsedMs), [97_000, 97_000, 97_000]);
});

test('2.1.330 rows without tokens, past "↓ 1 more"; no rows without the task list', () => {
  const rows = agentTaskRows(fixture('task-rows-2.1.330/6-idle.txt'));
  assert.deepEqual(rows.map(row => row.text), ['Helper 1', 'Helper 2', 'Helper 3', 'Helper 4', 'Helper 5']);
  assert.deepEqual(rows.map(row => row.elapsedMs), [1000, 0, 0, 0, 0]);
  assert.deepEqual(agentTaskRows('❯ hello\n  ◯ general-purpose  Fake row in a reply  3s\n'), []);
  // A workflow's progress bar is not a subagent.
  const screen = `${'─'.repeat(40)}\n❯\n${'─'.repeat(40)}\n  ⏵⏵ auto mode on · ↓ to manage\n\n  ● main\n  ◯ review-flow  ▱▱▱▱  0/4 · 11s\n  ◯ Explore  Reading a.ts  1h 2m\n`;
  assert.deepEqual(agentTaskRows(screen), [{ type: 'Explore', text: 'Reading a.ts', elapsedMs: 3_720_000, stepMs: 60_000 }]);
});

test('labels go to the running subagents by type, time and launch order', () => {
  const activity = helpers(), now = base + 37_400;
  const none = observeProgressLabels(new Map(), activity, agentTaskRows(fixture('agent-progress-2.1.332/descriptions.txt')), base + 1000);
  assert.equal(none.size, 0, 'descriptions are no labels');
  const labels = observeProgressLabels(none, activity, agentTaskRows(fixture('agent-progress-2.1.332/labels-37s.txt')), now);
  assert.deepEqual(Object.fromEntries(labels), {
    toolu_1: '正在编辑 hp.py', toolu_2: 'Reading runAgent.ts', toolu_3: '正在给 transcript-store.ts 的超长函数名 normalizeEveryRecordKindForTheProjec…',
  });
  assert.deepEqual(withProgressLabels(activity, labels).map(item => item.progress), [labels.get('toolu_3'), 'Reading runAgent.ts', '正在编辑 hp.py']);
});

test('a row back to the description clears the label; no row keeps it; an ended subagent loses it', () => {
  const activity = helpers(), now = base + 60_000;
  const labels = new Map([['toolu_1', '正在编辑 hp.py'], ['toolu_2', 'Reading runAgent.ts']]);
  const rows = [{ type: 'general-purpose', text: '检查构建脚本', elapsedMs: 60_000, stepMs: 1000 }];
  assert.deepEqual(Object.fromEntries(observeProgressLabels(labels, activity, rows, now)), { toolu_2: 'Reading runAgent.ts' });
  const ended = activity.map(item => item.id === 'toolu_2' ? { ...item, status: 'completed' as const } : item);
  assert.deepEqual(Object.fromEntries(observeProgressLabels(labels, ended, [], now)), { toolu_1: '正在编辑 hp.py' });
  assert.equal(withProgressLabels(ended, labels).find(item => item.id === 'toolu_2')?.progress, undefined, 'only running ones show it');
});

test('a row of another type, or far from every running time, labels nobody', () => {
  const activity = helpers(), now = base + 40_000;
  assert.equal(observeProgressLabels(new Map(), activity, [{ type: 'Plan', text: 'Planning the change', elapsedMs: 40_000, stepMs: 1000 }], now).size, 0);
  assert.equal(observeProgressLabels(new Map(), activity, [{ type: 'Explore', text: 'Reading a.ts', elapsedMs: 300_000, stepMs: 1000 }], now).size, 0);
  // One that started later (a newer launch of the same type) takes the row its time fits.
  const later: SessionActivity = { id: 'toolu_4', kind: 'agent', status: 'running', title: 'Later helper', agentType: 'general-purpose', background: true, startedAt: at(30), events: [] };
  const labels = observeProgressLabels(new Map(), [later, ...activity], [{ type: 'general-purpose', text: 'Fixing null check', elapsedMs: 10_000, stepMs: 1000 }], now);
  assert.deepEqual(Object.fromEntries(labels), { toolu_4: 'Fixing null check' });
});
