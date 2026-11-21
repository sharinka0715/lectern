import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../src/shared/types';
import { outgoingDelivered, showsOutgoing, startOutgoing, withOutgoing } from '../src/renderer/outgoing-message';

const user = (id: string, text: string, source: ChatMessage['source'] = 'jsonl'): ChatMessage => ({ id, role: 'user', text, tools: [], source, status: 'complete' });
const reply = (id: string, text: string): ChatMessage => ({ id, role: 'assistant', text, tools: [], source: 'jsonl', status: 'complete' });
const history = [user('S:turn:0:user', '你好'), reply('S:turn:0:assistant', '你好！')];

test('a sent message shows at once and is replaced by the controller bubble', () => {
  const outgoing = startOutgoing('w:S', '再来一次', history, 'outgoing:1');
  const shown = withOutgoing(history, 'w:S', outgoing)!;
  assert.deepEqual(shown.slice(0, 2), history);
  assert.deepEqual(shown.at(-1), { id: 'outgoing:1', role: 'user', text: '再来一次', tools: [], source: 'pending', status: 'complete' });
  // The controller's optimistic bubble (a new turn) takes over, even with whitespace differences.
  const optimistic = [...history, user('S:turn:1:user', '再来一次\n', 'pending')];
  assert.equal(outgoingDelivered(optimistic, outgoing), true);
  assert.equal(withOutgoing(optimistic, 'w:S', outgoing), optimistic, 'no duplicate bubble');
  const saved = [...history, user('S:turn:1:user', '再来一次'), reply('S:turn:1:assistant', '好')];
  assert.equal(withOutgoing(saved, 'w:S', outgoing), saved);
});

test('the same text sent earlier does not count as delivered', () => {
  const earlier = [...history, user('S:turn:1:user', '继续'), reply('S:turn:1:assistant', '好')];
  const outgoing = startOutgoing('w:S', '继续', earlier, 'outgoing:2');
  assert.equal(outgoingDelivered(earlier, outgoing), false);
  assert.equal(withOutgoing(earlier, 'w:S', outgoing)!.at(-1)!.id, 'outgoing:2');
});

test('another session never shows it, and commands never get a bubble', () => {
  const outgoing = startOutgoing('w:S', '问题', history, 'outgoing:3');
  assert.equal(withOutgoing(history, 'w:other', outgoing), history);
  assert.equal(withOutgoing(undefined, 'w:S', outgoing), undefined);
  assert.equal(withOutgoing(history, 'w:S', undefined), history);
  for (const text of ['/compact', '  /rename x', '', '   ']) assert.equal(showsOutgoing(text), false, JSON.stringify(text));
  for (const text of ['hello', '看看 /tmp 下的文件', '!ls']) assert.equal(showsOutgoing(text), true, text);
});
