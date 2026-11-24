import assert from 'node:assert/strict';
import test from 'node:test';
import { classifySessionScreen, extractPreview, withoutEditorNotices } from '../src/core/screen';
import { canInterruptTurn, turnComposer } from '../src/core/turn-controls';
import { parseTurnProgress } from '../src/core/turn-progress';
import { performTurnAction, type TurnDriver } from '../src/backend/native-turn-controls';
import { REPLY } from './helpers/claude-screen';

// Layouts sampled from Claude Code 2.1.316 (and 2.1.328) in a 120-column tmux pane:
// no "esc to interrupt" in the footer, a tip under the spinner, and transient
// notices right-aligned on their own row above the input box.
const rule = '─'.repeat(120);
const right = (text: string, pad = 0) => ' '.repeat(120 - pad - text.length) + text + ' '.repeat(pad);
const focusNotice = right("tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf and reattach for focus tracking");
const updateNotice = right('✔ Update installed · Restart to apply', 2);
const box = (draft = '', footer = '  ⏵⏵ auto mode on (shift+tab to cycle)') => [rule, '❯ ' + draft, rule, '', footer, ''].join('\n');

const working = [
  '❯ check the data',
  '',
  '● Neither dataset is in the pretraining set. Checking the machine for existing copies.',
  '',
  '✻ Creating… (1m 57s · ↓ 8.5k tokens)',
  "  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude's current work",
  updateNotice,
  box(),
].join('\n');

const compacting = [
  '❯ /compact',
  '',
  '✶ Compacting conversation… (2s)',
  '  ⎿  Tip: Working with HTML/CSS? Install the frontend-design plugin:',
  '     /plugin install frontend-design@claude-plugins-official',
  focusNotice,
  box(),
].join('\n');

const finished = [
  '❯ hi',
  '',
  `${REPLY} Hi! What would you like to work on today?`,
  '',
  '✻ Crunched for 2s · done 6:43 AM',
  '', '', '',
  focusNotice,
  box('', '  ⏵⏵ auto mode on (shift+tab to cycle) · install gh for PR status'),
].join('\n');

test('a reply in progress without the footer hint still owns an input box that accepts a queued draft', () => {
  const editor = turnComposer(working);
  assert.equal(editor?.running, true, 'the spinner above the box, past the tip and the update notice, shows the turn runs');
  assert.equal(editor?.empty, true);
  assert.equal(classifySessionScreen(working).status, 'working');
  assert.equal(canInterruptTurn(working, 'busy', editor), true);
  assert.deepEqual(parseTurnProgress(working, editor), { activity: 'Creating', elapsed: '1m 57s', tokens: { display: '8.5k', direction: 'down' } });
  assert.equal(turnComposer(working.replace('✻ Creating… (1m 57s · ↓ 8.5k tokens)', '✻ Crunched for 1m 57s'))?.running, false,
    'a finished status line is not a running turn');
  assert.equal(turnComposer('✻ Thinking… (example in prose)\n\n● Done.\n\n' + box())?.running, false, 'a spinner-like row higher up is inert');
});

test('/compact with a wrapped tip and the tmux focus notice is shown as compacting', () => {
  const editor = turnComposer(compacting);
  assert.equal(editor?.running, true);
  assert.equal(parseTurnProgress(compacting, editor)?.compactPhase, 'compacting');
});

test('the tmux focus notice above the box is neither reply text nor a reason to keep the turn open', () => {
  const preview = extractPreview(finished, 'hi', '', finished);
  assert.equal(preview.text, 'Hi! What would you like to work on today?');
  assert.equal(preview.status, 'idle');
  assert.equal(turnComposer(finished)?.running, false);
});

test('only right-aligned rows directly on the box are notices', () => {
  const code = ['● Example:', '', '  ```', '          indented code that is not right-aligned', '  ```', box()].join('\n').split('\n');
  assert.deepEqual(withoutEditorNotices(code), code);
  const spaced = ['● Done.', focusNotice, '', box()].join('\n').split('\n');
  assert.deepEqual(withoutEditorNotices(spaced), spaced, 'a blank row between the row and the box keeps it');
  // A named border: 120 cells, though only 114 characters.
  const named = (row: string) => [row, `${'─'.repeat(105)} 项目页面设计 ─`, '❯ ', rule];
  assert.deepEqual(withoutEditorNotices(named(focusNotice)), named(''));
  const short = focusNotice.slice(0, -8);
  assert.deepEqual(withoutEditorNotices(named(short)), named(short), 'wide characters count as two cells: this row ends short of the edge');
});

test('while compacting, a draft can only be queued: steering and "send now" are refused before any key', async () => {
  const keys: string[] = [];
  const driver: TurnDriver = {
    frame: async () => ({ paneId: '%9', panePid: 21, viewport: compacting, nativeStatus: 'busy' }),
    pasteForTurn: async () => { keys.push('paste'); },
    keyForTurn: async key => { keys.push(key); },
  };
  await assert.rejects(performTurnAction(driver, '%9', 21, { kind: 'steer', text: 'after the summary' }), /正在压缩对话/);
  await assert.rejects(performTurnAction(driver, '%9', 21, { kind: 'flushQueue' }), /正在压缩对话/);
  assert.deepEqual(keys, []);
});

test('2.1.316 marks the last queued prompt with "ctrl+x ctrl+s to send now" instead of "Queued"', () => {
  const view = ['● Checking the data.', '', '❯ add one more level', '', '❯ make it two levels', '  ctrl+x ctrl+s to send now', '',
    '✻ Creating… (3m 20s · ↓ 8.5k tokens)', "  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude's current work",
    updateNotice, box('Press up to edit queued messages')].join('\n');
  const editor = turnComposer(view);
  assert.equal(editor?.running, true);
  assert.equal(editor?.empty, true, 'the placeholder is not a draft');
  assert.deepEqual(editor?.queued, ['add one more level', 'make it two levels']);
});
