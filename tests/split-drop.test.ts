import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDesktopState, planChatDrop, shownIn, type ChatTarget } from '../src/renderer/desktop-state';

const chat = (id: string): ChatTarget => ({ workspaceId: 'w', sessionId: id, title: id });
const [a, b, c] = [chat('a'), chat('b'), chat('c')];
const single = { split: false, active: 'primary' as const, panes: { primary: a, secondary: b } };
const pair = { split: true, active: 'secondary' as const, panes: { primary: a, secondary: b } };

test('one conversation on screen: only another conversation splits the screen', () => {
  for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
    assert.deepEqual(planChatDrop(single, { ...a, title: 'renamed' }, edge), { kind: 'none' }, edge);
    assert.deepEqual(planChatDrop(single, b, edge), { kind: 'split' }, 'a stale secondary pane does not count');
  }
  assert.deepEqual(planChatDrop(single, null, 'right'), { kind: 'split' }, 'a drag from elsewhere is decided at the drop');
});

test('two conversations: one of them on the other side merges back to it alone; a third replaces that side', () => {
  for (const [first, second] of [['left', 'right'], ['top', 'bottom']] as const) {
    assert.deepEqual(planChatDrop(pair, a, first), { kind: 'none' }, 'its own side');
    assert.deepEqual(planChatDrop(pair, b, second), { kind: 'none' }, 'its own side');
    assert.deepEqual(planChatDrop(pair, a, second), { kind: 'merge', keep: 'primary' });
    assert.deepEqual(planChatDrop(pair, b, first), { kind: 'merge', keep: 'secondary' });
    assert.deepEqual(planChatDrop(pair, c, first), { kind: 'replace', view: 'primary' });
    assert.deepEqual(planChatDrop(pair, c, second), { kind: 'replace', view: 'secondary' });
  }
});

test('the pane already showing a conversation', () => {
  assert.equal(shownIn(pair, b), 'secondary');
  assert.equal(shownIn(pair, a), 'primary');
  assert.equal(shownIn(pair, c), undefined);
  assert.equal(shownIn(single, b), undefined, 'the hidden secondary pane is not on screen');
  assert.equal(shownIn({ split: true, panes: { primary: { workspaceId: 'w', sessionId: '', title: '', draft: true }, secondary: null } }, c), undefined);
});

test('a saved split layout restores both conversations and the active pane', () => {
  const read = (value: unknown) => loadDesktopState({ getItem: () => JSON.stringify(value) });
  const two = read({ split: true, active: 'secondary', panes: { primary: a, secondary: b } });
  assert.deepEqual([two.split, two.active, two.panes.secondary?.sessionId], [true, 'secondary', 'b']);
});
