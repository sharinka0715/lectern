import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageDisplay } from '../src/core/message-display';
import { SessionActivityStore } from '../src/core/session-activity';
import { subagentEntries } from '../src/renderer/subagent-entries';
import type { JsonRecord } from '../src/core/jsonl';
import type { SubagentFile } from '../src/shared/types';

// The activity card (subagents, background shells, monitors) and the attachments
// must depend only on the conversation's records in order, never on how they were
// loaded: the newest page first and older pages one by one (Controller), live polls
// in small reads, or everything at once. Synthetic records with the shapes Claude
// Code 2.1.300–2.1.330 write; nothing here comes from a real session.
const sid = '00000000-0000-4011-8011-0000000000b1';
const agentA = 'aaaa000000000001', agentB = 'bbbb000000000002';
const pad = (n: number) => String(n).padStart(2, '0');
const at = (minute: number) => `2026-01-01T04:${pad(minute)}:00.000Z`;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function conversation() {
  let parent: string | null = null, n = 0;
  const rows: JsonRecord[] = [];
  const row = (type: string, minute: number, fields: JsonRecord) => {
    const uuid = `rec-${pad(++n)}`;
    rows.push({ type, uuid, parentUuid: parent, sessionId: sid, cwd: '/work', version: '2.1.330', timestamp: at(minute), ...fields });
    parent = uuid;
  };
  const queue = (operation: string, minute: number, content: string) =>
    rows.push({ type: 'queue-operation', operation, sessionId: sid, timestamp: at(minute), content });
  const prompt = (minute: number, text: string, image = false) => row('user', minute, { origin: { kind: 'human' }, promptSource: 'typed',
    message: { role: 'user', content: image ? [{ type: 'text', text }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] : text } });
  const call = (minute: number, id: string, name: string, input: JsonRecord) => row('assistant', minute,
    { message: { id: 'msg-' + id, role: 'assistant', model: 'claude-fixture', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] } });
  const result = (minute: number, id: string, toolUseResult: JsonRecord, text = 'ok') => row('user', minute,
    { toolUseResult, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
  const reply = (minute: number, text: string, pending?: number) => {
    row('assistant', minute, { message: { id: 'msg-reply-' + minute, role: 'assistant', model: 'claude-fixture', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
    row('system', minute, { subtype: 'turn_duration', durationMs: 1000, messageCount: n, ...(pending && { pendingBackgroundAgentCount: pending }) });
  };
  const delivered = (minute: number, content: string) => row('user', minute, { origin: { kind: 'task-notification' }, promptSource: 'system', message: { role: 'user', content } });
  const absorbed = (minute: number, enqueued: number, content: string) => row('attachment', minute,
    { attachment: { type: 'queued_command', prompt: content, commandMode: 'task-notification', origin: { kind: 'task-notification' }, timestamp: at(enqueued) } });
  return { rows, row, queue, prompt, call, result, reply, delivered, absorbed };
}

const notice = (task: string, tool: string | undefined, status: string | undefined, summary: string, extra = '') =>
  `<task-notification>\n<task-id>${task}</task-id>\n${tool ? `<tool-use-id>${tool}</tool-use-id>\n` : ''}${status ? `<status>${status}</status>\n` : ''}<summary>${summary}</summary>${extra}\n</task-notification>`;
const report = (text: string, tokens: number) => `\n<result>${text}</result>\n<usage><subagent_tokens>${tokens}</subagent_tokens><tool_uses>3</tool_uses><duration_ms>60000</duration_ms></usage>`;
const interim = (task: string, tool?: string) => notice(task, tool, 'completed', `Agent "Fixture ${task}" is waiting on its own background work`,
  '\n<note>This agent stopped with background work of its own still running. It may resume on its own when that work completes or reports, and the same task-id notifies again if it does; the result below may be interim.</note>' + report('Interim.', 900));

/** Two subagents launched, finished, resumed (one ends with interim notices only, one is
 * still running), a background shell that completes and one still running, a monitor with
 * an event that TaskStop ends, a late delivery after a resume, and two image attachments. */
function session(): JsonRecord[] {
  const c = conversation();
  c.prompt(0, 'Start the background work', true);
  c.call(0, 'toolu_agentA', 'Agent', { description: 'Fixture review', prompt: 'Review the code.', subagent_type: 'general-purpose', run_in_background: true });
  c.call(0, 'toolu_shellA', 'Bash', { command: 'npm test', description: 'Run tests', run_in_background: true });
  c.call(0, 'toolu_monA', 'Monitor', { command: 'tail -f build.log', description: 'Watch the build log' });
  c.result(0, 'toolu_agentA', { isAsync: true, status: 'async_launched', agentId: agentA, description: 'Fixture review' });
  c.result(0, 'toolu_shellA', { backgroundTaskId: 'bshella01' });
  c.result(0, 'toolu_monA', { taskId: 'bmona0001' });
  c.reply(1, 'Started three tasks.', 1);
  const event = notice('bmona0001', 'toolu_monA', undefined, 'Monitor event: "Watch the build log"', '\n<event>line one</event>');
  c.queue('enqueue', 3, event); c.delivered(3, event); c.reply(3, 'Noted the log line.', 1);
  const tests = notice('bshella01', 'toolu_shellA', 'completed', 'Background command "Run tests" completed (exit code 0)');
  c.queue('enqueue', 5, tests); c.delivered(5, tests); c.reply(5, 'Tests passed.', 1);
  c.prompt(8, 'Start another helper');
  c.call(8, 'toolu_agentB', 'Agent', { description: 'Fixture docs', prompt: 'Check the docs.', subagent_type: 'Explore', run_in_background: true });
  c.result(8, 'toolu_agentB', { isAsync: true, status: 'async_launched', agentId: agentB, description: 'Fixture docs' });
  c.reply(8, 'The second helper runs.', 2);
  const doneA = notice(agentA, 'toolu_agentA', 'completed', 'Agent "Fixture review" finished', report('Review report.', 1000));
  c.queue('enqueue', 12, doneA); c.delivered(13, doneA); c.reply(13, 'The review is in.', 1);
  // Its delivery comes only after the resume below: the first observation counts.
  const doneB = notice(agentB, 'toolu_agentB', 'completed', 'Agent "Fixture docs" finished', report('Docs report.', 2000));
  c.queue('enqueue', 14, doneB);
  c.prompt(20, 'Ask the reviewer for more');
  c.call(20, 'toolu_sendA', 'SendMessage', { to: agentA, summary: 'More', message: 'Look at the tests too.' });
  c.result(20, 'toolu_sendA', { success: true, message: `Resuming agent ${agentA.slice(0, 7)}`, resumedAgentId: agentA, revivedAgentId: agentA });
  c.call(22, 'toolu_stopMon', 'TaskStop', { task_id: 'bmona0001' });
  c.result(22, 'toolu_stopMon', { message: 'Stopped task bmona0001', task_id: 'bmona0001' });
  c.queue('enqueue', 22, notice('bmona0001', 'toolu_monA', 'killed', 'Monitor "Watch the build log" stopped'));
  c.reply(23, 'Asked for more and stopped the monitor.', 2);
  // The resumed run ends with two interim notices and no final one (2.1.329).
  const firstWait = interim(agentA, 'toolu_sendA'), secondWait = interim(agentA);
  c.queue('enqueue', 30, firstWait); c.queue('enqueue', 31, secondWait);
  c.queue('remove', 32, firstWait); c.queue('remove', 32, secondWait);
  c.absorbed(32, 30, firstWait); c.absorbed(32, 31, secondWait);
  c.reply(33, 'The reviewer reported again.', 1);
  c.prompt(40, 'Here is a screenshot; resume the docs helper', true);
  c.call(40, 'toolu_sendB', 'SendMessage', { to: agentB, summary: 'More', message: 'Add the screenshot.' });
  c.result(40, 'toolu_sendB', { success: true, message: `Resuming agent ${agentB.slice(0, 7)}`, resumedAgentId: agentB, revivedAgentId: agentB });
  c.delivered(41, doneB);
  c.call(42, 'toolu_shellB', 'Bash', { command: 'npm run build', description: 'Build', run_in_background: true });
  c.result(42, 'toolu_shellB', { backgroundTaskId: 'bshellb02' });
  c.reply(43, 'The docs helper and a build run.', 1);
  return c.rows;
}
const encode = (rows: JsonRecord[]) => Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');

const read = (rows: JsonRecord[]) => { const display = new MessageDisplay(sid); display.ingestJsonl(encode(rows), true, false); return display; };
const attachments = (display: MessageDisplay) => display.getMessages().flatMap(message => message.attachments ?? []).map(file => file.id);
// The transcript files the column lists: Claude Code wrote `finished` after the reviewer's last run.
const files: SubagentFile[] = [{ agentId: agentA, size: 1, description: 'Fixture review', toolUseId: 'toolu_agentA', finished: true },
  { agentId: agentB, size: 1, description: 'Fixture docs', toolUseId: 'toolu_agentB' }];

/** Opens at record `cut` and loads older pages of `size` records, as Controller does. */
function paged(rows: JsonRecord[], cut: number, size: number, check: (display: MessageDisplay, start: number) => void) {
  const display = new MessageDisplay(sid);
  display.ingestJsonl(encode(rows.slice(cut)), true, cut > 0);
  check(display, cut);
  for (let end = cut; end > 0;) {
    const start = Math.max(0, end - size);
    display.prependJsonl(encode(rows.slice(start, end)), start > 0, true, true);
    check(display, start);
    end = start;
  }
  return display;
}

test('the activity a full read reconstructs: resumes, interim ends, a late delivery, shells, a monitor and attachments', () => {
  const full = read(session());
  const item = (id: string) => full.activity.snapshot(true).find(entry => entry.id === id)!;
  assert.deepEqual([item('toolu_agentA').status, item('toolu_agentA').resumes, item('toolu_agentA').resumedAt, item('toolu_agentA').endedAt, item('toolu_agentA').priorRunMs],
    ['completed', 1, at(20), at(31), 12 * 60_000], 'the reviewer ended with its interim notices; the attachments written later are older');
  assert.deepEqual([item('toolu_agentB').status, item('toolu_agentB').resumes, item('toolu_agentB').resumedAt, item('toolu_agentB').endedAt, item('toolu_agentB').priorRunMs],
    ['running', 1, at(40), undefined, 6 * 60_000], 'the delivery after the resume belongs to the run before it');
  assert.deepEqual([item('toolu_shellA').status, item('toolu_shellA').exitCode, item('toolu_shellA').endedAt], ['completed', 0, at(5)]);
  assert.deepEqual([item('toolu_monA').status, item('toolu_monA').endedAt, item('toolu_monA').events.map(event => event.text)], ['stopped', at(22), ['line one']]);
  assert.equal(item('toolu_shellB').status, 'running');
  assert.equal(attachments(full).length, 2);
});

test('every opening page and every page size reconstruct the same activity as a full read', () => {
  const rows = session(), full = read(rows);
  const expected = new Map(full.activity.snapshot(true).map(item => [item.id, item]));
  const finalStatus = new Map(full.activity.snapshot(true).map(item => [item.taskId, item.status]));
  for (const size of [1, 2, 5, 17]) for (let cut = 1; cut < rows.length; cut++) {
    const display = paged(rows, cut, size, (shown, start) => {
      const where = `opened at record ${cut}, pages of ${size}, loaded from ${start}`;
      // A subagent, shell or monitor shown at all already has its whole lifecycle loaded.
      for (const item of shown.activity.snapshot(true)) assert.deepEqual(item, expected.get(item.id), `${where}: ${item.title}`);
      // The column: one listed from its meta file as finished must not show otherwise once loaded.
      for (const entry of subagentEntries(shown.activity.snapshot(true), files)) {
        if (entry.item || entry.status === 'completed') assert.equal(entry.status, finalStatus.get(entry.agentId), `${where}: column ${entry.title}`);
      }
    });
    assert.deepEqual(display.activity.snapshot(true), full.activity.snapshot(true), `opened at record ${cut}, pages of ${size}`);
    assert.deepEqual(attachments(display), attachments(full));
    assert.deepEqual(display.pendingBackground, full.pendingBackground);
  }
});

test('live polls in small reads reconstruct the same activity as one read', () => {
  const data = encode(session()), full = read(session());
  for (const step of [37, 512, 4096]) {
    const live = new MessageDisplay(sid);
    live.ingestJsonl(Buffer.alloc(0), true, false);
    for (let offset = 0; offset < data.length; offset += step) live.ingestJsonl(data.subarray(offset, offset + step));
    assert.deepEqual(live.activity.snapshot(true), full.activity.snapshot(true), `reads of ${step} bytes`);
    assert.deepEqual(attachments(live), attachments(full));
  }
});

test('a subagent resumed after more than 128 later tool calls is resumed however the records were read', () => {
  // The card keeps the newest 128 tasks; an ended shell can go, a subagent cannot:
  // SendMessage may resume it at any time.
  const c = conversation();
  c.prompt(0, 'Start the helper');
  c.call(0, 'toolu_old', 'Agent', { description: 'Fixture old helper', prompt: 'Work.', subagent_type: 'general-purpose', run_in_background: true });
  c.result(0, 'toolu_old', { isAsync: true, status: 'async_launched', agentId: agentA });
  c.queue('enqueue', 2, notice(agentA, 'toolu_old', 'completed', 'Agent "Fixture old helper" finished', report('Done.', 100)));
  for (let i = 0; i < 140; i++) { c.call(3, `toolu_sh${i}`, 'Bash', { command: `echo ${i}` }); c.result(3, `toolu_sh${i}`, { stdout: String(i) }); }
  c.call(50, 'toolu_wake', 'SendMessage', { to: agentA, summary: 'More', message: 'One more thing.' });
  c.result(50, 'toolu_wake', { success: true, message: `Resuming agent ${agentA.slice(0, 7)}`, resumedAgentId: agentA });
  const whole = new SessionActivityStore(sid), oneByOne = new SessionActivityStore(sid);
  whole.ingest(c.rows);
  for (const row of c.rows) oneByOne.ingest([row]);
  assert.deepEqual(oneByOne.snapshot(true), whole.snapshot(true));
  const old = whole.snapshot(true).find(item => item.id === 'toolu_old')!;
  assert.deepEqual([old.status, old.resumes, old.resumedAt], ['running', 1, at(50)]);
  assert.equal(whole.snapshot(true).length, 128);
});
