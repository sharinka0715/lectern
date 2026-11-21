import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { classifySessionScreen, withoutTaskRows } from '../src/core/screen';
import { canInterruptTurn, turnComposer } from '../src/core/turn-controls';
import { isIdleEmptyComposer } from '../src/core/settings-screen';
import { paneNavigationStatus } from '../src/backend/session-status';

// Claude Code 2.1.329 after its reply, a dynamic workflow still running in the
// background (captured with a loopback model): "Waiting for 1 dynamic workflow
// to finish", the empty prompt, and the workflow's row below the footer.
const running = readFileSync(new URL('./fixtures/workflow-2.1.329/running.txt', import.meta.url), 'utf8');
const agents = running.replace(/(  ◯ demo-map[^\n]*)/u, '$1\n  ⏺ main\n  ◯ general-purpose  后台子代理    2s\n  ◯ general-purpose  第二个子代理  5s\n'
  + Array.from({ length: 8 }, (_, i) => `  ◯ Explore  第 ${i + 3} 个子代理  ${i + 6}s`).join('\n'));
const spaced = running.replace(/\n(  ◯ demo-map)/u, '\n\n$1');

test('the input box is found with background work listed below it, however many rows', () => {
  for (const screen of [running, agents, spaced]) {
    assert.equal(classifySessionScreen(screen).status, 'idle');
    const editor = turnComposer(screen);
    assert.deepEqual(editor && { empty: editor.empty, running: editor.running }, { empty: true, running: false });
    assert.equal(isIdleEmptyComposer(screen), true);
    assert.equal(canInterruptTurn(screen, 'busy', editor), false, 'nothing to stop while only the workflow runs');
    const nav = paneNavigationStatus({ id: '%1', active: true, dead: false, native: { sessionId: 's', procStart: '1', status: 'busy' } }, { screen });
    assert.equal(nav.status, 'idle'); assert.match(nav.background!, /工作流/);
  }
});

test('only rows right below the editor footer are background tasks', () => {
  const lines = ['● 正文里的列表：', '  ● 不是任务行', '  ◯ 也不是'];
  assert.deepEqual(withoutTaskRows(lines), lines);
  const editor = ['─'.repeat(20), '❯ ', '─'.repeat(20), '  ⏵⏵ accept edits on (shift+tab to cycle)', '', '  ◯ demo  ▱▱▱  0/4 · 1s', '  ⏺ main'];
  assert.deepEqual(withoutTaskRows(editor), editor.slice(0, 4));
});
