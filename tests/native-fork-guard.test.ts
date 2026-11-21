import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { forkCapability, submitNativeFork } from '../src/backend/native-fork';
import type { TurnDriver } from '../src/backend/native-turn-controls';
import { keysNotSent, NavigationKeyNotSent } from '../src/backend/native-settings';
import { isIdleEmptyComposer } from '../src/core/settings-screen';
import { t } from '../src/shared/i18n';

// Frames captured (capture-pane -e) from Claude Code 2.1.329 while Lectern forked a
// resumed session. About 0.8 s after the session first enters auto mode, Claude
// Code appends its one-time "Auto mode lets Claude handle permission prompts …"
// description to the transcript; the *-notice frames are the same screens after it.
const frame = (name: string) => readFileSync(new URL(`./fixtures/fork-2.1.329/${name}.ansi`, import.meta.url), 'utf8');
const idle = frame('idle'), forkMenu = frame('fork-menu'), erased = frame('erased'), erasedNotice = frame('erased-notice');
const branchMenu = frame('branch-menu'), branchMenuNotice = frame('branch-menu-notice');
// Someone typed into the input box: a real change that must never be overridden.
const draft = erased.replace('❯ \x1b[7m \x1b[0m', '❯ hello\x1b[7m \x1b[0m');
type Step = 'paste /fork' | 'erase' | 'paste /branch' | 'switchSession';
const next: Record<Step, Map<string, string>> = {
  'paste /fork': new Map([[idle, forkMenu]]),
  'erase': new Map([[forkMenu, erased]]),
  'paste /branch': new Map([[erased, branchMenu], [erasedNotice, branchMenuNotice]]),
  'switchSession': new Map([[branchMenu, 'branched'], [branchMenuNotice, 'branched']]),
};

/** The real dispatch guard hashes the whole frame the key was chosen from and
 * compares it with a fresh capture on the target, before send-keys. This pane
 * refuses the same way, and lets a test change the screen right in between. */
function pane(between: Partial<Record<Step, (() => string)[]>> = {}, fail?: Partial<Record<Step, Error>>) {
  let screen = idle, observed: string | undefined;
  const attempts: Step[] = [], sent: Step[] = [];
  const dispatch = async (step: Step) => {
    attempts.push(step);
    const change = between[step]?.shift();
    if (change) screen = change();
    if (screen !== observed) throw step === 'switchSession' ? new NavigationKeyNotSent() : new Error(t('native.screenChangedNoKeys'));
    if (fail?.[step]) throw fail[step];
    sent.push(step);
    const after = next[step].get(screen);
    assert.ok(after, `no recorded screen after ${step}`);
    screen = after;
  };
  const driver: TurnDriver = {
    frame: async () => { observed = screen; return { viewport: screen, paneId: '%1', panePid: 7, nativeStatus: 'idle' }; },
    pasteForTurn: async text => dispatch(`paste ${text}` as Step),
    keyForTurn: async key => dispatch(key as Step),
  };
  return { driver, attempts, sent };
}

test('2.1.329 fork frames: the auto mode notice changes the frame but not what each step needs', () => {
  assert.notEqual(erasedNotice, erased);
  assert.ok(isIdleEmptyComposer(idle) && isIdleEmptyComposer(erased) && isIdleEmptyComposer(erasedNotice));
  assert.ok(!isIdleEmptyComposer(draft));
  assert.equal(forkCapability(forkMenu, '/fork'), 'background');
  assert.equal(forkCapability(branchMenu, '/branch'), 'branch');
  assert.equal(forkCapability(branchMenuNotice, '/branch'), 'branch');
});

test('fork: a notice appended between the read and the paste repeats only the refused paste, on the new frame', async () => {
  const { driver, attempts, sent } = pane({ 'paste /branch': [() => erasedNotice] });
  await submitNativeFork(driver, '%1', 7);
  assert.deepEqual(attempts, ['paste /fork', 'erase', 'paste /branch', 'paste /branch', 'switchSession']);
  assert.deepEqual(sent, ['paste /fork', 'erase', 'paste /branch', 'switchSession']);
});

test('fork: a notice appended just before Enter re-reads the /branch completion and presses Enter once', async () => {
  const { driver, attempts, sent } = pane({ switchSession: [() => branchMenuNotice] });
  await submitNativeFork(driver, '%1', 7);
  assert.deepEqual(attempts.filter(step => step === 'switchSession'), ['switchSession', 'switchSession']);
  assert.deepEqual(sent, ['paste /fork', 'erase', 'paste /branch', 'switchSession']);
});

test('fork: a real change between the read and the paste still sends nothing', async () => {
  const { driver, sent } = pane({ 'paste /branch': [() => draft] });
  await assert.rejects(submitNativeFork(driver, '%1', 7), error => keysNotSent(error));
  assert.deepEqual(sent, ['paste /fork', 'erase']);
});

test('fork: when /branch is no longer typed, a refused Enter stays a refusal so its journal is dropped', async () => {
  const { driver, sent } = pane({ switchSession: [() => erasedNotice] });
  await assert.rejects(submitNativeFork(driver, '%1', 7), error => error instanceof NavigationKeyNotSent);
  assert.deepEqual(sent, ['paste /fork', 'erase', 'paste /branch']);
});

test('fork: a frame that keeps changing is tried at most three times', async () => {
  const { driver, attempts, sent } = pane({ 'paste /branch': [() => erasedNotice, () => erased, () => erasedNotice] });
  await assert.rejects(submitNativeFork(driver, '%1', 7), error => keysNotSent(error));
  assert.equal(attempts.filter(step => step === 'paste /branch').length, 3);
  assert.deepEqual(sent, ['paste /fork', 'erase']);
});

test('fork: an ambiguous failure after the guard passed is never retried', async () => {
  const lost = new Error('lost branch acknowledgement');
  const { driver, attempts } = pane({}, { switchSession: lost });
  await assert.rejects(submitNativeFork(driver, '%1', 7), error => error === lost);
  assert.deepEqual(attempts, ['paste /fork', 'erase', 'paste /branch', 'switchSession']);
});
