import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageDisplay } from '../src/core/message-display';

const sessionId = 'manual-terminal-session';
const user = (uuid: string, text: string, timestamp = '2026-11-18T08:00:00.000Z') => ({
  type: 'user', sessionId, uuid, timestamp, message: { role: 'user', content: text },
});
const assistant = (uuid: string, content: unknown[], stop_reason: string | null = 'end_turn') => ({
  type: 'assistant', sessionId, uuid, timestamp: '2026-11-18T08:00:02.000Z', message: { role: 'assistant', content, stop_reason },
});
const text = (value: string) => ({ type: 'text', text: value });
const result = (uuid: string, id: string, content: string, is_error = false) => ({
  type: 'user', sessionId, uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] },
});
const jsonl = (...records: unknown[]) => records.map(record => JSON.stringify(record)).join('\n') + '\n';

test('manual native user records create one stable bubble without optimistic insertion or screen previews', () => {
  const display = new MessageDisplay(sessionId);
  const original = jsonl(user('first', '先讨论一下。'), assistant('reply', [text('好的。')]));
  display.ingestJsonl(original);
  const oldMessages = display.getMessages();
  const submitted = jsonl(user('second', '手动输入：你好 🧭\n第二行', '2026-11-18T08:01:00.000Z'));
  const bytes = Buffer.from(submitted);
  // Text entry and native navigation call neither optimisticUser nor ingestScreen.
  // Only a complete native record establishes the next human turn.
  display.ingestJsonl(bytes.subarray(0, bytes.length - 1));
  assert.deepEqual(display.getMessages(), oldMessages);
  display.ingestJsonl(bytes.subarray(bytes.length - 1));
  const initial = display.getMessages();
  assert.equal(initial.length, 4);
  assert.equal(initial[2].source, 'jsonl');
  assert.equal(initial[2].text, '手动输入：你好 🧭\n第二行');
  assert.equal(initial[2].timestamp, '2026-11-18T08:01:00.000Z');
  const assistantId = initial[3].id;
  const continuation = jsonl(assistant('manual-part', [text('第一段。')], null), assistant('manual-final', [text('第二段。')]));
  for (const byte of Buffer.from(continuation)) display.ingestJsonl(Buffer.from([byte]));
  assert.equal(display.getMessages()[3].id, assistantId);
  assert.equal(display.getMessages()[3].text, '第一段。\n\n第二段。');
  assert.equal(display.getMessages()[3].status, 'complete');
  assert.equal(display.getMessages()[3].source, 'jsonl');
  assert.deepEqual(display.getMessages().slice(0, 2), oldMessages);
  const final = display.getMessages();
  display.ingestJsonl(submitted + continuation);
  assert.deepEqual(display.getMessages(), final);
  const reopened = new MessageDisplay(sessionId);
  reopened.ingestJsonl(original + submitted + continuation);
  assert.deepEqual(reopened.getMessages(), final);
});

test('manual question and plan answers stay attached to their tool calls without invented user turns', () => {
  const display = new MessageDisplay(sessionId);
  const questionInput = { questions: [{ question: '选择哪些输出？', header: '输出', multiSelect: true,
    options: [{ label: '文件', description: '写入当前目录' }, { label: '终端', description: '在终端显示' }] }] };
  const rows = [
    user('request', '请先问清需求，再给计划。'),
    assistant('question', [text('先确认输出形式。'), { type: 'tool_use', id: 'question-1', name: 'AskUserQuestion', input: questionInput }], 'tool_use'),
    result('answer', 'question-1', 'User answered: 文件, 终端。补充：保留中文🧭。'),
    assistant('plan', [text('计划已准备好。'), { type: 'tool_use', id: 'plan-1', name: 'ExitPlanMode', input: {} }], 'tool_use'),
    result('decline', 'plan-1', 'The user declined the plan: 先补充验证步骤。', true),
    assistant('revised', [text('好的，我先补充验证步骤，不执行修改。')]),
  ];
  display.ingestJsonl(jsonl(...rows.slice(0, 2)));
  const id = display.getMessages()[1].id;
  assert.equal(display.getMessages()[1].tools[0].result, undefined);
  display.ingestJsonl(jsonl(...rows.slice(2)));
  const messages = display.getMessages();
  assert.equal(messages.length, 2);
  assert.equal(messages[1].id, id);
  assert.equal(messages[1].text, '先确认输出形式。\n\n计划已准备好。\n\n好的，我先补充验证步骤，不执行修改。');
  assert.deepEqual(messages[1].tools, [
    { id: 'question-1', name: 'AskUserQuestion', input: JSON.stringify(questionInput, null, 2), textOffset: '先确认输出形式。'.length,
      result: 'User answered: 文件, 终端。补充：保留中文🧭。', isError: false },
    { id: 'plan-1', name: 'ExitPlanMode', input: '{}', textOffset: '先确认输出形式。\n\n计划已准备好。'.length,
      result: 'The user declined the plan: 先补充验证步骤。', isError: true },
  ]);
  assert.equal(messages[1].source, 'jsonl');
  assert.equal(messages[1].status, 'complete');
  display.ingestJsonl(jsonl(...rows));
  assert.deepEqual(display.getMessages(), messages);
  display.ingestJsonl(jsonl(...rows), true);
  assert.deepEqual(display.getMessages(), messages);
});

test('manual slash-command bookkeeping stays hidden while actual repeated user text remains two turns', () => {
  const display = new MessageDisplay(sessionId);
  display.ingestJsonl(jsonl(
    user('command', '<command-name>/help</command-name>\n<command-message>help</command-message>'),
    user('output', '<local-command-stdout>Help dialog closed.</local-command-stdout>'),
    { ...user('meta', 'A native notification'), isMeta: true },
  ));
  assert.deepEqual(display.getMessages(), []);
  const first = jsonl(user('yes-1', 'yes'), assistant('yes-answer-1', [text('已收到第一条普通消息。')]));
  const second = jsonl(user('yes-2', 'yes', '2026-11-18T08:02:00.000Z'), assistant('yes-answer-2', [text('已收到第二条普通消息。')]));
  display.ingestJsonl(first + second);
  const messages = display.getMessages();
  assert.equal(messages.length, 4);
  assert.deepEqual(messages.filter(message => message.role === 'user').map(message => message.text), ['yes', 'yes']);
  assert.notEqual(messages[0].id, messages[2].id);
  const reopened = new MessageDisplay(sessionId);
  reopened.ingestJsonl(first + second);
  assert.deepEqual(reopened.getMessages(), messages);
});
