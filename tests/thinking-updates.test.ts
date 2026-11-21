import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageDisplay } from '../src/core/message-display';
import { thinkingPurpose } from '../src/core/thinking';

// Shape of Claude Code 2.1.327–2.1.329 records: each content block is its own
// assistant record sharing message.id. The signature (a base64 protobuf) says
// what a thinking block is for: field 2 → 1 → 8 = "narration" is a progress
// note shown as reply text; any other non-empty thinking is folded by the TUI
// into "Thought for Ns".
function bytes(number: number, value: Uint8Array): number[] {
  const out: number[] = [];
  for (let n of [number * 8 + 2, value.length]) {
    while (n > 127) { out.push((n % 128) | 128); n = Math.floor(n / 128); }
    out.push(n);
  }
  return [...out, ...value];
}
const signature = (purpose: string) => Buffer.from([0x08, 0x01, ...bytes(2, Uint8Array.from(bytes(1, Uint8Array.from([...bytes(3, Buffer.from('x')), ...bytes(8, Buffer.from(purpose))]))))]).toString('base64');
const narration = signature('narration'), thinking = signature('thinking');
const row = (data: object) => JSON.stringify({ sessionId: 'S', ...data }) + '\n';
const assistant = (uuid: string, parent: string, id: string, block: object, extra: object = {}) =>
  row({ type: 'assistant', uuid, parentUuid: parent, ...extra, message: { id, role: 'assistant', stop_reason: null, content: [block] } });

test('the signature names what a thinking block is for', () => {
  assert.equal(thinkingPurpose(narration), 'narration');
  assert.equal(thinkingPurpose(thinking), 'thinking');
  for (const value of ['sig', '', undefined, 42, '%%%', Buffer.from([0x12, 0x40]).toString('base64')]) assert.equal(thinkingPurpose(value), undefined, String(value));
});

test('narration appears in the reply; other reasoning is a folded thought in its place', () => {
  const display = new MessageDisplay('S');
  display.ingestJsonl(
    row({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'fix the trust dialog' } })
    + assistant('a1', 'u1', 'msg_1', { type: 'thinking', thinking: '', signature: thinking }, { thinkingDisplay: 'updates' })
    + assistant('a2', 'a1', 'msg_1', { type: 'thinking', thinking: '先复现根目录的情况。\n\n', signature: narration }, { thinkingDisplay: 'updates' })
    + assistant('a3', 'a2', 'msg_1', { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }, { thinkingDisplay: 'updates' })
    + row({ type: 'user', uuid: 'r1', parentUuid: 'a3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a b' }] } })
    + assistant('a4', 'r1', 'msg_2', { type: 'thinking', thinking: 'Weighing the two fixes before editing.', signature: thinking }, { thinkingDisplay: 'updates', thinkingDurationMs: 12_400 })
    + assistant('a5', 'a4', 'msg_2', { type: 'thinking', thinking: 'An older record without a readable signature.', signature: 'sig' })
    + assistant('a6', 'a5', 'msg_2', { type: 'text', text: '已修复。' }, { thinkingDisplay: 'updates' }));
  const reply = display.getMessages().find(message => message.role === 'assistant')!;
  assert.match(reply.text, /先复现根目录的情况。/);
  assert.match(reply.text, /已修复。/);
  assert.doesNotMatch(reply.text, /Weighing|older record/, 'folded reasoning is not reply text');
  const tool = reply.tools.find(item => item.id === 'toolu_1')!;
  assert.equal(tool.textOffset, reply.text.indexOf('先复现') + '先复现根目录的情况。'.length, 'the note precedes its tool call');
  const thoughts = reply.tools.filter(item => item.thought);
  assert.deepEqual(thoughts.map(item => [item.result, item.thought, item.textOffset]), [
    ['Weighing the two fixes before editing.', { durationMs: 12_400 }, tool.textOffset],
    ['An older record without a readable signature.', {}, tool.textOffset],
  ], 'after the tool and before the final text, in record order');
  assert.ok(reply.tools.indexOf(tool) < reply.tools.indexOf(thoughts[0]));
  assert.ok(thoughts.every(item => item.result !== undefined && !item.isError), 'never a pending tool (permission and question cards look for those)');
});
