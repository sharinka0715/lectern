import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionActivityStore } from '../src/core/session-activity';
import { readActivityFiles, decodeActivityFiles } from '../src/backend/activity-files';
import { backgroundCounts, backgroundSummary } from '../src/core/background-work';
import { activityTally, runningMs } from '../src/shared/activity';

const sid = '00000000-0000-4011-8011-000000000001';
const call = (id: string, name: string, input: unknown) => ({ type: 'assistant', sessionId: sid, message:{content:[{type:'tool_use', id, name, input}]} });
const result = (id: string, toolUseResult: unknown, is_error = false) => ({ type:'user', sessionId:sid, toolUseResult, message:{content:[{type:'tool_result', tool_use_id:id, content:'native result', is_error}]} });
const stamp = '2026-01-01T01:02:03.004Z';
const xml = (id: string, state: string) => `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>shell</tool-use-id>\n<status>${state}</status>\n<summary>Fixture failed with exit code 4</summary>\n</task-notification>`;

test('native notification before the next user message completes an idle background shell; unrelated IDs, snapshots and typed XML are isolated', () => {
  const store = new SessionActivityStore(sid);
  store.ingest([call('shell', 'Bash', { command: 'example', run_in_background:true }), result('shell', { backgroundTaskId:'b123' })]);
  const original = store.snapshot(true);
  store.ingest([{type:'user', origin:{kind:'human'},message:{content:xml('b123', 'failed')}}, {type:'queue-operation', operation:'enqueue', content:xml('wrong', 'failed')},
    {type:'queue-operation', sessionId:'other', operation:'enqueue', content:xml('b123', 'failed')}]);
  assert.equal(store.snapshot(true)[0].status, 'running');
  assert.equal(store.snapshot(false)[0].status, 'unobserved');
  store.ingest([{type:'queue-operation', operation:'enqueue', timestamp:stamp, content:xml('b123', 'failed')}]);
  const done = store.snapshot(false)[0];
  assert.equal(done.status,'failed');
  assert.equal(done.exitCode,4);
  assert.equal(done.endedAt,stamp);
  assert.equal(original[0].status,'running');
});

test('only a successful TaskStop changes the exact monitor, reads stay bounded, and user output is never proof of exit', () => {
  const store = new SessionActivityStore(sid);
  store.ingest([call('mon','Monitor',{command:'example'}),result('mon',{taskId:'b222',timeoutMs:5000})]);
  const notification = '<task-notification>\n<task-id>b222</task-id>\n<summary>Monitor event: "test"</summary>\n<event>x &lt;y&gt;</event>\n</task-notification>';
  store.ingest([{type:'queue-operation',operation:'enqueue',content:notification,timestamp:stamp}, {type:'user', origin:{kind:'task-notification'},message:{content:notification},timestamp:'2026-01-01T01:02:33.004Z'}]);
  store.samples([{taskId:'b222',stamp:'1:5:3',tail:'[exited with code 0]',clipped:false}]);
  store.ingest([call('failstop','TaskStop',{task_id:'b222'}),result('failstop',{},true)]);
  assert.equal(store.snapshot(true)[0].status,'running');
  assert.deepEqual(store.snapshot(true)[0].events.map(e=>e.text),['x <y>']);
  store.ingest([call('stop','TaskStop',{task_id:'b222'}),result('stop',{task_id:'b222'})]);
  assert.equal(store.snapshot(true)[0].status,'stopped');
  for (let i = 0; i < 13; i++) store.ingest([call('s'+i,'Bash',{}),result('s'+i,{backgroundTaskId:'b'+i})]);
  assert.equal(store.targets().length,8);
  assert.equal(new Set([...store.targets(), ...store.targets()].map(t=>t.taskId)).size,13);
});

test('same-roundtrip observer reads only the named child, skips API records and unchanged bytes, and rejects a replaced symlink', { skip: process.platform === 'win32' ? 'POSIX shell target; Windows runs no local commands' : false }, async () => {
  const root = await mkdtemp(path.join(tmpdir(),'lectern-activity-'));
  const project = path.join(root,'projects','-fixture-slug'), subs = path.join(project,sid,'subagents');
  try {
    await mkdir(subs,{recursive:true});
    const file = path.join(subs,'agent-a123.jsonl');
    const child = {parentUuid:null,isSidechain:true,sessionId:sid,agentId:'a123',type:'assistant',uuid:'abc',message:{model:'model',content:[{type:'tool_use',name:'Read',id:'read',input:{file_path:'fixture.txt'}}]}};
    await writeFile(file,JSON.stringify({type:'api-request', params: 'omitted'})+'\n'+JSON.stringify(child)+'\n');
    const target = { taskId:'a123',kind:'agent' as const };
    const read = (stamp?:string) => decodeActivityFiles(execFileSync('/bin/sh',['-c',readActivityFiles(sid,[project],[{...target,stamp}])]));
    const [sample] = read();
    assert.ok(sample);
    assert(!sample.tail.includes('omitted'));
    const store = new SessionActivityStore(sid);
    store.ingest([call('agent','Agent',{description:'read'}),result('agent',{status:'async_launched',agentId:'a123'})]);
    store.samples([sample]);
    assert.deepEqual(store.snapshot(true)[0].events.map(e=>e.text), ['Read · fixture.txt']);
    assert.equal(read(sample.stamp)[0].tail,'');
    await rm(file);
    await symlink(path.join(root,'private'),file);
    await writeFile(path.join(root,'private'),'unrelated');
    assert.deepEqual(read(),[]);
    assert.equal(readActivityFiles(sid,[project],[{...target,taskId:'../../private'}]),'');
  } finally { await rm(root,{recursive:true,force:true}); }
});


test('the turn-end notice counts a background agent until that exact launch finishes', () => {
  const store = new SessionActivityStore(sid);
  const began = '2026-01-01T01:02:01.000Z', duration = '2026-01-01T01:02:02.000Z', ended = '2026-01-01T01:02:04.000Z';
  store.ingest([{ ...call('child','Agent',{}), timestamp:began }, result('child',{agentId:'a12',isAsync:true})]);
  assert.equal(store.endedAgentsSince(duration),0);
  store.ingest([{type:'queue-operation', operation:'enqueue', timestamp:ended,
    content:xml('a12','completed').replace('<tool-use-id>shell','<tool-use-id>child')}]);
  assert.equal(store.endedAgentsSince(duration),1);
  assert.equal(store.endedAgentsSince('2026-01-02T00:00:00.000Z'),0);
});

// Background subagents as Claude Code 2.1.302–2.1.329 record them: launched by an
// async Agent call, ended by task notifications (enqueued, then delivered or
// absorbed), resumed by SendMessage. Synthetic records with the native shapes.
const at = (minute: number) => `2026-01-01T02:${String(minute).padStart(2, '0')}:00.000Z`;
const launch = (tool: string, agent: string, minute: number) => [
  { ...call(tool, 'Agent', { description: 'Fixture ' + agent, prompt: 'Work.', subagent_type: 'general-purpose', run_in_background: true }), timestamp: at(minute) },
  { ...result(tool, { isAsync: true, status: 'async_launched', agentId: agent, description: 'Fixture ' + agent }), timestamp: at(minute) },
];
const notice = (agent: string, tool: string | undefined, state: string, summary: string, note = 'A task-notification fires each time this agent stops.', tokens = 1200) =>
  `<task-notification>\n<task-id>${agent}</task-id>\n${tool ? `<tool-use-id>${tool}</tool-use-id>\n` : ''}<status>${state}</status>\n<summary>${summary}</summary>\n<note>${note}</note>\n<result>Report.</result>\n<usage><subagent_tokens>${tokens}</subagent_tokens><tool_uses>7</tool_uses><duration_ms>60000</duration_ms></usage>\n</task-notification>`;
const enqueue = (content: string, minute: number) => ({ type: 'queue-operation', operation: 'enqueue', sessionId: sid, timestamp: at(minute), content });
const removed = (content: string, minute: number) => ({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', sessionId: sid, timestamp: at(minute), content });
const delivered = (content: string, minute: number) => ({ type: 'user', sessionId: sid, timestamp: at(minute), origin: { kind: 'task-notification' }, promptSource: 'system', message: { role: 'user', content } });
const absorbed = (content: string, minute: number) => ({ type: 'attachment', sessionId: sid, timestamp: at(minute),
  attachment: { type: 'queued_command', prompt: content, commandMode: 'task-notification', origin: { kind: 'task-notification' }, timestamp: at(minute) } });
const send = (tool: string, to: string, minute: number) => ({ ...call(tool, 'SendMessage', { to, summary: 'More work', message: 'Continue.' }), timestamp: at(minute) });
const resumed = (tool: string, agent: string, minute: number) => ({ ...result(tool, { success: true, message: `Resuming agent ${agent.slice(0, 7)}`, resumedAgentId: agent, revivedAgentId: agent }), timestamp: at(minute) });
const queued = (tool: string, agent: string, minute: number) => ({ ...result(tool, { success: true, message: `Message queued for delivery to ${agent} at its next tool round.` }), timestamp: at(minute) });
const agentState = (store: SessionActivityStore, id: string) => store.snapshot(true).find(item => item.taskId === id)!;

test('a background subagent completes once, however its notification is delivered', () => {
  const store = new SessionActivityStore(sid);
  const done = notice('a100', 'agent100', 'completed', 'Agent "Fixture a100" finished');
  store.ingest([...launch('agent100', 'a100', 0), enqueue(done, 10), delivered(done, 11)]);
  const item = agentState(store, 'a100');
  assert.equal(item.status, 'completed');
  assert.equal(item.endedAt, at(10), 'the end is the first observation, not the delivery');
  assert.equal(item.tokens, 1200);
  assert.equal(item.toolUses, 7);
  assert.equal(runningMs(item, Date.parse(at(30))), 10 * 60_000);
  assert.equal(activityTally(store.snapshot(true)), '1 完成');
});

test('SendMessage resumes a completed subagent until its next notification; time running excludes the pause', () => {
  const store = new SessionActivityStore(sid);
  // Absorbed into a running turn: removed from the queue, then an attachment with the enqueue time.
  const other = notice('a201', 'agent201', 'completed', 'Agent "Fixture a201" finished');
  store.ingest([...launch('agent200', 'a200', 0), ...launch('agent201', 'a201', 0), enqueue(other, 5), removed(other, 6), absorbed(other, 5)]);
  assert.equal(agentState(store, 'a201').status, 'completed');
  assert.equal(agentState(store, 'a201').endedAt, at(5));
  const first = notice('a200', 'agent200', 'completed', 'Agent "Fixture a200" finished', undefined, 1000);
  store.ingest([enqueue(first, 10)]);
  assert.equal(agentState(store, 'a200').status, 'completed');
  assert.equal(activityTally(store.snapshot(true)), '2 完成');
  // Resumed before its notification reached the model: the late delivery is the old run's.
  store.ingest([send('msg1', 'a200', 20), resumed('msg1', 'a200', 20), delivered(first, 21), absorbed(first, 10)]);
  let item = agentState(store, 'a200');
  assert.equal(item.status, 'running');
  assert.equal(item.endedAt, undefined);
  assert.equal(item.resumedAt, at(20));
  assert.equal(item.resumes, 1);
  assert.equal(runningMs(item, Date.parse(at(25))), 15 * 60_000, '10 minutes before the pause, 5 since the resume');
  assert.equal(activityTally(store.snapshot(true)), '1 运行中 · 1 完成');
  assert.equal(store.targets().some(target => target.taskId === 'a200'), true, 'its transcript is sampled again');
  // The turn that resumed it ended at minute 22 with the agent pending; it ends at 40.
  assert.equal(store.endedAgentsSince(at(22)), 0);
  // The end of a resumed run names the SendMessage call that resumed it (Claude Code 2.1.328).
  store.ingest([enqueue(notice('a200', 'unrelated', 'completed', 'Agent "Fixture a200" finished'), 30)]);
  assert.equal(agentState(store, 'a200').status, 'running', 'a tool id that is neither the launch nor a message to it');
  const second = notice('a200', 'msg1', 'completed', 'Agent "Fixture a200" finished', undefined, 3000);
  store.ingest([enqueue(second, 40), delivered(second, 40)]);
  item = agentState(store, 'a200');
  assert.equal(item.status, 'completed');
  assert.equal(item.endedAt, at(40));
  assert.equal(item.tokens, 3000);
  assert.equal(runningMs(item, Date.parse(at(59))), 30 * 60_000);
  assert.equal(store.endedAgentsSince(at(22)), 1, 'the resumed run counts against the later turn');
  assert.equal(store.endedAgentsSince(at(15)), 0, 'not against a turn between its first end and the resume');
  assert.equal(activityTally(store.snapshot(true)), '2 完成');
});

test('a subagent stopped when the previous process ended runs again after a resume in the new process', () => {
  const store = new SessionActivityStore(sid);
  const stopped = notice('a300', undefined, 'stopped', 'Background agent "Fixture a300" didn\'t finish before the previous session ended',
    'No completion record was found for it. Send it another message with SendMessage to resume it.');
  store.ingest([...launch('agent300', 'a300', 0), enqueue(stopped, 30), delivered(stopped, 30)]);
  assert.equal(agentState(store, 'a300').status, 'stopped');
  const restarted = Date.parse(at(29));
  assert.deepEqual(backgroundCounts(store.snapshot(true), undefined, 'idle', restarted), { shells: 0, agents: 0, monitors: 0, workflows: 0 });
  store.ingest([send('msg3', 'a300', 35), resumed('msg3', 'a300', 35)]);
  const item = agentState(store, 'a300');
  assert.equal(item.status, 'running');
  // Launched before this process started, resumed in it: it keeps the chat in "后台运行中".
  assert.equal(backgroundSummary(store.snapshot(true), { agents: 1, workflows: 0, at: at(36) }, 'busy', restarted), '1 个子代理仍在运行');
  assert.equal(backgroundCounts(store.snapshot(true), undefined, 'busy', restarted).agents, 1);
});

test('an interim notification while the subagent waits on its own background work keeps it running', () => {
  const store = new SessionActivityStore(sid);
  const interim = notice('a400', 'agent400', 'completed', 'Agent "Fixture a400" is waiting on its own background work',
    'This agent stopped with background work of its own still running. It may resume on its own when that work completes or reports; the result below may be interim.');
  store.ingest([...launch('agent400', 'a400', 0), enqueue(interim, 10), delivered(interim, 10)]);
  let item = agentState(store, 'a400');
  assert.equal(item.status, 'running');
  assert.equal(item.summary, undefined, 'an interim result is not the report');
  assert.deepEqual(item.events.map(event => event.text), ['Agent "Fixture a400" is waiting on its own background work']);
  const done = notice('a400', undefined, 'completed', 'Agent "Fixture a400" finished');
  store.ingest([enqueue(done, 15), delivered(done, 15)]);
  item = agentState(store, 'a400');
  assert.equal(item.status, 'completed');
  assert.equal(item.endedAt, at(15));
});

test('a message queued for a running subagent changes nothing; failed or unrelated messages resume nothing', () => {
  const store = new SessionActivityStore(sid);
  store.ingest([...launch('agent500', 'a500', 0), ...launch('agent501', 'a501', 0), send('msg5', 'a500', 5), queued('msg5', 'a500', 5)]);
  assert.equal(agentState(store, 'a500').status, 'running');
  assert.equal(agentState(store, 'a500').resumes, undefined);
  const done = notice('a501', 'agent501', 'completed', 'Agent "Fixture a501" finished');
  store.ingest([enqueue(done, 6), delivered(done, 6)]);
  store.ingest([send('msg6', 'a501', 7), { ...result('msg6', { success: false, message: 'No agent named a501' }), timestamp: at(7) },
    send('msg7', 'a501', 8), { ...result('msg7', {}, true), timestamp: at(8) },
    send('msg8', 'a501', 9), queued('msg8', 'a501', 9),
    send('msg9', 'teammate', 9), resumed('msg9', 'unknown01', 9)]);
  assert.equal(agentState(store, 'a501').status, 'completed');
  assert.equal(agentState(store, 'a501').endedAt, at(6));
});

test('older records: notification only as an attachment, resume results shared in one record or without the agent field', () => {
  const store = new SessionActivityStore(sid);
  const done = notice('a600', 'agent600', 'completed', 'Agent "Fixture a600" finished');
  store.ingest([...launch('agent600', 'a600', 0), ...launch('agent601', 'a601', 0), absorbed(done, 10),
    absorbed(notice('a601', 'agent601', 'completed', 'Agent "Fixture a601" finished'), 10)]);
  assert.equal(agentState(store, 'a600').status, 'completed');
  // Two SendMessage results in one record: no toolUseResult, the result text is the JSON.
  const text = (agent: string) => JSON.stringify({ success: true, message: `Resuming agent ${agent.slice(0, 4)}`, resumedAgentId: agent });
  store.ingest([send('msg10', 'a600', 20), send('msg11', 'a601', 20), { type: 'user', sessionId: sid, timestamp: at(20), message: { content: [
    { type: 'tool_result', tool_use_id: 'msg10', content: [{ type: 'text', text: text('a600') }] },
    { type: 'tool_result', tool_use_id: 'msg11', content: 'Resuming agent a601' }] } }]);
  assert.equal(agentState(store, 'a600').status, 'running');
  assert.equal(agentState(store, 'a601').status, 'running', 'the short id in "Resuming agent" names the recipient');
  assert.equal(agentState(store, 'a601').resumedAt, at(20));
});
