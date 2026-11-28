import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MessageDisplay } from '../src/core/message-display';
import { setLocale } from '../src/shared/i18n';
import { turnDurationText } from '../src/renderer/TurnTiming';

const sessionId = '00000000-0000-4000-8000-000000000000';
const base = Date.parse('2026-11-28T06:00:00.000Z');
const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();
let counter = 0;
function chain() {
  let parent: string | null = null;
  return (seconds: number, body: Record<string, unknown>) => {
    const uuid = `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
    const record = { parentUuid: parent, isSidechain: false, sessionId, uuid, timestamp: at(seconds), ...body };
    parent = uuid;
    return JSON.stringify(record);
  };
}
const prompt = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
const reply = (text: string, stop: string | null = 'end_turn') => ({ type: 'assistant', message: { id: `msg_${++counter}`, role: 'assistant', model: 'claude-opus-5-5',
  content: [{ type: 'text', text }], stop_reason: stop } });
const duration = (durationMs: number) => ({ type: 'system', subtype: 'turn_duration', durationMs, messageCount: 2, isMeta: false });
const ingest = (display: MessageDisplay, lines: string[]) => display.ingestJsonl(Buffer.from(lines.map(line => line + '\n').join('')));
const replies = (display: MessageDisplay) => display.getMessages().filter(message => message.role === 'assistant');

test('a finished reply carries its end, Claude Code\'s durationMs and the time from its prompt', () => {
  const record = chain(), display = new MessageDisplay(sessionId);
  // The prompt waited 25 s on a permission prompt, which durationMs leaves out.
  ingest(display, [record(0, prompt('改一下表格')), record(64, reply('改好了。')), record(65, duration(40_000))]);
  assert.deepEqual(replies(display)[0].timing, { at: at(65), workMs: 40_000, wallMs: 65_000 });
});

test('a reply that is still going, or went on after a background notification, has no end yet', () => {
  const record = chain(), display = new MessageDisplay(sessionId);
  ingest(display, [record(0, prompt('跑一下测试')), record(3, reply('测试在后台跑。', null))]);
  assert.equal(replies(display)[0].timing, undefined);
  ingest(display, [record(4, reply('测试在后台跑。')), record(5, duration(4_500))]);
  assert.equal(replies(display)[0].timing?.workMs, 4_500);
  // The notification starts another native turn in the same reply: its time is added once it ends.
  ingest(display, [record(90, { type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>done</task-notification>' } }),
    record(95, reply('测试都过了。', null))]);
  assert.equal(replies(display)[0].timing, undefined);
  ingest(display, [record(96, reply('测试都过了。')), record(97, duration(6_000))]);
  assert.deepEqual(replies(display)[0].timing, { at: at(97), workMs: 10_500, wallMs: 97_000 });
});

test('an interrupted reply ends at the interruption, timed from its prompt', () => {
  const record = chain(), display = new MessageDisplay(sessionId);
  ingest(display, [record(0, prompt('重构这个模块')), record(8, reply('先看一下结构', null)),
    record(12, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } })]);
  const [message] = replies(display);
  assert.equal(message.interrupted, true);
  assert.deepEqual(message.timing, { at: at(12), wallMs: 12_000, stopped: true });
});

test('Claude Code 2.1.331 records: the reply keeps the recorded durationMs', () => {
  const lines = readFileSync(new URL('./fixtures/goal-2.1.331/sized-session.jsonl', import.meta.url), 'utf8').trim().split('\n');
  const id = JSON.parse(lines[0]).sessionId as string, display = new MessageDisplay(id);
  ingest(display, lines);
  const recorded = lines.map(line => JSON.parse(line)).filter(row => row.subtype === 'turn_duration');
  const timed = replies(display).filter(message => message.timing);
  assert.ok(timed.length >= 1);
  const last = timed.at(-1)!.timing!;
  assert.equal(last.at, recorded.at(-1).timestamp);
  assert.equal(last.workMs, recorded.at(-1).durationMs);
});

test('durations read as seconds, minutes and seconds, or hours and minutes', () => {
  setLocale('zh-CN');
  assert.deepEqual([400, 12_400, 192_000, 3_900_000].map(turnDurationText), ['1秒', '12秒', '3分12秒', '1时5分']);
  setLocale('en');
  assert.deepEqual([12_400, 192_000, 3_900_000].map(turnDurationText), ['12s', '3m 12s', '1h 5m']);
  setLocale('zh-CN');
});
