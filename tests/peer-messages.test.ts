import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageDisplay } from '../src/core/message-display';
import { isTranscriptTurnStart } from '../src/core/transcript-store';

const sessionId = 'local-branch';
const user = (uuid: string, content: string) => ({ sessionId, type: 'user', uuid, message: { content } });
const answer = (uuid: string, content: unknown) => ({ sessionId, type: 'assistant', uuid, message: { id: uuid, content, stop_reason: 'end_turn' } });
const lines = (...records: unknown[]) => records.map(row => JSON.stringify(row)).join('\n') + '\n';
const wrapper = '<cross-session-message from="other">请核对结果</cross-session-message>';
const parent = { ...user('parent', wrapper), origin: { kind: 'human' } };
const peer = { type: 'attachment', uuid: 'delivery', sessionId, attachment: { type: 'queued_command', isMeta: true,
  prompt: wrapper, origin: { kind: 'peer', from: 'other', msg_id: 'delivery-id' } } };

test('会话与子代理消息按生产者和投递位置展示，人工粘贴的标签保留为提问', () => {
  const display = new MessageDisplay(sessionId);
  const first = lines(parent, answer('before', [{ type: 'text', text: '收到。' }, { type: 'tool_use', name: 'SendMessage', id: 'send', input: { to: 'other', message: '请检查' } }]));
  const rest = lines(peer, { ...peer, uuid: 'redelivery' }, { ...user('agent', '包装文字'), isMeta: true,
    origin: { kind: 'peer', senderTaskId: 'agent-1', name: '检查代理', body: '已核对', handback: true } },
    { type: 'attachment', uuid: 'mail', sessionId, attachment: { type: 'teammate_mailbox', messages: [{ from: '审阅', text: '补充信息' }] } },
    { ...user('ignore', '其他分支'), sessionId: 'another', origin: { kind: 'peer' } },
    { ...user('private', '代理的独立历史'), isSidechain: true, origin: { kind: 'peer' } }, answer('after', '完成。'));
  display.ingestJsonl(first + rest);
  const [human, reply] = display.getMessages();
  assert.equal(human.text, wrapper); assert.equal(human.rewindUuid, 'parent');
  assert.equal(display.getMessages().length, 2);
  assert.deepEqual(reply.peerMessages?.map(p => [p.source, p.sender, p.text, p.textOffset, p.toolsBefore]), [
    ['session', 'other', '请核对结果', 3, 1], ['handback', '检查代理', '已核对', 3, 1], ['agent', '审阅', '补充信息', 3, 1],
  ]);
  assert.equal(reply.text, '收到。\n\n完成。');
  assert.ok(isTranscriptTurnStart(parent, sessionId)); assert.equal(isTranscriptTurnStart(peer, sessionId), false);
  const paged = new MessageDisplay(sessionId);
  paged.ingestJsonl(rest, true, true); paged.prependJsonl(first, false);
  assert.deepEqual(paged.getMessages()[1].peerMessages, reply.peerMessages);
});

test('回退移除被放弃的分支投递，只有活动的人类回合可作为回退目标', () => {
  const display = new MessageDisplay(sessionId);
  display.ingestJsonl(lines(parent, answer('first-answer', '收到'), user('second', '另一个问题'), peer, answer('old-answer', '旧答复')));
  display.confirmNativeRewind('另一个问题', 'second');
  display.ingestJsonl(lines({ ...user('new-question', '新分支'), parentUuid: 'first-answer' }, answer('new-answer', '完成')));
  assert.deepEqual(display.getMessages().flatMap(m => m.peerMessages ?? []), []);
  assert.deepEqual(display.getMessages().flatMap(m => m.rewindUuid ? [m.rewindUuid] : []), ['parent', 'new-question']);
});
