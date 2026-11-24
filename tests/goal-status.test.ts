import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { MessageDisplay } from '../src/core/message-display';
import { GoalTracker } from '../src/core/goal-status';
import { goalCheckinOf, goalEventOf } from '../src/core/goal-records';
import { observeGoal } from '../src/main/goal-observation';
import { recordRow } from '../src/core/transcript-store';
import type { JsonRecord } from '../src/core/jsonl';
import { replyParts } from '../src/renderer/reply-activities';

// Claude Code's native /goal from its records (core/goal-status.ts, goal-records.ts): real
// sessions of 2.1.331 and 2.1.300 (placeholder conditions, sandbox paths) and synthetic ones.
const load = (path: string) => readFileSync(new URL(`./fixtures/${path}`, import.meta.url), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as JsonRecord);
const encode = (rows: JsonRecord[]) => Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
const read = (sid: string, rows: JsonRecord[]) => { const display = new MessageDisplay(sid); display.ingestJsonl(encode(rows), true, false); return display; };
const events = (display: MessageDisplay) => display.getMessages().filter(m => m.role === 'assistant')
  .map(m => (m.taskNotifications ?? []).map(n => n.goal ? n.goal.kind + (n.goal.count ? '×' + n.goal.count : '') : 'task').join(' '));
const sidOf = (rows: JsonRecord[]) => rows.find(row => typeof row.sessionId === 'string')!.sessionId as string;

test('a real 2.1.331 session: each goal is one turn of its own with its set, checks and end', () => {
  for (const file of ['goal-2.1.331/session.jsonl', 'goal-2.1.300/session.jsonl']) {
    const rows = load(file), display = read(sidOf(rows), rows);
    const users = display.getMessages().filter(m => m.role === 'user').map(m => m.text);
    assert.deepEqual(users, ['Finish the two-step task', 'Stay active until cleared', 'Impossible case', 'Evaluator error case', 'Never satisfied case',
      'Rejected request case', 'Survive resume case', 'Survive compact case', 'Survive clear-cmd case'].map(c => `/goal ${c} ccm:g`), file);
    assert.deepEqual(events(display), ['set not-met met', 'set not-met cleared', 'set failed', 'set retry cleared', 'set not-met×4 paused cleared',
      'set retry cleared', 'set not-met cleared', 'set not-met cleared', 'set not-met'], file);
    // The CLI's own rule: the last goal record is a not-met check, so the goal is still active (/clear wrote no record).
    assert.deepEqual(display.goals.current, { status: 'active', phase: 'not-met', condition: 'Survive clear-cmd case ccm:g', checks: 1,
      setAt: display.goals.current?.setAt, lastReason: 'step two is not reported done yet', lastCheckAt: display.goals.current?.lastCheckAt }, file);
    assert.ok(display.goals.current?.setAt && display.goals.current.lastCheckAt, file);
    // Nothing of the goal reads as a prompt: hook prompts, feedback and stop hook summaries stay hidden.
    assert.ok(!display.getMessages().some(m => /Stop hook|session-scoped|<task-notification>|<system-reminder>/u.test(m.text)), file);
  }
});

test('the background check-in (2.1.331): deferred with its tasks, then met by the next check', () => {
  const rows = load('goal-2.1.331/checkin.jsonl'), sid = sidOf(rows);
  assert.deepEqual(events(read(sid, rows)), ['set checkin task met']);
  const cut = rows.findIndex(row => row.type === 'user' && (row.origin as JsonRecord | undefined)?.kind === 'task-notification');
  const deferred = read(sid, rows.slice(0, cut + 1)).goals.current!;
  assert.equal(deferred.phase, 'deferred');
  assert.equal(deferred.deferred?.minutes, 1);
  assert.match(deferred.deferred?.tasks[0] ?? '', /^\w+ · shell · sleep 80$/u);
  assert.equal(read(sid, rows).goals.current?.status, 'met');
  assert.deepEqual(read(sid, rows).goals.current?.result, { reason: 'the assistant reported both steps done', iterations: 1, durationMs: 80145, tokens: 120 });
});

/** Opens at record `cut` and loads older pages of `size` records, as Controller does. */
function paged(sid: string, rows: JsonRecord[], cut: number, size: number) {
  const display = new MessageDisplay(sid);
  display.ingestJsonl(encode(rows.slice(cut)), true, cut > 0);
  for (let end = cut; end > 0;) {
    const start = Math.max(0, end - size);
    display.prependJsonl(encode(rows.slice(start, end)), start > 0, true, true);
    end = start;
  }
  return display;
}

test('the goal and its rows depend only on the records, never on how they were read', () => {
  for (const file of ['goal-2.1.331/session.jsonl', 'goal-2.1.331/checkin.jsonl', 'goal-2.1.300/session.jsonl', 'goal-2.1.300/out-of-order-session.jsonl']) {
    const rows = load(file), sid = sidOf(rows), full = read(sid, rows);
    const shown = (display: MessageDisplay) => display.getMessages().map(m => [m.role, m.text, m.taskNotifications]);
    // Live polls in small reads, split inside records.
    const live = new MessageDisplay(sid), bytes = encode(rows);
    live.ingestJsonl(Buffer.alloc(0), true, false);
    for (let at = 0; at < bytes.length; at += 997) live.ingestJsonl(bytes.subarray(at, at + 997));
    assert.deepEqual(live.goals.current, full.goals.current, `${file}: small reads`);
    assert.deepEqual(shown(live), shown(full), `${file}: small reads`);
    for (const size of [1, 7, 40]) for (let cut = 1; cut < rows.length; cut += 3) {
      const display = paged(sid, rows, cut, size), where = `${file}: opened at ${cut}, pages of ${size}`;
      assert.deepEqual(display.goals.current, full.goals.current, where);
      assert.deepEqual(events(display), events(full), where);
    }
  }
});

// Matrix CI (2.1.300, goal-lifecycle): Claude Code wrote a new session's first turn (the set record, the
// /goal command, its echo, the reply) after the Stop hook feedback and the not-met check that follow it,
// parents intact: the file begins with the feedback. The chat's rows follow the chain (set, not-met); the
// capsule read the file's order, ended on the set record and showed "set" for the whole held turn.
const lastEvent = (display: MessageDisplay) => display.getMessages().flatMap(m => m.taskNotifications ?? []).flatMap(n => n.goal?.kind ?? []).at(-1);
const capsule = (display: MessageDisplay) => { const goal = display.goal?.current; return goal && (goal.status === 'active' ? goal.phase : goal.status); };
/** The capsule says what the chat's last goal row says (a set record's row waits for its command's turn, the capsule does not). */
const agrees = (display: MessageDisplay, where: string) => {
  const shown = capsule(display), row = lastEvent(display);
  assert.ok(shown === row || shown === 'set' && row === undefined, `${where}: the capsule ${shown}, the chat ${row}`);
};

test('records written out of order (2.1.300): the goal follows the conversation, as its rows do, however it is read', () => {
  const rows = load('goal-2.1.300/out-of-order-session.jsonl'), sid = sidOf(rows);
  assert.deepEqual(rows.flatMap(row => goalEventOf(row)?.goal.kind ?? []), ['not-met', 'set', 'met'], 'the file: the check before its setting');
  // Held: the second reply (13 KB) not written yet.
  const held = rows.slice(0, rows.findIndex(row => row.type === 'assistant' && JSON.stringify(row).length > 8000));
  const full = read(sid, held), goal = full.goals.current!;
  assert.deepEqual(events(full), ['set not-met']);
  assert.deepEqual([goal.status, goal.phase, goal.checks, goal.lastReason], ['active', 'not-met', 1, 'the transcript does not show the last step yet']);
  assert.equal(goal.setAt, held.find(row => (row.attachment as JsonRecord | undefined)?.sentinel)!.timestamp);
  // As Lectern read it (the last 128 KiB, then the page before it with the feedback), any page size, small live reads:
  // after each read the capsule says what the chat's last goal row says.
  for (const size of [1, 3, 40]) for (let cut = 1; cut < held.length; cut++) {
    const display = new MessageDisplay(sid), where = `opened at ${cut}, pages of ${size}`;
    display.ingestJsonl(encode(held.slice(cut)), true, true);
    agrees(display, where);
    for (let end = cut; end > 0;) {
      const start = Math.max(0, end - size);
      display.prependJsonl(encode(held.slice(start, end)), start > 0, true, true);
      agrees(display, `${where}, to ${start}`);
      end = start;
    }
    assert.deepEqual([display.goals.current, events(display)], [goal, ['set not-met']], where);
  }
  const live = new MessageDisplay(sid), bytes = encode(held);
  live.ingestJsonl(Buffer.alloc(0), true, false);
  for (let at = 0; at < bytes.length; at += 997) {
    live.ingestJsonl(bytes.subarray(at, at + 997));
    agrees(live, `small reads to ${at}`);
  }
  assert.deepEqual(live.goals.current, goal, 'small reads');
  // Released: met by the second check, after one that was not.
  const done = read(sid, rows).goals.current!;
  assert.deepEqual([done.status, done.checks, done.lastReason, done.result?.iterations], ['met', 1, 'the transcript does not show the last step yet', 2]);
});

// These files are written in the conversation's order (out-of-order-session.jsonl is not: see above).
test("every prefix of the records follows Claude Code's own rule: the last goal record decides", () => {
  for (const file of ['goal-2.1.331/session.jsonl', 'goal-2.1.300/session.jsonl', 'goal-2.1.331/checkin.jsonl']) {
    const rows = load(file), tracker = new GoalTracker();
    let last: JsonRecord | undefined;
    for (const [i, row] of rows.entries()) {
      tracker.ingest([recordRow(row)]);
      const attached = row.attachment as JsonRecord | undefined;
      if (row.type === 'attachment' && attached?.type === 'goal_status') last = attached;
      const active = !!last && last.met === false && !last.failed;
      assert.equal(tracker.current?.status === 'active', active, `${file} record ${i}`);
      if (active) assert.equal(tracker.current?.condition, last!.condition, `${file} record ${i}`);
    }
  }
});

test('goal rows never change the rewind list Claude Code shows', () => {
  for (const file of ['goal-2.1.331/session.jsonl', 'goal-2.1.300/session.jsonl', 'goal-2.1.331/checkin.jsonl']) {
    const rows = load(file), sid = sidOf(rows);
    // The same conversation as Lectern showed it before: each goal record an attachment it does not show.
    const plain = rows.map(row => goalEventOf(row) ? { ...row, type: 'attachment', attachment: { type: 'hidden_fixture' }, content: undefined } : row);
    assert.deepEqual(read(sid, rows).rewindPoints(), read(sid, plain).rewindPoints(), file);
  }
});

// Synthetic records with Claude Code's shapes (research §3).
const SID = '00000000-0000-4011-8011-00000000g0a1'.replace('g', '0');
function conversation() {
  let parent: string | null = null, n = 0;
  const rows: JsonRecord[] = [];
  const row = (type: string, fields: JsonRecord) => {
    const uuid = `goal-${String(++n).padStart(3, '0')}`;
    rows.push({ type, uuid, parentUuid: parent, sessionId: SID, isSidechain: false, timestamp: `2026-11-24T01:${String(n).padStart(2, '0')}:00.000Z`, ...fields });
    parent = uuid;
  };
  const status = (fields: JsonRecord) => row('attachment', { attachment: { type: 'goal_status', ...fields } });
  const command = (args: string) => row('user', { message: { role: 'user', content: `<command-name>/goal</command-name>\n            <command-message>goal</command-message>\n            <command-args>${args}</command-args>` } });
  const set = (condition: string) => { status({ met: false, sentinel: true, condition }); command(condition);
    row('user', { message: { role: 'user', content: `<local-command-stdout>Goal set: ${condition}</local-command-stdout>` } });
    row('user', { isMeta: true, message: { role: 'user', content: `A session-scoped Stop hook is now active with condition: "${condition}".` } }); };
  const reply = (text: string) => row('assistant', { message: { id: 'msg-' + n, role: 'assistant', model: 'claude-fixture', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
  const notMet = (condition: string, reason: string) => { row('user', { isMeta: true, message: { role: 'user', content: `Stop hook feedback:\n[${condition}]: ${reason}` } }); status({ met: false, condition, reason }); };
  const notice = (content: string) => row('system', { subtype: 'informational', content, level: 'notice', isMeta: false });
  const prompt = (text: string) => row('user', { origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: text } });
  const compact = () => row('system', { subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'manual', durationMs: 30 } });
  return { rows, row, status, command, set, reply, notMet, notice, prompt, compact };
}

test('a merged goal check stays at the first check, between the surrounding reply parts', () => {
  const c = conversation();
  c.set('Finish the sample');
  c.reply('First attempt.');
  c.notMet('Finish the sample', 'The first step is missing.');
  c.reply('Second attempt.');
  c.notMet('Finish the sample', 'The second step is missing.');
  c.reply('Final attempt.');
  const message = read(SID, c.rows).getMessages().at(-1)!;
  for (const compact of [true, false]) {
    const parts = replyParts(message, compact).flatMap(part => part.kind === 'text' ? [part.text.trim()]
      : part.kind === 'notice' ? [part.notice.goal!.kind + (part.notice.goal!.count ?? '')] : []);
    assert.deepEqual(parts, ['set', 'First attempt.', 'not-met2', 'Second attempt.\n\nFinal attempt.']);
  }
});
const checkinText = (condition: string) => `<task-notification>\n<summary>Goal check-in: background work still running</summary>\n</task-notification>\n<system-reminder>\nGoal check-in: «${condition}» is still active, and evaluation has been deferred for 30 min because background work is still running:\n- b1 · shell · npm test\n- a2 · subagent · Review the docs\nCheck on their progress.\n</system-reminder>`;

test('a compaction restates the goal: checks and setting time stay; a /goal after it is a new setting', () => {
  const c = conversation();
  c.set('Ship it'); c.reply('Working.'); c.notMet('Ship it', 'not shipped'); c.reply('Still working.');
  const before = read(SID, c.rows).goals.current!;
  c.compact(); c.status({ met: false, sentinel: true, condition: 'Ship it' });
  const after = read(SID, c.rows);
  assert.deepEqual(after.goals.current, before, 'the same goal goes on');
  assert.deepEqual(events(after), ['set not-met'], 'no second setting row');
  // Opened after the compaction: the restated record alone is the goal, without a setting time.
  const restated = read(SID, c.rows.slice(c.rows.findIndex(row => row.subtype === 'compact_boundary'))).goals.current!;
  assert.deepEqual([restated.status, restated.phase, restated.setAt, restated.checks], ['active', 'set', undefined, 0]);
  // A /goal right after a compaction is a setting of its own.
  c.compact(); c.set('Ship it'); c.reply('Again.');
  const again = read(SID, c.rows);
  assert.equal(again.goals.current?.checks, 0);
  assert.equal(again.goals.current?.setAt, c.rows.at(-5)!.timestamp);
  assert.deepEqual(events(again).at(-1), 'set');
});

test('check-ins: delivered, absorbed or bare; never a user bubble; the deferral and its tasks', () => {
  const parsed = goalCheckinOf(checkinText('Ship it'));
  assert.deepEqual(parsed, { kind: 'checkin', notice: 'Goal check-in: background work still running', condition: 'Ship it', minutes: 30,
    tasks: ['b1 · shell · npm test', 'a2 · subagent · Review the docs'] });
  for (const shape of ['delivered', 'no-origin', 'meta', 'absorbed'] as const) {
    const c = conversation();
    c.set('Ship it'); c.reply('Started the tests in the background.');
    const text = checkinText('Ship it'), bare = text.slice(text.indexOf('Goal check-in: «'), text.lastIndexOf('\n</system-reminder>'));
    if (shape === 'delivered') c.row('user', { origin: { kind: 'task-notification' }, promptSource: 'system', queueOrigin: { kind: 'task-notification', source: 'goal-checkin' }, message: { role: 'user', content: text } });
    if (shape === 'no-origin') c.row('user', { message: { role: 'user', content: text } });
    if (shape === 'meta') c.row('user', { isMeta: true, rowSource: 'harness', message: { role: 'user', content: bare } });
    if (shape === 'absorbed') c.row('attachment', { attachment: { type: 'queued_command', prompt: text, commandMode: 'task-notification', origin: { kind: 'task-notification' } } });
    c.reply('Still running; waiting.');
    const display = read(SID, c.rows);
    assert.deepEqual(display.getMessages().map(m => m.role), ['user', 'assistant'], shape);
    assert.deepEqual(events(display), ['set checkin'], shape);
    const goal = display.goals.current!;
    assert.deepEqual([goal.phase, goal.deferred?.minutes, goal.deferred?.tasks.length], ['deferred', 30, 2], shape);
  }
  // The same check-in delivered twice in a row (absorbed, then delivered) is one row.
  const c = conversation(); c.set('Ship it'); c.reply('Waiting.');
  c.row('attachment', { attachment: { type: 'queued_command', prompt: checkinText('Ship it'), commandMode: 'task-notification' } });
  c.row('user', { origin: { kind: 'task-notification' }, message: { role: 'user', content: checkinText('Ship it') } });
  assert.deepEqual(events(read(SID, c.rows)), ['set checkin']);
});

test("Claude Code's notices: retrying and paused until the next message; an error's clearing is one row", () => {
  const c = conversation();
  c.set('Ship it'); c.reply('Done step one.');
  c.notice('Goal still active · the goal check could not complete · retrying in 1 min (1/3) · send a message to retry now');
  assert.deepEqual([read(SID, c.rows).goals.current?.phase, read(SID, c.rows).goals.current?.notice?.slice(0, 17)], ['retrying', 'Goal still active']);
  c.notMet('Ship it', 'still missing');
  c.notice('Goal paused · goal checks kept finding it unmet this turn · send a message to continue');
  assert.equal(read(SID, c.rows).goals.current?.phase, 'paused');
  c.prompt('Go on please.');
  const resumed = read(SID, c.rows).goals.current!;
  assert.deepEqual([resumed.status, resumed.phase, resumed.notice], ['active', 'not-met', undefined]);
  c.reply('On it.');
  c.notice('Goal cleared after an unrecoverable error (authentication): "Ship it". Run /goal again to continue.');
  c.status({ met: true, sentinel: true, condition: 'Ship it' });
  const display = read(SID, c.rows), cleared = display.goals.current!;
  assert.deepEqual([cleared.status, /unrecoverable error/u.test(cleared.notice ?? '')], ['cleared', true]);
  assert.deepEqual(events(display), ['set retry not-met paused', 'cleared']);
  const row = display.getMessages().at(-1)!.taskNotifications!.at(-1)!.goal!;
  assert.deepEqual([row.kind, row.condition, /unrecoverable/u.test(row.notice ?? '')], ['cleared', 'Ship it', true]);
});

test('an ended goal shows until the next prompt; sidechains and other sessions never count; a busy clear stays in its turn', () => {
  const c = conversation();
  c.set('Ship it'); c.reply('Working.');
  // Off the conversation's chain: a subagent's record, another session's.
  c.rows.push({ type: 'attachment', uuid: 'side-1', parentUuid: null, sessionId: SID, isSidechain: true, attachment: { type: 'goal_status', met: true, condition: 'Ship it', reason: 'a subagent' } },
    { type: 'attachment', uuid: 'other-1', parentUuid: null, sessionId: '00000000-0000-4011-8011-000000000bad', attachment: { type: 'goal_status', met: true, condition: 'Ship it', reason: 'elsewhere' } });
  assert.equal(read(SID, c.rows).goals.current?.status, 'active');
  // Claude Code busy: `/goal clear` writes only the cleared record, in the middle of the reply.
  c.status({ met: true, sentinel: true, condition: 'Ship it' }); c.reply('Still working.');
  const display = read(SID, c.rows);
  assert.deepEqual([display.goals.current?.status, events(display)], ['cleared', ['set cleared']]);
  c.prompt('Thanks.');
  assert.equal(read(SID, c.rows).goals.current, undefined, 'history after the next prompt');
  // A /goal command is no prompt that ends it: the new goal replaces it.
  const met = conversation();
  met.set('A'); met.reply('Done.'); met.status({ met: true, condition: 'A', reason: 'ok', iterations: 1, durationMs: 900, tokens: 48 });
  assert.equal(read(SID, met.rows).goals.current?.status, 'met');
  met.set('B');
  assert.deepEqual([read(SID, met.rows).goals.current?.status, read(SID, met.rows).goals.current?.condition], ['active', 'B']);
});

test('the input area: records first, the record before the page when none was read, the live screen last', () => {
  const active = { status: 'active' as const, phase: 'not-met' as const, condition: 'Ship it', checks: 2, lastReason: 'no' };
  const base = { live: true, present: 0, absent: 0, checking: false };
  assert.deepEqual(observeGoal({ ...base, records: active, indicator: { state: 'active', elapsed: '12s' }, present: 1 }),
    { ...active, source: 'transcript', screen: { state: 'active', elapsed: '12s' } });
  assert.equal(observeGoal({ ...base, records: active, indicator: { state: 'active' }, checking: true })?.phase, 'checking');
  assert.equal(observeGoal({ ...base, records: active, indicator: { state: 'paused' }, checking: true })?.phase, 'paused');
  // An input box twice without the indicator: the goal no longer runs there; once may be a repaint.
  assert.equal(observeGoal({ ...base, records: active, absent: 1 })?.status, 'active');
  assert.equal(observeGoal({ ...base, records: active, absent: 2 }), undefined);
  // No live Claude Code: an active goal comes back on resume.
  assert.deepEqual(observeGoal({ ...base, records: active, live: false }), { ...active, source: 'transcript', history: true });
  assert.equal(observeGoal({ ...base, records: active, source: 'probe', live: false })?.source, 'probe');
  // Only the screen knows (twice in a row): a goal whose condition was not read.
  assert.equal(observeGoal({ ...base, indicator: { state: 'active' }, present: 1 }), undefined);
  assert.deepEqual(observeGoal({ ...base, indicator: { state: 'active', elapsed: '3m' }, present: 2 }),
    { status: 'active', phase: 'set', condition: '', checks: 0, source: 'screen', screen: { state: 'active', elapsed: '3m' } });
});

// Matrix finding F1: Claude Code writes the set record just before the /goal command, and the turn's
// prompt snapshots push the file past the first page, so a read from the end starts at the command
// (sized-session.jsonl: the CLI's own records, the unshown big ones as stubs of their original size).
const sized = ['2.1.300', '2.1.326', '2.1.329', '2.1.331'].map(version => ({ version, rows: load(`goal-${version}/sized-session.jsonl`) }));
const isGoalCommand = (row: JsonRecord) => row.type === 'user' && /<command-name>\/goal<\/command-name>/u.test(JSON.stringify((row.message as JsonRecord | undefined)?.content ?? ''));
/** The goal without its setting time (the echo's, a moment after the set record's). */
const comparable = (goal: GoalTracker['current']) => goal && { ...goal, setAt: undefined };

test('a page that begins at the /goal command still has the setting: its row, the goal, any page size or read', () => {
  for (const { version, rows } of sized) {
    const sid = sidOf(rows), full = read(sid, rows), cut = rows.findIndex(isGoalCommand);
    assert.equal(rows[cut - 1].type === 'attachment' && (rows[cut - 1].attachment as JsonRecord).type, 'goal_status', `${version}: the set record is right before the command`);
    assert.deepEqual(events(full), ['set not-met met'], version);
    const opened = read(sid, rows.slice(cut));
    assert.deepEqual(events(opened), ['set not-met met'], `${version}: opened at the command`);
    assert.deepEqual(comparable(opened.goals.current), comparable(full.goals.current), version);
    assert.equal(opened.goal?.source, 'transcript');
    // From the "Goal set: …" echo on (written with the command; before it nothing says the setting worked).
    const echo = rows.findIndex((row, i) => i > cut && /Goal set: /u.test(JSON.stringify(row.message ?? '')));
    assert.equal(echo, cut + 1, version);
    for (let at = echo; at < rows.length; at++) {
      const partial = read(sid, rows.slice(cut, at + 1)), whole = read(sid, rows.slice(0, at + 1));
      assert.deepEqual(events(partial), events(whole), `${version}: from the command to record ${at}`);
      assert.deepEqual(comparable(partial.goals.current), comparable(whole.goals.current), `${version}: record ${at}`);
    }
    for (const size of [1, 3, 9]) assert.deepEqual(events(paged(sid, rows, cut, size)), events(full), `${version}: paged by ${size}`);
  }
});

test('a failed check after a page that begins at the command, or after the command (the record before the page): retrying', () => {
  const rows = load('goal-2.1.331/session.jsonl'), sid = sidOf(rows);
  const command = rows.findIndex(row => isGoalCommand(row) && /Evaluator error case/u.test(JSON.stringify(row.message)));
  const set = rows[command - 1], notice = rows.findIndex((row, i) => i > command && /^Goal still active · /u.test(String(row.content ?? '')));
  const clear = rows.findIndex((row, i) => i > notice && (row.attachment as JsonRecord | undefined)?.type === 'goal_status');
  // The page begins at the command: its echo stands in for the set record, the notice follows it.
  const atCommand = read(sid, rows.slice(command, notice + 1));
  assert.deepEqual([atCommand.goal?.source, atCommand.goal?.current?.phase, events(atCommand)], ['transcript', 'retrying', ['set retry']]);
  // The page begins after the command: the record before it (Backend.readGoalBefore) goes on with the page.
  for (let cut = command + 2; cut <= notice; cut++) {
    for (const seedFirst of [true, false]) {
      const display = new MessageDisplay(sid);
      display.ingestJsonl(encode(rows.slice(cut, notice - 1)), true, true);
      if (seedFirst) display.seedGoal(set);
      display.ingestJsonl(encode(rows.slice(notice - 1, clear)));
      if (!seedFirst) display.seedGoal(set);
      const where = `opened at ${cut}, the probe ${seedFirst ? 'before' : 'after'} the later records`;
      assert.deepEqual([display.goal?.source, display.goal?.current?.phase, display.goal?.current?.condition], ['probe', 'retrying', 'Evaluator error case ccm:g'], where);
      assert.deepEqual(events(display).at(-1), 'retry', where);
      // Paged back to its setting: the records say the same, now on their own.
      display.prependJsonl(encode(rows.slice(0, cut)), false, true, true);
      assert.deepEqual([display.goal?.source, display.goal?.current?.phase], ['transcript', 'retrying'], where);
    }
  }
  // Only an active goal before the page counts, and only while no goal record was read.
  const display = new MessageDisplay(sid);
  display.ingestJsonl(encode(rows.slice(command + 2, notice + 1)), true, true);
  display.seedGoal({ ...set, attachment: { ...(set.attachment as JsonRecord), met: true } });
  assert.equal(display.goal, undefined);
  display.seedGoal(set);
  display.ingestJsonl(encode(rows.slice(notice + 1, clear + 1)));
  const after = (shown: MessageDisplay) => shown.goal;
  assert.deepEqual([after(display)?.source, after(display)?.current?.status], ['transcript', 'cleared']);
});
