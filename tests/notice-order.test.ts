import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { MessageDisplay } from '../src/core/message-display';
import type { JsonRecord } from '../src/core/jsonl';
import { replyParts } from '../src/renderer/reply-activities';

const encode = (rows: JsonRecord[]) => Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
const read = (sid: string, rows: JsonRecord[], partial = false) => {
  const display = new MessageDisplay(sid);
  display.ingestJsonl(encode(rows), true, partial);
  return display;
};
const orderOf = (display: MessageDisplay, compact: boolean) => display.getMessages()
  .filter(message => message.role === 'assistant').flatMap(message => replyParts(message, compact).flatMap(part => {
    if (part.kind === 'text') return [part.text.trim()];
    if (part.kind === 'notice') return [part.notice.text.split('\n', 1)[0]];
    return part.kind === 'activities' ? part.rows.flatMap(row => row.kind === 'tool'
      ? [JSON.parse(row.tool.input || '{}').description ?? row.tool.name] : []) : [];
  }));
const pair = (label: string) => `Background command "Sample pair ${label}" completed (exit code 0)`;
const noticesOf = (display: MessageDisplay) => display.getMessages().flatMap(message => message.taskNotifications ?? []);

for (const version of ['2.1.300', '2.1.331']) {
  const rows: JsonRecord[] = readFileSync(new URL(`./fixtures/notice-order-${version}/session.jsonl`, import.meta.url), 'utf8')
    .trimEnd().split('\n').map(line => JSON.parse(line));
  const sid = rows.find(row => row.type === 'user')!.sessionId as string;

  test(`${version}: a background Bash completion goes between the foreground and next tool calls`, () => {
    const enqueues = rows.flatMap((row, i) => row.type === 'queue-operation' && row.operation === 'enqueue' && /Sample pair [AB]/.test(String(row.content)) ? [i] : []);
    assert.equal(enqueues.length, 2);
    assert.deepEqual(noticesOf(read(sid, rows.slice(0, enqueues[1] + 1))), [], 'the terminal is still running the foreground call at enqueue');
    const full = read(sid, rows);
    for (const compact of [true, false]) {
      const order = orderOf(full, compact), start = order.indexOf('Before the foreground call.');
      assert.deepEqual(order.slice(start, start + 2), ['Before the foreground call.', 'Sample foreground call']);
      assert.deepEqual(order.slice(start + 4, start + 6), ['After the foreground call.', 'Sample next call']);
    }
  });

  test(`${version}: two adjacent deliveries keep the same cursors and delivery order`, () => {
    const full = read(sid, rows);
    const notices = noticesOf(full).slice(0, 2);
    const delivered = rows.flatMap(row => {
      const attachment = row.attachment as JsonRecord | undefined;
      const label = attachment?.type === 'queued_command' && /Sample pair ([AB])/.exec(String(attachment.prompt))?.[1];
      return label ? [pair(label)] : [];
    });
    assert.deepEqual([...delivered].sort(), [pair('A'), pair('B')]);
    assert.deepEqual(notices.map(notice => notice.text), delivered);
    assert.equal(notices[0].textOffset, notices[1].textOffset);
    assert.equal(notices[0].toolsBefore, notices[1].toolsBefore);
    for (const compact of [true, false]) {
      const order = orderOf(full, compact);
      assert.deepEqual(order.slice(order.indexOf('Sample foreground call') + 1, order.indexOf('After the foreground call.')), delivered);
    }
  });

  test(`${version}: a Bash completion at idle precedes the reply it triggers`, () => {
    const full = read(sid, rows);
    assert.equal(full.getMessages().filter(message => message.role === 'user').length, 1);
    for (const compact of [true, false]) {
      const order = orderOf(full, compact), start = order.indexOf('Initial answer complete.');
      assert.deepEqual(order.slice(start, start + 3),
        ['Initial answer complete.', 'Background command "Sample idle task" completed (exit code 0)', 'Reply to the idle task.']);
    }
  });

  test(`${version}: a subagent completion precedes the reply it triggers`, () => {
    const full = read(sid, rows);
    for (const compact of [true, false]) {
      const order = orderOf(full, compact), start = order.indexOf('Reply to the idle task.');
      assert.deepEqual(order.slice(start, start + 3), ['Reply to the idle task.', 'Agent "Sample helper" finished', 'Reply to the helper.']);
    }
  });

  if (version === '2.1.331') test(`${version}: Monitor event and stream end each precede their own reply`, () => {
    const full = read(sid, rows);
    for (const compact of [true, false]) {
      const order = orderOf(full, compact), start = order.indexOf('Reply to the helper.');
      assert.deepEqual(order.slice(start), ['Reply to the helper.', 'Monitor event: "Sample monitor"', 'Reply to the monitor event.',
        'Monitor "Sample monitor" stream ended', 'Reply to the monitor completion.']);
    }
  });

  test(`${version}: complete, paged and live reads converge on the same notice positions`, () => {
    const expected = read(sid, rows);
    const check = (display: MessageDisplay, where: string) => {
      assert.deepEqual(noticesOf(display), noticesOf(expected), where);
      for (const compact of [true, false]) assert.deepEqual(orderOf(display, compact), orderOf(expected, compact), where);
    };
    for (const size of [1, 5, 17]) for (let cut = 1; cut < rows.length; cut++) {
      const display = read(sid, rows.slice(cut), true);
      for (let end = cut; end > 0;) {
        const start = Math.max(0, end - size);
        display.prependJsonl(encode(rows.slice(start, end)), start > 0, true, true);
        end = start;
      }
      check(display, `record ${cut}, pages of ${size}`);
    }
    const data = encode(rows);
    for (const size of [37, 512, 4096]) {
      const display = new MessageDisplay(sid);
      display.ingestJsonl(Buffer.alloc(0), true, false);
      for (let at = 0; at < data.length; at += size) display.ingestJsonl(data.subarray(at, at + size));
      check(display, `reads of ${size} bytes`);
    }
  });
}
