import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composerFrameGuard, guardWindow } from '../src/backend/composer-frame-guard';
import { NavigationKeyNotSent } from '../src/backend/native-settings';
import { sendGuarded } from '../src/backend/native-turn-controls';
import { classifySessionScreen, stripTerminalEscapes } from '../src/core/screen';
import { isIdleEmptyComposer } from '../src/core/settings-screen';
import { turnComposer } from '../src/core/turn-controls';

const frames: Record<string, string> = JSON.parse(readFileSync(new URL('./fixtures/composer-placeholder/frames.json', import.meta.url), 'utf8'));
const suggestion = 'Show another example using the same fixture';

test('native suggestions are empty composers across releases and themes', () => {
  for (const name of ['2.1.300-suggestion', '2.1.321-suggestion', '2.1.331-suggestion', '2.1.331-light', '2.1.331-dark-ansi']) {
    const frame = frames[name], plain = stripTerminalEscapes(frame);
    assert.equal(turnComposer(frame)?.suggestion, suggestion, name);
    assert.equal(turnComposer(plain, frame)?.empty, true, name);
    assert.equal(isIdleEmptyComposer(plain, frame), true, name);
    assert.equal(turnComposer(plain)?.empty, false, name);
  }
});

test('native welcome, error and queue hints never become suggestions', () => {
  for (const name of ['2.1.300-try', '2.1.331-try', '2.1.331-stream-error', '2.1.331-stream-reset', '2.1.331-model-error',
    '2.1.331-oversized-request', '2.1.300-queued', '2.1.321-queued', '2.1.331-queued', '2.1.331-narrow-error']) {
    const frame = frames[name];
    assert.equal(turnComposer(frame)?.empty, true, name);
    assert.equal(turnComposer(frame)?.suggestion, undefined, name);
    assert.equal(isIdleEmptyComposer(frame), !name.endsWith('-queued'), name);
  }
  for (const name of ['2.1.331-stream-error', '2.1.331-model-error', '2.1.331-oversized-request', '2.1.331-narrow-error'])
    assert.equal(classifySessionScreen(frames[name]).status, 'error', name);
  for (const name of ['2.1.300-stream-reset', '2.1.321-stream-reset', '2.1.300-model-error', '2.1.321-model-error'])
    assert.equal(turnComposer(frames[name])?.text, '', name);
});

test('style mismatch and ordinary drafts with a reverse video cursor stay occupied', () => {
  const retry = frames['2.1.331-stream-error'], plain = stripTerminalEscapes(retry);
  assert.equal(turnComposer(plain, retry)?.empty, true);
  assert.equal(turnComposer(plain, retry.replace('message to try', 'message to TRY'))?.empty, false);
  assert.equal(turnComposer(plain.replace('Resend your message to try again', ''), retry)?.empty, false);
  assert.equal(isIdleEmptyComposer(plain, retry.replace('message to try', 'message to TRY')), false);
  for (const name of ['2.1.331-typed-same-text', '2.1.331-narrow-draft', '2.1.331-no-color-draft']) {
    assert.equal(turnComposer(frames[name])?.empty, false, name);
    assert.equal(isIdleEmptyComposer(frames[name]), false, name);
  }
  const cursorAtStart = retry.replaceAll('\x1b[0;2m', '\x1b[0m');
  assert.equal(turnComposer(cursorAtStart)?.empty, false, 'Plain text after a reverse cursor in a styled frame is still a draft');
});

test('no-color captures fall back to fixed strings and never expose an arbitrary suggestion', () => {
  for (const input of [frames['2.1.331-no-color-error'], stripTerminalEscapes(frames['2.1.331-stream-error'])]) {
    assert.equal(turnComposer(input)?.empty, true);
    assert.equal(turnComposer(input)?.suggestion, undefined);
    assert.equal(isIdleEmptyComposer(input), true);
  }
  assert.equal(turnComposer(frames['2.1.331-no-color-suggestion'])?.empty, false);
  assert.equal(turnComposer(frames['2.1.331-narrow-suggestion'])?.empty, true);
  assert.equal(turnComposer(frames['2.1.331-narrow-suggestion'])?.suggestion, undefined);
});

test('a wrapped placeholder needs matching styling on its continuation rows', () => {
  const frame = frames['2.1.331-suggestion'].replace('how another example using the same fixture', 'how another example\x1b[0m\n  \x1b[2musing the same fixture');
  assert.equal(turnComposer(frame)?.empty, true);
  assert.equal(turnComposer(frame)?.suggestion, undefined);
  assert.equal(turnComposer(frame.replace('  \x1b[2musing', '  using'))?.empty, false);
});

test('the frame guard rechecks a suggestion arriving or leaving before any input is sent', async () => {
  const suggested = frames['2.1.331-suggestion'];
  const empty = suggested.replace(/\x1b\[7mS.*fixture[^\n]*/u, '\x1b[7m \x1b[0m');
  const draft = suggested.replace(/\x1b\[7mS.*fixture[^\n]*/u, suggestion);
  const guarded = (frame: string) => guardWindow(frame, composerFrameGuard(frame)).expected;
  for (const [before, live, writes] of [[empty, suggested, 1], [suggested, empty, 1], [suggested, draft, 0]] as const) {
    let expected = guarded(before), dispatched = 0, checks = 0;
    const action = sendGuarded(async () => {
      if (guarded(live) !== expected) throw new NavigationKeyNotSent();
      dispatched++;
    }, async () => {
      checks++;
      if (!isIdleEmptyComposer(live)) throw new Error('New draft');
      expected = guarded(live);
    }, 2);
    if (writes) await action; else await assert.rejects(action, NavigationKeyNotSent);
    assert.equal(dispatched, writes);
    assert.equal(checks, 1);
  }
});
