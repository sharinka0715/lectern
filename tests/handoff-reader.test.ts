import assert from 'node:assert/strict';
import test from 'node:test';
import type { Backend, HistoryCursor } from '../src/backend';
import { HandoffReader } from '../src/main/handoff-reader';
import type { Workspace } from '../src/shared/types';

const workspace: Workspace = { id: 'w', kind: 'local', cwd: '/tmp', name: '示例' };
const current = () => true;
const row = (type: 'user' | 'assistant', uuid: string, parentUuid: string | null, content: unknown) =>
  JSON.stringify({ type, sessionId: 'old', uuid, parentUuid, message: { role: type, content } }) + '\n';
const question = row('user', 'q', null, '第一轮');
const answer = row('assistant', 'a', 'q', '第一轮答复');
const latest = row('user', 'u', 'a', '第二轮') + row('assistant', 'b', 'u', '第二轮答复');
const cursor = (before: number): HistoryCursor => ({ before, size: 4096, inode: '1' });

test('交接原稿上翻中断时保留已读字节，重试补齐同一轮并拒绝旧票据', async () => {
  const reader = new HandoffReader('old');
  const calls: (number | undefined)[] = [];
  const backend = { async readHandoffHistory(_w: Workspace, _tip: string, _source: string, before?: HistoryCursor) {
    calls.push(before?.before);
    if (!before) return { jsonl: Buffer.from(latest), olderCursor: cursor(2048) };
    if (before.before === 2048) return { jsonl: Buffer.from(answer), olderCursor: cursor(1024) };
    if (calls.length === 3) throw new Error('读取中断');
    return { jsonl: Buffer.from(question) };
  } } satisfies Pick<Backend, 'readHandoffHistory'>;
  const page = await reader.read(backend, workspace, 'tip', undefined, 1, current);
  assert.ok(page.cursor);
  await assert.rejects(reader.read(backend, workspace, 'tip', page.cursor, 1, current), /读取中断/);
  const retry = await reader.read(backend, workspace, 'tip', page.cursor, 1, current);
  assert.deepEqual(calls, [undefined, 2048, 1024, 1024]);
  assert.deepEqual(retry.messages.map(m => m.text), ['第一轮', '第一轮答复', '第二轮', '第二轮答复']);
  assert.equal(retry.cursor, undefined);
  assert.ok(retry.messages.every(m => !m.rewindUuid));
  assert.throws(() => reader.read(backend, workspace, 'tip', page.cursor, 1, current), /页码已失效/);
});

test('同一旧段的不同分屏使用独立附件标识，释放的读取丢弃延迟结果', async () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } };
  const jsonl = Buffer.from(question + row('assistant', 'a', 'q', [image]));
  const backend = { async readHandoffHistory() { return { jsonl }; } } satisfies Pick<Backend, 'readHandoffHistory'>;
  const left = new HandoffReader('old'), right = new HandoffReader('old');
  const [primary, secondary] = await Promise.all([left, right].map(r => r.read(backend, workspace, 'tip', undefined, 1, current)));
  const id = primary.messages.flatMap(m => m.attachments ?? [])[0].id;
  const other = secondary.messages.flatMap(m => m.attachments ?? [])[0].id;
  assert.notEqual(id, other);
  assert.ok(left.attachment(id));
  assert.equal(right.attachment(id), undefined);
  assert.ok(right.attachment(other));
  const retired = new HandoffReader('old');
  let visible = true;
  const pending = retired.read(backend, workspace, 'tip', undefined, 1, () => visible);
  visible = false;
  await assert.rejects(pending, /已切换/);
  assert.ok(right.attachment(other));
});
