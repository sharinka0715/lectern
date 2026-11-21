import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageDisplay } from '../src/core/message-display';
import { isTranscriptTurnStart } from '../src/core/transcript-store';
import { pendingQuestionId } from '../src/main/session-question';
import type { JsonRecord } from '../src/core/jsonl';

const sessionId = 'paged-native';
const encode = (...rows: JsonRecord[]) => Buffer.from(rows.map(row => JSON.stringify({ sessionId, ...row })).join('\n') + '\n');
const user = (uuid: string, parentUuid: string | null, content = uuid) =>
  ({ uuid, parentUuid, type: 'user', message: { role: 'user', content } });
const assistant = (uuid: string, parentUuid: string, content = [{ type: 'text', text: uuid }] as JsonRecord[], stop = 'end_turn') =>
  ({ uuid, parentUuid, type: 'assistant', message: { role: 'assistant', id: uuid, model: 'claude', content, stop_reason: stop,
    usage: { input_tokens: 17, cache_read_input_tokens: 5, cache_creation_input_tokens: 0, output_tokens: 4 } } });
const boundary = (uuid: string, logicalParentUuid: string, ids: string[]) => ({
  type: 'system', subtype: 'compact_boundary', uuid, parentUuid: null, logicalParentUuid,
  compactMetadata: { trigger: 'auto', preservedMessages: { anchorUuid: uuid + '-summary', uuids: ids, allUuids: ids },
    preservedSegment: { anchorUuid: uuid + '-summary', headUuid: ids[0], tailUuid: ids.at(-1) } },
});
const summary = (id: string) => ({ ...user(id + '-summary', id, 'internal context'), isCompactSummary: true, isVisibleInTranscriptOnly: true });
const texts = (display: MessageDisplay) => display.getMessages().map(m => m.text);
const page = () => new MessageDisplay(sessionId);

test('paged compaction spans two boundaries and preserves selected history, usage, and rewind candidates', () => {
  const first = [user('old', null), assistant('answer', 'old'), user('discarded', 'answer'), assistant('wrong', 'discarded'),
    { type: 'last-prompt', explicit: true, rewound: true, leafUuid: 'answer', cutUuid: 'discarded' },
    user('kept', 'answer'), assistant('kept-answer', 'kept')];
  const middle = [boundary('b1', 'kept-answer', ['kept','kept-answer']), summary('b1'),
    user('after', 'b1-summary'), assistant('after-answer', 'after')];
  const latest = [boundary('b2', 'after-answer', []), summary('b2'), user('latest', 'b2-summary'), assistant('latest-answer', 'latest')];
  const display = page();
  display.ingestJsonl(encode(...latest), true, true);
  const tail = display.getMessages();
  display.prependJsonl(encode(...middle), true);
  assert.deepEqual(texts(display), ['after', 'after-answer', 'latest', 'latest-answer']);
  display.prependJsonl(encode(...first), false);
  assert.deepEqual(texts(display), ['old', 'answer', 'kept', 'kept-answer', 'after', 'after-answer', 'latest', 'latest-answer']);
  assert.deepEqual(display.getMessages().slice(-2), tail);
  assert.equal(display.contextUsage?.messageId, 'latest-answer');
  assert.equal(display.confirmNativeRewind('kept'), undefined);
  assert.equal(display.confirmNativeRewind('latest'), 'latest');
  assert.deepEqual(texts(display), ['old','answer','kept','kept-answer','after','after-answer']);
  assert.equal(display.contextUsage, undefined);
});

test('older pages complete an anonymous streaming turn and parallel results while preserving in-flight UTF-8 and its bubble', () => {
  const tools = (...names: string[]) => names.map(id => ({ type: 'tool_use', name: 'Read', id, input: { file_path: id } }));
  const result = (id: string, parentUuid: string, tool: string) => ({ type: 'user', uuid: id, parentUuid, sourceToolAssistantUUID: 'use',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool, content: 'result ' + tool }] } });
  const opening = assistant('use', 'question', tools('one', 'two'), 'tool_use');
  const continuation = assistant('cont', 'r1', [{type:'text',text:'working'}], 'tool_use');
  const final = encode(assistant('end', 'cont', [{type:'text',text:'完成 🧭'}]));
  const split = final.indexOf('🧭') + 2;
  const display = page();
  display.ingestJsonl(Buffer.concat([encode(result('r1','use','one'), continuation, result('r2','r1','two')), final.subarray(0,split)]), true, true);
  const id = display.getMessages()[0].id;
  assert.deepEqual(texts(display), ['working']);
  assert.deepEqual(display.getMessages()[0].tools.map(tool => tool.textOffset), [null, null]);
  display.prependJsonl(encode(opening), true);
  assert.deepEqual(display.getMessages()[0].tools.map(tool => tool.textOffset), [0, 0]);
  assert.deepEqual(display.getMessages()[0].tools.map(t => t.result), ['result one','result two']);
  display.prependJsonl(encode(user('question', null)), false);
  display.ingestJsonl(final.subarray(split));
  assert.deepEqual(texts(display), ['question','working\n\n完成 🧭']);
  assert.equal(display.getMessages()[1].id, id);
  assert.equal(display.notice, undefined);
});

test('a results-only tail shows the recorded output and later resolves its original tool name and input in place', () => {
  const display = page();
  const result = (id: string) => ({ type:'user', uuid:'result-' + id, parentUuid:'call', sourceToolAssistantUUID:'call',
    message:{role:'user', content:[{type:'tool_result',tool_use_id:id, content:'output ' + id}]} });
  display.ingestJsonl(encode(result('a'),result('b')), true, true);
  const tail = display.getMessages();
  assert.equal(tail.length,1);
  assert.deepEqual(tail[0].tools.map(tool => [tool.id,tool.name,tool.result]),
    [['a','工具结果','output a'],['b','工具结果','output b']]);
  display.prependJsonl(encode(user('prompt',null),assistant('call','prompt',['a','b'].map(id => ({
    type:'tool_use', name:'Read',id,input:{file_path:id} })), 'tool_use')),false);
  const repaired = display.getMessages();
  assert.equal(repaired[1].id,tail[0].id);
  assert.deepEqual(repaired[1].tools.map(tool => [tool.id,tool.name,JSON.parse(tool.input).file_path,tool.result]),
    [['a','Read','a','output a'],['b','Read','b','output b']]);
});

test('prepending an old checkpoint or identical prompt cannot acknowledge pending input or erase live previews', () => {
  const display = page();
  const old = [user('1',null,'same'), assistant('first','1'), user('cut','first'), assistant('abandoned','cut'),
    { type: 'last-prompt', explicit: true, rewound: true, leafUuid:'first', cutUuid:'cut' }];
  display.ingestJsonl(encode(user('now','first'),assistant('disk','now', [{type:'text',text:'reply'}],'tool_use')),true,true);
  display.ingestScreen('❯ now\n⏺ reply and preview\n✻ Thinking… (esc to interrupt)\n─────────────────\n❯ \n─────────────────\n');
  display.optimisticUser('same');
  const before = display.getMessages();
  display.prependJsonl(encode(...old), false);
  assert.deepEqual(display.getMessages().slice(-4), before);
  assert.equal(display.getMessages().at(-2)?.source, 'pending');
  display.ingestJsonl(encode(user('sent','disk','same'), assistant('ack','sent')));
  assert.deepEqual(texts(display), ['same', 'first', 'now','reply and preview','same','ack']);
  assert.equal(display.getMessages().at(-2)?.id,before.at(-2)?.id);
});

test('a live restore while paging is still authoritative after older records are available', () => {
  const display = page();
  display.ingestJsonl(encode(user('second', 'first-a'), assistant('second-a','second'), user('cut','second-a')),true,true);
  display.confirmNativeRewind('cut');
  display.prependJsonl(encode(user('first',null),assistant('first-a','first')),false);
  assert.deepEqual(texts(display),['first','first-a','second','second-a']);
  display.ingestJsonl(encode(user('resumed','second-a'),assistant('new','resumed')));
  assert.equal(display.getMessages().some(row => row.text === 'cut'),false);
});

test('an explicit checkpoint whose target precedes the tail hides the abandoned turn immediately', () => {
  const display = page();
  display.ingestJsonl(encode(user('cut', 'answer'), assistant('wrong', 'cut'),
    { type:'last-prompt', explicit:true, rewound:true, leafUuid:'answer', cutUuid:'cut' }), true, true);
  assert.deepEqual(texts(display), []);
  display.ingestJsonl(encode(user('replacement', 'answer')));
  display.prependJsonl(encode(user('original', null), assistant('answer','original')), false);
  assert.deepEqual(texts(display), ['original','answer','replacement','']);
});

test('older replay preserves the live task-file sample and does not restart a finished tool', () => {
  const display = page();
  const shell = assistant('call', 'now', [{type:'tool_use',name:'Bash',id:'tool',input:{command:'pwd',run_in_background:true}}], 'tool_use');
  const result = { type:'user',uuid:'result',parentUuid:'call',sourceToolAssistantUUID:'call',toolUseResult:{backgroundTaskId:'shell1'},
    message:{role:'user',content:[{type:'tool_result',tool_use_id:'tool',content:'Running in background'}]} };
  display.ingestJsonl(encode(user('now','first-a'),shell,result),true,true);
  display.activity.samples([{taskId:'shell1', stamp:'v1',tail:'observed output',clipped:false}]);
  const task = display.activity.snapshot(true);
  display.prependJsonl(encode(user('first',null),assistant('first-a','first')),false);
  assert.deepEqual(display.activity.snapshot(true),task);
  assert.equal(display.activity.targets()[0].stamp,'v1');
});

test('older decode failures accumulate independently of live records; partial-parent notices wait for byte zero', () => {
  const display = page();
  display.ingestJsonl(encode(assistant('partial', 'missing')), true, true);
  assert.equal(display.notice,undefined);
  display.prependJsonl('invalid\n',true);
  assert.match(display.notice ?? '',/1 条/);
  display.noteSkippedHistoryRecords(1);
  display.ingestJsonl('also invalid\n');
  assert.match(display.notice ?? '',/3 条/);
  display.prependJsonl('',false);
  assert.match(display.notice ?? '',/3 条.*父记录/);
  display.ingestJsonl(encode(assistant('new','missing')),true,false);
  assert.match(display.notice ?? '',/父记录/);
  assert.doesNotMatch(display.notice ?? '',/已跳过/);
});

test('native tool results, replayed summaries, notifications and sidechains are not human page boundaries', () => {
  const prompt = user('human',null);
  assert.ok(isTranscriptTurnStart(prompt, sessionId));
  assert.ok(isTranscriptTurnStart({type:'attachment',attachment:{type:'queued_command',humanTurn:true,origin:{kind:'human'},commandMode:'prompt',prompt:'sent'}}, sessionId));
  for (const row of [summary('compact'),{...prompt,isSidechain:true},{...prompt,sessionId:'other'},{...prompt,isMeta:true},
    {...prompt,origin:{kind:'task-notification'}},{...prompt,message:{content:[{type:'tool_result',tool_use_id:'t',content:'result'}]}}]) {
    assert.equal(isTranscriptTurnStart(row,sessionId),false);
  }
});

test('a new chat whose opening records outgrow the first page still acknowledges its pending first message', () => {
  // Claude Code 2.1.329 writes environment, tool lists and a system prompt snapshot
  // before the first reply: the first read (the file's tail) holds only the reply,
  // and paging back reaches the prompt. That prompt is the pending send, not history.
  const display = page();
  const prompt = '@work/archive.zip 帮我解压一下这个zip，看看里面有什么东西';
  display.optimisticUser(prompt);
  assert.equal(display.getMessages().at(0)?.source, 'pending');
  const opening = [user('prompt', null, prompt),
    { type: 'attachment', uuid: 'env', parentUuid: 'prompt', attachment: { type: 'environment', snapshot: { workingDirectory: '/root' } } },
    { type: 'attachment', uuid: 'snap', parentUuid: 'env', attachment: { type: 'prompt_snapshot', systemPrompt: ['x'.repeat(2000)] } }];
  const reply = [assistant('call', 'snap', [{ type: 'tool_use', id: 'ls', name: 'Bash', input: { command: 'ls' } }], 'tool_use'),
    { uuid: 'result', parentUuid: 'call', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ls', content: 'archive.zip' }] } },
    assistant('answer', 'result', [{ type: 'text', text: '解压好了。' }]),
    { type: 'system', subtype: 'turn_duration', uuid: 'duration', parentUuid: 'answer', durationMs: 47000 }];
  display.ingestJsonl(encode(...reply), true, true);
  display.prependJsonl(encode(...opening), false, true, false);
  const messages = display.getMessages();
  assert.deepEqual(messages.map(m => [m.role, m.source]), [['user', 'jsonl'], ['assistant', 'jsonl']]);
  assert.equal(messages[0].text, prompt);
  assert.equal(messages[1].text, '解压好了。');
  assert.equal(display.status, 'idle', 'the finished reply leaves the chat idle, not stuck on 正在回复');
});

test('paging back to an older identical prompt still cannot acknowledge a pending send when a newer prompt exists', () => {
  const display = page();
  display.ingestJsonl(encode(assistant('tail', 'newer', [{ type: 'text', text: 'newer reply' }])), true, true);
  display.optimisticUser('same');
  display.prependJsonl(encode(user('old', null, 'same'), assistant('old-answer', 'old'), user('newer', 'old-answer', 'different')), false, true, false);
  // The pending prompt (and its live preview) stays after the canonical history.
  assert.deepEqual(texts(display).slice(0, 5), ['same', 'old-answer', 'different', 'newer reply', 'same']);
  assert.equal(display.getMessages().at(-2)?.source, 'pending');
  assert.equal(display.getMessages()[0].source, 'jsonl');
});

test('the first question of a new chat is answerable when its prompt only arrives by paging back', () => {
  // Were the pending first message left after the transcript's own turn, looking
  // backwards for the open AskUserQuestion would stop at it and show no question card.
  const display = page();
  display.optimisticUser('launch the experiment');
  const opening = [user('prompt', null, 'launch the experiment'),
    { type: 'attachment', uuid: 'snap', parentUuid: 'prompt', attachment: { type: 'prompt_snapshot', systemPrompt: ['x'.repeat(2000)] } }];
  const ask = assistant('ask', 'snap', [{ type: 'text', text: 'Which checkpoint?' },
    { type: 'tool_use', id: 'question', name: 'AskUserQuestion', input: { questions: [] } }], 'tool_use');
  display.ingestJsonl(encode(ask), true, true);
  display.prependJsonl(encode(...opening), false, true, false);
  assert.deepEqual(display.getMessages().map(m => [m.role, m.source]), [['user', 'jsonl'], ['assistant', 'jsonl']]);
  assert.equal(pendingQuestionId(display.getMessages()), 'question');
  // Even a stale pending send behind it does not hide the open question.
  const stale = [...display.getMessages(), { ...display.getMessages()[0], id: 'stale:user', source: 'pending' as const },
    { ...display.getMessages()[1], id: 'stale:assistant', source: 'preview' as const, text: 'Which checkpoint?', tools: [] }];
  assert.equal(pendingQuestionId(stale), 'question');
});

test('Claude Code 2.1.316 records the bare /compact when compaction starts; it is not a prompt', () => {
  const display = page();
  const typed = (uuid: string, parentUuid: string | null, content: string) => ({ ...user(uuid, parentUuid, content), origin: { kind: 'human' }, promptSource: 'typed' });
  display.ingestJsonl(encode(typed('first', null, '第一条消息'), assistant('answer', 'first'),
    { type: 'system', subtype: 'turn_duration', uuid: 'duration', parentUuid: 'answer', durationMs: 900 }), true, true);
  display.ingestJsonl(encode(user('bare', 'duration', '/compact')), false, true);
  assert.deepEqual(texts(display), ['第一条消息', 'answer'], 'no /compact bubble waiting for Claude while it compacts');
  display.ingestJsonl(encode({ ...boundary('b', 'duration', []), compactMetadata: { trigger: 'manual' } }, summary('b'),
    user('echo', 'b-summary', '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>'),
    typed('queued', 'echo', '压缩中发的消息'), assistant('queued-answer', 'queued')), false, true);
  assert.deepEqual(texts(display), ['第一条消息', 'answer', '压缩中发的消息', 'queued-answer']);
  // A typed prompt that only starts like the command is still a prompt.
  assert.equal(isTranscriptTurnStart({ ...user('p', null, '/compactor 是什么？'), sessionId }), true);
});
