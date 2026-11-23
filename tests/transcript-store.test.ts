import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { MessageDisplay } from '../src/core/message-display';
import type { JsonRecord } from '../src/core/jsonl';
import { pendingToolId } from '../src/main/session-permission';

const encode = (...rows: JsonRecord[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const user = (uuid: string, parentUuid: string | null, content = uuid) => ({ type: 'user', uuid, parentUuid, message: { content } });
const assistant = (uuid: string, parentUuid: string, input: number, stop_reason: string | null = 'end_turn', id = uuid, tool?: string) => ({
  type: 'assistant', uuid, parentUuid, message: { id, stop_reason,
    usage: { input_tokens: input, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    content: [{ type: 'text', text: uuid }, ...(tool ? [{ type: 'tool_use', name: 'Read', id: tool, input: { path: tool } }] : [])] },
});
const duration = (uuid: string, parentUuid: string) => ({ type: 'system', subtype: 'turn_duration', uuid, parentUuid });
const rewind = (leafUuid: string | null, cutUuid: string) => ({ type: 'last-prompt', explicit: true, rewound: true, leafUuid, cutUuid });
const result = (uuid: string, parentUuid: string, id: string) => ({ type: 'user', uuid, parentUuid, message: {
  content: [{ type: 'tool_result', tool_use_id: id, content: uuid }] } });
const texts = (display: MessageDisplay) => display.getMessages().map(message => message.text);
const screen = (prompt: string, response: string) =>
  `❯ ${prompt}\n⏺ ${response}\n✻ Thinking… (esc to interrupt)\n─────────────────\n❯ \n─────────────────\n`;

const fixture = JSON.parse(readFileSync(new URL('./fixtures/native-contracts/transcript-projections.json', import.meta.url), 'utf8')) as {
  cases: { name: string; sessionId: string; records: JsonRecord[]; expected: { role: string; text: string }[] }[];
};
for (const sample of fixture.cases) {
  test(sample.name + ' survives whole-file, split and repeated reads', () => {
    const reader = new MessageDisplay(sample.sessionId);
    for (const row of sample.records) {
      const bytes = Buffer.from(encode(row));
      reader.ingestJsonl(bytes.subarray(0, bytes.length - 1));
      reader.ingestJsonl(bytes.subarray(-1));
    }
    const messages = reader.getMessages();
    assert.deepEqual(messages.map(({ role, text }) => ({ role, text })), sample.expected);
    reader.ingestJsonl(encode(...sample.records));
    assert.deepEqual(reader.getMessages(), messages);
    reader.ingestJsonl(encode(...sample.records), true);
    assert.deepEqual(reader.getMessages(), messages);
  });
}

test('rewind followed by a new branch selects its own usage and tools across replay', () => {
  const rows = [user('first', null), assistant('a1', 'first', 10), user('discard', 'a1'), assistant('discard-a', 'discard', 20, 'end_turn', 'discard-id', 'toolX'),
    result('discard-result', 'discard-a', 'toolX'), rewind('a1', 'discard'), user('new', 'a1'), assistant('new-a', 'new', 30),
    { ...duration('stale-duration', 'discard-a'), pendingWorkflowCount: 2 }];
  const display = new MessageDisplay('s');
  for (const row of rows) display.ingestJsonl(encode(row));
  assert.deepEqual(texts(display), ['first', 'a1', 'new', 'new-a']);
  assert.equal(display.contextUsage?.totalInputTokens, 30);
  const firstPass = display.getMessages();
  display.ingestJsonl(encode(...rows));
  assert.deepEqual(display.getMessages(), firstPass);
  display.ingestJsonl(encode(rewind(null, 'first')));
  assert.deepEqual(texts(display), []);
  assert.equal(display.contextUsage, undefined);
  display.ingestJsonl(encode(user('again', null), assistant('again-a', 'again', 40)));
  assert.deepEqual(texts(display), ['again', 'again-a']);
});

test('a late sibling block, result and duration update their own turn while another streams', () => {
  const display = new MessageDisplay('s');
  const initial = [user('first', null), assistant('block1', 'first', 10, 'tool_use', 'r', 'one'), result('res1', 'block1', 'one'),
    user('second', 'res1'), assistant('active', 'second', 15, null)];
  const late = [assistant('block2', 'first', 10, 'tool_use', 'r', 'two'), result('res2', 'block2', 'two'),
    { ...duration('duration1', 'res2'), pendingBackgroundAgentCount: 2, pendingWorkflowCount: 1 }];
  display.ingestJsonl(encode(...initial));
  display.ingestScreen(screen('second', 'active plus preview'));
  const id = display.getMessages().at(-1)?.id;
  for (const row of late) display.ingestJsonl(encode(row));
  assert.deepEqual(texts(display), ['first', 'block1\n\nblock2', 'second', 'active plus preview']);
  assert.deepEqual(display.getMessages()[1].tools.map(tool => tool.result), ['res1', 'res2']);
  assert.equal(display.getMessages().at(-1)?.id, id);
  assert.equal(display.getMessages().at(-1)?.status, 'streaming');
  assert.equal(display.contextUsage?.totalInputTokens, 10);
  const first = display.diagnosticState.turns[0];
  assert.equal(first.backgroundAgents, 2);
  assert.equal(first.backgroundWorkflows, 1);
  display.ingestJsonl(encode(duration('duration2', 'active')));
  assert.equal(display.getMessages().at(-1)?.source, 'jsonl');
  assert.equal(display.contextUsage?.totalInputTokens, 15);
});

for (const form of ['list', 'segment']) {
  test(`compaction reconnects the preserved ${form}, excludes pruned requests and resets their usage`, () => {
    const preserve = form === 'list' ? { preservedMessages: { anchorUuid: 'summary', uuids: ['keep', 'kept'] } }
      : { preservedSegment: { anchorUuid: 'summary', headUuid: 'keep', tailUuid: 'kept' } };
    const rows = [user('old', null), assistant('dropped', 'old', 11), user('keep', 'dropped'), assistant('kept', 'keep', 22),
      { type: 'system', subtype: 'compact_boundary', uuid: 'boundary', parentUuid: null, logicalParentUuid: 'kept', compactMetadata: preserve },
      { ...user('summary', 'boundary'), isCompactSummary: true, isVisibleInTranscriptOnly: true }];
    for (const separate of [false, true]) {
      const display = new MessageDisplay('s');
      if (separate) for (const row of rows) display.ingestJsonl(encode(row));
      else display.ingestJsonl(encode(...rows));
      assert.deepEqual(texts(display), ['keep', 'kept']);
      assert.equal(display.contextUsage?.totalInputTokens, undefined);
      // Native continuations can name the anchor or an already pruned predecessor.
      display.ingestJsonl(encode(user('fresh', 'dropped'), assistant('fresh reply', 'fresh', 33)));
      assert.deepEqual(texts(display), ['keep', 'kept', 'fresh', 'fresh reply']);
      assert.equal(display.contextUsage?.totalInputTokens, 33);
    }
  });
}

test('hidden bridges, a missing parent supplied later and cyclic revisions stay bounded', () => {
  const display = new MessageDisplay('s');
  display.ingestJsonl(encode(assistant('reply', 'bridge', 10), { type: 'attachment', uuid: 'bridge', parentUuid: 'root' }, user('root', null)));
  assert.deepEqual(texts(display), ['root', 'reply']);
  display.ingestJsonl(encode(user('root', 'bridge')));
  assert.equal(new Set(display.getMessages().map(message => message.id)).size, display.getMessages().length);
  assert.ok(texts(display).includes('reply'));
});

test('local commands produce no turn unless there is an associated model continuation', () => {
  const display = new MessageDisplay('s');
  const wrapper = '<command-name>/plugin:query</command-name>\n<command-message>plugin:query</command-message>';
  display.ingestJsonl(encode(user('local', null, wrapper), user('err', 'local', '<local-command-stderr>Failed</local-command-stderr>'),
    user('ok', 'err', 'Hello'), assistant('hello', 'ok', 10)));
  assert.deepEqual(texts(display), ['Hello', 'hello']);
  display.ingestJsonl(encode(user('query', 'hello', wrapper), { type: 'system', subtype: 'local_command', uuid: 'output', parentUuid: 'query' },
    { ...user('expanded', 'output'), isMeta: true }, assistant('answer', 'expanded', 11)));
  assert.deepEqual(texts(display), ['Hello', 'hello', '/plugin:query', 'answer']);
});

test('a completed response keeps an aligned streamed continuation until a distinct UUID becomes durable', () => {
  const display = new MessageDisplay('s');
  display.ingestJsonl(encode(user('prompt', null)));
  display.ingestScreen(screen('prompt', 'First\n\nSecond response'));
  const id = display.getMessages()[1].id;
  display.ingestJsonl(encode(assistant('First', 'prompt', 7)));
  assert.equal(display.getMessages()[1].text, 'First\n\nSecond response');
  assert.equal(display.getMessages()[1].source, 'preview');
  display.ingestJsonl(encode(assistant('Second response', 'First', 11)));
  assert.equal(display.getMessages()[1].id, id);
  assert.equal(display.getMessages()[1].source, 'jsonl');
  assert.equal(display.contextUsage?.totalInputTokens, 11);
});

test('a late response on the cut branch cannot resurrect its messages or usage', () => {
  const display = new MessageDisplay('s');
  const rows = [user('1', null), assistant('answered', '1', 10), user('cut', 'answered'), rewind('answered', 'cut'),
    user('new', 'answered'), assistant('active', 'new', 30), assistant('late', 'cut', 1000)];
  for (const row of rows) display.ingestJsonl(encode(row));
  assert.deepEqual(texts(display), ['1', 'answered', 'new', 'active']);
  assert.equal(display.contextUsage?.messageId, 'active');
  display.ingestJsonl(encode(...rows), true);
  assert.deepEqual(texts(display), ['1', 'answered', 'new', 'active']);
});

test('repeated legacy timing values belong to their respective foreground turns', () => {
  const display = new MessageDisplay('s');
  const timing = { type: 'system', subtype: 'turn_duration', pendingWorkflowCount: 1 };
  display.ingestJsonl(encode(user('one', null), assistant('first', 'one', 10, null), timing));
  display.ingestJsonl(encode({ type: 'user', uuid: 'two', message: { content: 'two' } }, assistant('second', 'two', 20, null), timing, timing));
  assert.equal(display.contextUsage?.totalInputTokens, 20);
  assert.match(display.notice ?? '', /1 个工作流/);
  assert.equal(display.getMessages().at(-1)?.status, 'complete');
});

test('a revision to an older record cannot acknowledge a second identical pending prompt', () => {
  const display = new MessageDisplay('s');
  display.ingestJsonl(encode(user('one', null, 'again'), assistant('first reply', 'one', 10)));
  display.optimisticUser('again');
  const pending = display.getMessages().at(-2)!.id;
  display.ingestJsonl(encode(assistant('first reply', 'one', 22)));
  assert.equal(display.getMessages().at(-2)?.id, pending);
  assert.equal(display.getMessages().at(-2)?.source, 'pending');
  display.ingestJsonl(encode(user('two', 'first reply', 'again')));
  assert.equal(display.getMessages().at(-2)?.id, pending);
  assert.equal(display.getMessages().at(-2)?.source, 'jsonl');
});

test('an explicit empty retention list can remove all pre-boundary messages', () => {
  const display = new MessageDisplay('s');
  const boundary = { type: 'system', subtype: 'compact_boundary', uuid: 'boundary', parentUuid: null, logicalParentUuid: 'answer',
    compactMetadata: { preservedMessages: { uuids: [], anchorUuid: 'summary' } } };
  display.ingestJsonl(encode(user('u', null), assistant('answer', 'u', 14), boundary, { ...user('summary', 'boundary'), isCompactSummary: true }));
  assert.deepEqual(texts(display), []);
  assert.equal(display.contextUsage, undefined);
  display.ingestJsonl(encode(user('new', 'summary')));
  assert.deepEqual(texts(display), ['new', '']);
});

test('partial history signals a broken link until its parent arrives', () => {
  const display = new MessageDisplay('s');
  display.ingestJsonl(encode(assistant('reply', 'missing', 10)));
  assert.deepEqual(texts(display), ['reply']);
  assert.match(display.notice ?? '', /父记录/);
  display.ingestJsonl(encode(user('missing', null)));
  assert.deepEqual(texts(display), ['missing', 'reply']);
  assert.equal(display.notice, undefined);
});

test('a first response written before its prompt and attachments (Claude Code 2.1.300/2.1.310) stays in its turn', () => {
  // Sampled with the matrix sandbox (config on a slow disk): the session's first flush holds the
  // tool call awaiting permission ahead of the prompt it answers; parents are intact.
  const attachment = (uuid: string, parentUuid: string) => ({ type: 'attachment', uuid, parentUuid, attachment: { type: 'date', date: '2026-11-21' } });
  const call = { type: 'assistant', uuid: 'call', parentUuid: 'att3', message: { id: 'msg_1', role: 'assistant', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'echo allowed > allowed.txt', description: 'Write a marker file' } }] } };
  const flushed = [{ type: 'ai-title', aiTitle: 'Check' }, { type: 'mode', mode: 'normal' }, { type: 'atis-latch', atis: '' }, { type: 'atis-latch', atis: '' }, call,
    { type: 'file-history-snapshot', messageId: 'prompt', snapshot: { messageId: 'prompt', trackedFileBackups: {} } },
    user('prompt', null, 'Write a marker'), attachment('att1', 'prompt'), attachment('att2', 'att1'), attachment('att3', 'att2')];
  const turn = (display: MessageDisplay) => display.getMessages().map(message => [message.role, message.text, message.tools.map(tool => [tool.id, tool.result === undefined ? 'pending' : 'done'])]);
  const expected = [['user', 'Write a marker', []], ['assistant', '', [['toolu_bash', 'pending']]]];
  const whole = new MessageDisplay('s');
  whole.ingestJsonl(encode(...flushed));
  assert.deepEqual(turn(whole), expected);
  assert.equal(pendingToolId(whole.getMessages()), 'toolu_bash', 'the permission card has its call');
  const split = new MessageDisplay('s');
  for (const row of flushed) split.ingestJsonl(encode(row));
  assert.deepEqual(turn(split), expected, 'record by record');
  // Approved: the result and the reply follow in order.
  const rest = [result('result', 'call', 'toolu_bash'), assistant('Done', 'result', 12), duration('took', 'Done')];
  whole.ingestJsonl(encode(...rest));
  assert.deepEqual(turn(whole), [['user', 'Write a marker', []], ['assistant', 'Done', [['toolu_bash', 'done']]]]);
  // A text reply written ahead of its prompt is shown too, not held back until the next turn.
  const text = new MessageDisplay('s');
  text.ingestJsonl(encode(assistant('Hello', 'att2', 10), user('hi', null), attachment('att1', 'hi'), attachment('att2', 'att1'), duration('d', 'Hello')));
  assert.deepEqual(texts(text), ['hi', 'Hello']);
});

test('a finished turn that left background agents or workflows running reports them until they end', () => {
  const display = new MessageDisplay('s');
  display.ingestJsonl(encode(user('ask', null), assistant('answer', 'ask', 10), duration('done', 'answer')));
  assert.equal(display.pendingBackground, undefined);
  display.ingestJsonl(encode(user('again', 'done'), assistant('reply', 'again', 10),
    { ...duration('done2', 'reply'), pendingBackgroundAgentCount: 2, pendingWorkflowCount: 1 }));
  assert.deepEqual(display.pendingBackground, { agents: 2, workflows: 1, at: undefined });
  assert.equal(display.status, 'idle');
  assert.match(display.notice ?? '', /2 个后台代理、1 个工作流仍在运行/);
  // The next turn (for example the task notification's) starts over.
  display.ingestJsonl(encode(user('next', 'done2')));
  assert.equal(display.pendingBackground, undefined);
});
