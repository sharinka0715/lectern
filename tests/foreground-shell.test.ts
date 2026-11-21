import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionActivityStore } from '../src/core/session-activity';
import { liveShells, panelActivities, shellScreenLines } from '../src/shared/activity';

const sessionId = 'session-fg';
const at = (s: number) => new Date(Date.UTC(2026, 10, 20, 0, 0, s)).toISOString();
const use = (id: string, name: string, input: Record<string, unknown>, s: number) =>
  ({ type: 'assistant', sessionId, timestamp: at(s), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, s: number, toolUseResult: Record<string, unknown> = {}) =>
  ({ type: 'user', sessionId, timestamp: at(s), toolUseResult, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

test('a running foreground shell is shown in the transcript, not in the activity panel', () => {
  const store = new SessionActivityStore(sessionId);
  store.ingest([use('fg', 'Bash', { command: 'npm test', description: 'Run tests' }, 1)]);
  const items = store.snapshot(true);
  assert.deepEqual(panelActivities(items), []);
  assert.deepEqual([...liveShells(items)], [['fg', { command: 'npm test', title: 'Run tests', startedAt: at(1), output: undefined }]]);
  store.ingest([result('fg', 6, { stdout: 'ok' })]);
  assert.deepEqual(panelActivities(store.snapshot(true)), [], 'a finished foreground shell stays in the transcript only');
  assert.equal(liveShells(store.snapshot(true)).size, 0);
});

test('background shells, shells moved to the background, agents and monitors stay in the panel', () => {
  const store = new SessionActivityStore(sessionId);
  store.ingest([
    use('bg', 'Bash', { command: 'npm run dev', run_in_background: true }, 1),
    use('moved', 'Bash', { command: 'sleep 600' }, 2),
    use('agent', 'Agent', { description: 'Explore', prompt: 'look', subagent_type: 'Explore' }, 3),
    use('mon', 'Monitor', { command: 'tail -f log' }, 4),
  ]);
  assert.deepEqual(panelActivities(store.snapshot(true)).map(item => item.id).sort(), ['agent', 'bg', 'mon']);
  assert.deepEqual([...liveShells(store.snapshot(true)).keys()], ['moved']);
  // Ctrl+B (twice) moves a running command to the background.
  store.ingest([result('moved', 5, { backgroundTaskId: 'task_moved' })]);
  assert.deepEqual(panelActivities(store.snapshot(true)).map(item => item.id).sort(), ['agent', 'bg', 'mon', 'moved']);
  assert.equal(liveShells(store.snapshot(true)).size, 0);
});

test('the running command line count comes from Claude Code\'s own screen line', () => {
  const command = 'for i in 1 2 3 4 5; do echo fg-line-$i; sleep 1; done';
  // Claude Code 2.1.328, 4 s into the command.
  const screen = `⏺ Printing five lines slowly · 3s\n  ⎿  $ ${command} (4s · 5 lines)\n     (ctrl+b ctrl+b (twice) to run in background)\n`;
  assert.equal(shellScreenLines(screen, command), 5);
  assert.equal(shellScreenLines('  ⎿  $ npm run very-long-script-name --wi… (12s · 1 line)', 'npm run very-long-script-name --with flags'), 1);
  assert.equal(shellScreenLines(`  ⎿  $ ${command} (2s)`, command), undefined, 'no count before the first line');
  assert.equal(shellScreenLines(screen + screen, command), undefined, 'two matching rows are ambiguous');
  assert.equal(shellScreenLines(screen, 'npm test'), undefined);
});
