import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performTurnAction, type TurnDriver } from '../src/backend/native-turn-controls';
import { keysNotSent, TranscriptChangedNoKeys } from '../src/backend/native-settings';
import { readRewind } from '../src/core/turn-controls';
import { t } from '../src/shared/i18n';

// Frames captured (capture-pane -e) from Claude Code 2.1.329 while Lectern opened
// /rewind on a forked session. The fork's Ctrl+U shows "ctrl+y to paste deleted
// text" above the input box for 5 s; idle-effort is the same screen once that hint
// has given way to the effort label again (the CI failure: it expired between the
// read and the paste of /rewind, and the paste had no retry).
const frame = (name: string) => readFileSync(new URL(`./fixtures/rewind-2.1.329/${name}.ansi`, import.meta.url), 'utf8');
const idleHint = frame('idle-hint'), idleEffort = frame('idle-effort'), typed = frame('rewind-typed');
const menu = frame('rewind-menu'), menuUp = frame('rewind-menu-up');
// Someone typed into the input box: a real change.
const draft = idleHint.replace('❯ \x1b[7m \x1b[0m', '❯ hello\x1b[7m \x1b[0m');
// The same menu written again with a shorter blank run: bytes differ, the menu does not.
const menuRepainted = menu.replace(/( {4}Prompt 14) +/, '$1');
type Step = 'paste /rewind' | 'submit' | 'up';
const next: Record<Step, Map<string, string>> = {
  'paste /rewind': new Map([[idleHint, typed], [idleEffort, typed]]),
  'submit': new Map([[typed, menu]]),
  'up': new Map([[menu, menuUp], [menuRepainted, menuUp]]),
};

/** Like the target's dispatch guard: refuse before sending when the screen is no
 * longer the frame the input was chosen from, and let a test change it in between. */
function pane(start: string, between: Partial<Record<Step, (() => string | Error)[]>> = {}, refusal?: () => Error) {
  let screen = start, observed: string | undefined;
  const attempts: Step[] = [], sent: Step[] = [];
  const dispatch = async (step: Step) => {
    attempts.push(step);
    const change = between[step]?.shift()?.();
    if (change instanceof Error) throw change;
    if (change !== undefined) screen = change;
    if (screen !== observed) throw refusal?.() ?? new Error(t('native.screenChangedNoKeys'));
    sent.push(step);
    screen = next[step].get(screen) ?? assert.fail(`no recorded screen after ${step}`);
  };
  const driver: TurnDriver = {
    frame: async () => { observed = screen; return { viewport: screen, paneId: '%1', panePid: 7, nativeStatus: 'idle' }; },
    pasteForTurn: async text => dispatch(`paste ${text}` as Step),
    keyForTurn: async key => dispatch(key as Step),
  };
  return { driver, attempts, sent };
}

test('2.1.329 rewind frames: the expiring hint changes the frame, not the idle input box or the menu', () => {
  assert.notEqual(idleEffort, idleHint);
  assert.ok(idleHint.includes('ctrl+y to paste deleted text') && idleEffort.includes('◉ xhigh · /effort'));
  assert.equal(readRewind(menu)?.stage, 'checkpoint');
  assert.notEqual(menuRepainted, menu);
  assert.equal(readRewind(menuRepainted)?.signature, readRewind(menu)?.signature);
  assert.notEqual(readRewind(menuUp)?.signature, readRewind(menu)?.signature);
});

test('rewind: the hint expiring between the read and the paste repeats only the paste, on the new frame', async () => {
  const { driver, attempts, sent } = pane(idleHint, { 'paste /rewind': [() => idleEffort] });
  await performTurnAction(driver, '%1', 7, { kind: 'openRewind' });
  assert.deepEqual(attempts, ['paste /rewind', 'paste /rewind', 'submit']);
  assert.deepEqual(sent, ['paste /rewind', 'submit']);
});

test('rewind: a draft typed between the read and the paste still sends nothing', async () => {
  const { driver, sent } = pane(idleHint, { 'paste /rewind': [() => draft] });
  await assert.rejects(performTurnAction(driver, '%1', 7, { kind: 'openRewind' }), error => keysNotSent(error));
  assert.deepEqual(sent, []);
});

test('rewind menu: a repaint of the same menu repeats the key; a moved focus does not', async () => {
  const signature = readRewind(menu)!.signature;
  const benign = pane(menu, { up: [() => menuRepainted] });
  await performTurnAction(benign.driver, '%1', 7, { kind: 'previous', signature });
  assert.deepEqual(benign.attempts, ['up', 'up']);
  assert.deepEqual(benign.sent, ['up']);
  const moved = pane(menu, { up: [() => menuUp] });
  await assert.rejects(performTurnAction(moved.driver, '%1', 7, { kind: 'previous', signature }), error => keysNotSent(error));
  assert.deepEqual(moved.sent, []);
});

test('rewind menu: a PID record rewritten as the menu opens repeats the key on the same menu', async () => {
  // Claude Code writes status "waiting" (waitingFor "dialog open") in the same tick it
  // paints the menu. A read can take the record before and the frame after; the input
  // guard then refuses on the record before sending anything.
  const presence = () => new Error(t('native.presenceChangedNoKeys'));
  assert.ok(keysNotSent(presence()));
  const { driver, attempts, sent } = pane(menu, { up: [presence] });
  await performTurnAction(driver, '%1', 7, { kind: 'previous', signature: readRewind(menu)!.signature });
  assert.deepEqual(attempts, ['up', 'up']);
  assert.deepEqual(sent, ['up']);
});

test('rewind: a changed transcript record is never retried', async () => {
  const { driver, attempts } = pane(idleHint, { 'paste /rewind': [() => idleEffort] }, () => new TranscriptChangedNoKeys());
  await assert.rejects(performTurnAction(driver, '%1', 7, { kind: 'openRewind' }), error => error instanceof TranscriptChangedNoKeys);
  assert.deepEqual(attempts, ['paste /rewind']);
});
