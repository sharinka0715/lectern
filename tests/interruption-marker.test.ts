import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageDisplay } from '../src/core/message-display';

// Claude Code 2.1.328 writes these user records itself after Esc or a refused
// tool permission; the TUI shows "Interrupted", never a prompt.
const row = (data: object) => JSON.stringify({ sessionId: 'S', ...data }) + '\n';
const prompt = (uuid: string, parent: string | null, text: string, typed = true) => row({ type: 'user', uuid, parentUuid: parent,
  ...(typed && { promptSource: 'typed', origin: { kind: 'human' } }), message: { role: 'user', content: text } });
const marker = (uuid: string, parent: string, text: string) => row({ type: 'user', uuid, parentUuid: parent, promptId: 'p', message: { role: 'user', content: [{ type: 'text', text }] } });
const call = (uuid: string, parent: string, id: string) => row({ type: 'assistant', uuid, parentUuid: parent,
  message: { id: `m-${uuid}`, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: '/w/new.md', content: '# New' } }] } });
const rejected = (uuid: string, parent: string, id: string) => row({ type: 'user', uuid, parentUuid: parent, toolUseResult: 'User rejected tool use',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: "The user doesn't want to proceed with this tool use." }] } });

test('a refused tool ends the turn as interrupted, without a fake user message', () => {
  const display = new MessageDisplay('S');
  display.ingestJsonl(prompt('u1', null, '写个文件') + call('a1', 'u1', 't1') + rejected('r1', 'a1', 't1')
    + marker('i1', 'r1', '[Request interrupted by user for tool use]') + prompt('u2', 'i1', '换成大写'));
  const messages = display.getMessages();
  assert.deepEqual(messages.filter(m => m.role === 'user').map(m => m.text), ['写个文件', '换成大写']);
  const reply = messages.find(m => m.role === 'assistant')!;
  assert.equal(reply.interrupted, true);
  assert.equal(reply.status, 'complete');
  assert.equal(reply.tools[0].isError, true);
});

test('Esc during a reply marks it interrupted; a typed look-alike stays a prompt', () => {
  const display = new MessageDisplay('S');
  display.ingestJsonl(prompt('u1', null, '讲个故事')
    + row({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { id: 'm1', role: 'assistant', stop_reason: null, content: [{ type: 'text', text: '从前' }] } })
    + marker('i1', 'a1', '[Request interrupted by user]')
    + prompt('u2', 'i1', '[Request interrupted by user]'));
  const messages = display.getMessages();
  assert.equal(messages.find(m => m.role === 'assistant')!.interrupted, true);
  assert.deepEqual(messages.filter(m => m.role === 'user').map(m => m.text), ['讲个故事', '[Request interrupted by user]'], 'what the user typed is shown');
  assert.equal(messages.filter(m => m.interrupted).length, 1);
});
