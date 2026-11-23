import assert from 'node:assert/strict';
import test from 'node:test';
import { composerLock, focusReturnStep, noteFocus, type FocusMemory } from '../src/renderer/composer-focus';

test('a box that cannot send is disabled, unless the user is in it: then it holds, typing on', () => {
  for (const focused of [false, true])
    assert.deepEqual(composerLock({ canType: true, focused }), { disabled: false, holding: false });
  assert.deepEqual(composerLock({ canType: false, focused: false }), { disabled: true, holding: false });
  assert.deepEqual(composerLock({ canType: false, focused: true }), { disabled: false, holding: true },
    'never disabled or read-only under the user: the focus, the caret and an IME composition stay');
});

const start: FocusMemory = { away: false };
const drop = (memory: FocusMemory, from: 'input' | 'area' | 'other', scope = 'chat') =>
  noteFocus(memory, { kind: 'dropped', from, scope, selection: from === 'input' ? [1, 3, 'backward'] : undefined, text: from === 'input' ? 'draft' : undefined });

test('a focus dropped from the input area to nowhere waits for the box, with its selection', () => {
  const memory = drop(start, 'input');
  assert.deepEqual(memory.pending, { scope: 'chat', selection: [1, 3, 'backward'], text: 'draft' });
  assert.equal(focusReturnStep(memory, { scope: 'chat', typeable: false, active: 'none' }), 'wait');
  assert.equal(focusReturnStep(memory, { scope: 'chat', typeable: true, active: 'none' }), 'focus');
  // A card's button, a menu option or the send button: the box gets the focus, its own caret kept.
  assert.deepEqual(drop(start, 'area').pending, { scope: 'chat', selection: undefined, text: undefined });
  assert.equal(drop(start, 'other').pending, undefined, 'focus lost elsewhere is none of the box\'s business');
});

test('a click or a focus elsewhere is the user\'s choice: nothing comes back', () => {
  const pending = drop(start, 'input');
  assert.equal(noteFocus(pending, { kind: 'pointerdown', place: 'other' }).pending, undefined);
  assert.equal(noteFocus(pending, { kind: 'focusin' }).pending, undefined);
  // The click that drops the focus comes first.
  const away = noteFocus(start, { kind: 'pointerdown', place: 'other' });
  assert.equal(drop(away, 'input').pending, undefined);
  assert.equal(noteFocus(away, { kind: 'request', scope: 'chat' }).pending, undefined, 'a send finishing later does not call the user back');
  // A click inside the area (a card's option, the box's padding) keeps a pending return.
  assert.deepEqual(noteFocus(pending, { kind: 'pointerdown', place: 'area' }), pending);
  assert.equal(drop(noteFocus(away, { kind: 'pointerdown', place: 'area' }), 'input').pending?.scope, 'chat');
  assert.equal(drop(noteFocus(away, { kind: 'focusin' }), 'area').pending?.scope, 'chat');
});

test('a return is dropped once the focus is anywhere again, or another chat is shown', () => {
  const pending = drop(start, 'input');
  for (const active of ['input', 'area', 'other'] as const)
    assert.equal(focusReturnStep(pending, { scope: 'chat', typeable: true, active }), 'drop', active);
  assert.equal(focusReturnStep(pending, { scope: 'other chat', typeable: true, active: 'none' }), 'drop');
  assert.equal(focusReturnStep(start, { scope: 'chat', typeable: true, active: 'none' }), undefined);
});

test('a request keeps the selection of a return already pending for the same chat', () => {
  const pending = drop(start, 'input');
  assert.deepEqual(noteFocus(pending, { kind: 'request', scope: 'chat' }), pending);
  assert.deepEqual(noteFocus(pending, { kind: 'request', scope: 'next' }).pending, { scope: 'next' });
  assert.deepEqual(noteFocus(start, { kind: 'request', scope: 'chat' }).pending, { scope: 'chat' });
});
