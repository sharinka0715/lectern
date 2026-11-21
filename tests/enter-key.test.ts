import assert from 'node:assert/strict';
import test from 'node:test';
import { imeOwnsKey, isEnterKey } from '../src/renderer/enter-key';

test('the keypad Enter submits like the main Return key', () => {
  assert.ok(isEnterKey({ key: 'Enter', code: 'Enter' }));
  assert.ok(isEnterKey({ key: 'Enter', code: 'NumpadEnter' }));
  // Reported by an input method that kept the keystroke.
  assert.ok(isEnterKey({ key: 'Process', code: 'NumpadEnter' }));
  assert.ok(!isEnterKey({ key: 'Tab', code: 'Tab' }));
  assert.ok(!isEnterKey({ key: 'Process', code: 'KeyA' }));
});

test('only a composition in progress keeps Enter from submitting', () => {
  assert.ok(!imeOwnsKey({ key: 'Enter', code: 'Enter', keyCode: 13 }));
  assert.ok(!imeOwnsKey({ key: 'Enter', code: 'NumpadEnter', keyCode: 13 }));
  // Nothing is being composed: a keypad Enter marked 229 is still Enter.
  assert.ok(!imeOwnsKey({ key: 'Process', code: 'NumpadEnter', keyCode: 229 }));
  // Choosing or committing a candidate.
  assert.ok(imeOwnsKey({ key: 'Process', code: 'NumpadEnter', keyCode: 229, isComposing: true }));
  assert.ok(imeOwnsKey({ key: 'Enter', code: 'NumpadEnter', keyCode: 13 }, true));
  assert.ok(imeOwnsKey({ key: 'Process', code: 'Enter', keyCode: 229 }));
});
