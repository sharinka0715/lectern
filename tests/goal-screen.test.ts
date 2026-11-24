import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { goalTranscriptRow, parseGoalIndicator, parseGoalPanelLines, runningStopHook, withoutGoalIndicator } from '../src/core/goal-screen';
import { classifySessionScreen, extractPreview } from '../src/core/screen';
import { turnComposer } from '../src/core/turn-controls';
import { parseTurnProgress } from '../src/core/turn-progress';
import { parseExecutionMode } from '../src/core/session-telemetry';
import { isIdleEmptyComposer, observeEffortFooter, priorComposerHistory } from '../src/core/settings-screen';
import { parsePermissionScreen, permissionGuardLines } from '../src/core/permission-screen';
import { performTurnAction, type TurnDriver } from '../src/backend/native-turn-controls';
import { paintBullets } from './helpers/claude-screen';

// Real screens of Claude Code's native /goal in a 120-column tmux pane, nine versions
// (tests/fixtures/goal-<version>/, placeholder conditions "… ccm:g", sandbox paths).
const versions = ['2.1.300', '2.1.310', '2.1.321', '2.1.323', '2.1.325', '2.1.326', '2.1.329', '2.1.330', '2.1.331'];
const screen = (version: string, name: string) => readFileSync(new URL(`./fixtures/goal-${version}/${name}.txt`, import.meta.url), 'utf8');
const older = (version: string) => Number(version.split('.')[2]) < 326;

test('the goal indicator above the input box: active, its ticking timer, after other notices', () => {
  for (const version of versions) {
    assert.deepEqual(parseGoalIndicator(screen(version, 'active')), { state: 'active' }, `${version} active`);
    const deferred = parseGoalIndicator(screen(version, 'deferred'));
    assert.equal(deferred?.state, 'active', `${version} deferred`);
    assert.match(deferred?.elapsed ?? '', /^\d+s$/u, `${version} timer`);
    assert.equal(parseGoalIndicator(screen(version, 'notice'))?.state, 'active', `${version} beside the stop hook notice`);
    for (const name of ['panel-active', 'panel-achieved', 'panel-none']) assert.equal(parseGoalIndicator(screen(version, name)), undefined, `${version} ${name}`);
  }
  // The transcript's own goal rows and a goal panel's title are no indicator.
  assert.equal(parseGoalIndicator(['❯ /goal x', '  ⎿  Goal set: x', '◎ /goal active (3s)', '', '─'.repeat(40), '❯ ', '─'.repeat(40)].join('\n')), undefined);
  const paused = ' '.repeat(80) + '◐ medium · /effort · ◎ /goal paused';
  assert.deepEqual(parseGoalIndicator([paused, '─'.repeat(120), '❯ ', '─'.repeat(120)].join('\n')), { state: 'paused' });
});

test('without the indicator the notice row reads as before: right-aligned notices blank, the effort label kept', () => {
  const rule = '─'.repeat(120);
  const rows = (row: string) => withoutGoalIndicator([row, rule, '❯ '])[0];
  assert.equal(rows(' '.repeat(101) + '◎ /goal active (2s)'), '');
  assert.equal(rows(' '.repeat(78) + '◐ medium · /effort · ◎ /goal active (2s)'), ' '.repeat(100) + '◐ medium · /effort');
  const tmux = "  tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf and reattach for focus t… · ◎ /goal active (2s)";
  const cut = tmux.indexOf(' · ◎');
  assert.equal(rows(tmux), ' '.repeat(tmux.length - cut) + tmux.slice(0, cut), 'the notices move right by the indicator\'s width');
  assert.match(rows(tmux), /^ {20,}tmux focus-events off .*focus t…$/u);
  assert.equal(rows(' '.repeat(73) + 'Goal cleared: Stay active until cleared ccm:g'), '');
  // Only right on top of a rule.
  assert.equal(withoutGoalIndicator([' '.repeat(101) + '◎ /goal active (2s)', 'text'])[0], ' '.repeat(101) + '◎ /goal active (2s)');
});

test('every parser of the input box reads a screen with the goal as without it (nine versions)', () => {
  for (const version of versions) {
    const active = screen(version, 'active'), deferred = screen(version, 'deferred'), notice = screen(version, 'notice');
    // Replying: the spinner right above the notice row is the turn's progress, the input box empty and running.
    const editor = turnComposer(active);
    assert.ok(editor?.empty && editor.running, `${version}: a running, empty input box`);
    assert.match(parseTurnProgress(active, editor)?.activity ?? '', /^[A-Z][a-z]+$/u, `${version}: progress`);
    assert.equal(classifySessionScreen(active).status, 'working', `${version}: working`);
    for (const [name, idle] of [['deferred', deferred], ['notice', notice]] as const) {
      assert.equal(classifySessionScreen(idle).status, 'idle', `${version} ${name}: idle`);
      assert.ok(isIdleEmptyComposer(idle), `${version} ${name}: an empty input box takes /model and /effort`);
      assert.equal(turnComposer(idle)?.running, false, `${version} ${name}: not running`);
      assert.equal(parseExecutionMode(idle)?.mode, 'auto', `${version} ${name}: the mode below the box`);
      // Neither the indicator nor its notices are history above the box (settings receipts read it).
      assert.ok(!priorComposerHistory(idle).some(line => /◎|ctrl\+o to see|tmux/u.test(line)), `${version} ${name}: history`);
    }
    // The effort label shares the row with the indicator up to 2.1.325 ("◐ medium · /effort · ◎ /goal active (2s)").
    if (/◐ medium · \/effort · ◎/u.test(deferred)) assert.deepEqual(observeEffortFooter(deferred), { value: 'medium', source: 'composer-footer' }, version);
  }
});

test("Claude Code's goal rows never become reply text: not met, achieved, could not / couldn't, notices", () => {
  for (const version of versions) {
    const failed = screen(version, 'failed');
    assert.match(failed, older(version) ? /✘ Goal could not be achieved/u : /✘ Goal couldn't be achieved/u, version);
    for (const [name, prompt] of [['failed', '/goal Impossible case ccm:g'], ['notice', '/goal Evaluator error case ccm:g'], ['active', '/goal Finish the two-step task ccm:g']] as const) {
      // 2.1.300 may draw a command's echo late: without that anchor the known answer aligns the preview.
      // Taken without colours: the reply's bullet is painted as Claude Code paints it (reply-rows.ts).
      const painted = paintBullets(screen(version, name), text => text.startsWith('Acknowledged the goal'));
      const preview = extractPreview(painted, prompt, 'Acknowledged the goal; step one done.').text;
      assert.ok(!/Goal (?:not yet met|achieved|could|still active|paused)|◎|Ran 1 stop hook|contradicts itself|Brewed|Baked|Sautéed|tmux/u.test(preview), `${version} ${name}: ${preview}`);
      // Without the command's echo (2.1.300 draws it late) the screen's last turn cannot be told apart.
      if (screen(version, name).includes('❯ ' + prompt)) assert.match(preview, /Acknowledged the goal; step one done\./u, `${version} ${name}`);
    }
  }
  for (const row of ['◯ Goal not yet met… continuing', '✔ Goal achieved (2s · 2 turns · 96 tokens)', "✘ Goal couldn't be achieved (0s · 1 turn · 48 tokens)",
    '✘ Goal could not be achieved (0s · 1 turn · 48 tokens)', '● Goal still active · the goal check could not complete · retrying in 1 min (1/3) · send a message to',
    '● Goal paused · goal checks kept finding it unmet this turn · send a message to continue', '● Goal check-in: background work still running', '● Ran 1 stop hook'])
    assert.ok(goalTranscriptRow.test(row), row);
  assert.ok(!goalTranscriptRow.test('● Goal: ship the release notes'), 'a reply about goals');
});

test('the evaluator at work: "running Stop hook" in the spinner (2.1.326, 2.1.331)', () => {
  for (const version of ['2.1.326', '2.1.331']) {
    const view = screen(version, 'evaluating');
    const progress = parseTurnProgress(view, turnComposer(view));
    assert.ok(progress?.detail && runningStopHook.test(progress.detail), `${version}: ${JSON.stringify(progress)}`);
    assert.equal(parseGoalIndicator(view)?.state, 'active');
  }
});

test('the bare /goal panel in all three layouts is a dialog only Esc closes', () => {
  for (const version of versions) for (const name of ['panel-active', 'panel-achieved', 'panel-none']) {
    const view = screen(version, name), where = `${version} ${name}`;
    const panel = parseGoalPanelLines(view.split('\n'));
    assert.equal(panel?.dismiss, Number(version.split('.')[2]) < 326 ? 'dismiss' : 'close', where);
    assert.equal(panel?.title, name === 'panel-active' ? 'Goal active' : name === 'panel-achieved' && Number(version.split('.')[2]) < 329 ? 'Goal achieved' : 'Goal', where);
    assert.ok(panel?.lines.every(line => !/Esc to/u.test(line)), where);
    // Claude Code reports "waiting, dialog open" for it: the generic card offers Esc only.
    const card = parsePermissionScreen(view, { generic: true });
    assert.equal(card?.kind, 'native-dialog', where);
    assert.equal(card?.escape, panel?.dismiss, where);
    assert.deepEqual(card?.options, [], where);
    assert.equal(parsePermissionScreen(view), undefined, `${where}: never without Claude Code's waiting record`);
    assert.ok(permissionGuardLines(view + '\n', card!, { generic: true }), `${where}: Esc is bound to the panel, not the whole screen`);
  }
});

test('/goal clear during a reply: typed into the empty running box and entered at once, never queued (2.1.331)', async () => {
  const frames = { start: screen('2.1.331', 'active'), pasted: screen('2.1.331', 'busy-pasted'), done: screen('2.1.331', 'busy-cleared') };
  assert.equal(turnComposer(frames.pasted)?.text, '/goal clear');
  assert.equal(parseGoalIndicator(frames.done), undefined, 'the busy clear notice replaces the indicator');
  assert.ok(turnComposer(frames.done)?.empty && turnComposer(frames.done)?.running, 'the reply goes on');
  let view = frames.start;
  const keys: string[] = [];
  const driver: TurnDriver = {
    frame: async () => ({ paneId: '%9', panePid: 21, viewport: view, nativeStatus: 'busy' }),
    pasteForTurn: async (text, footerOnly) => { keys.push(`paste ${text} ${footerOnly}`); view = frames.pasted; },
    keyForTurn: async (key, footerOnly) => { keys.push(`${key} ${footerOnly}`); view = frames.done; },
  };
  await performTurnAction(driver, '%9', 21, { kind: 'command', text: '/goal clear' });
  assert.deepEqual(keys, ['paste /goal clear true', 'submit true']);
  // Only /goal goes this way, on one line; a draft in the box or no reply refuses before any key.
  keys.length = 0; view = frames.start;
  await assert.rejects(performTurnAction(driver, '%9', 21, { kind: 'command', text: '/compact' }));
  await assert.rejects(performTurnAction(driver, '%9', 21, { kind: 'command', text: '/goal a\nb' }));
  view = frames.pasted;
  await assert.rejects(performTurnAction(driver, '%9', 21, { kind: 'command', text: '/goal clear' }));
  assert.deepEqual(keys, []);
});
