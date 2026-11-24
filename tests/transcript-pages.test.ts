import { fixtureClaudeConfig } from './helpers/claude-config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Backend, projectSlug } from '../src/backend';
import { Transport, type CommandOptions } from '../src/backend/transport';
import { JsonlDecoder } from '../src/core/jsonl';
import { Controller } from '../src/main/controller';
import { WorkspaceStore } from '../src/main/store';
import type { Workspace } from '../src/shared/types';

const posix = { skip: process.platform === 'win32' ? 'Local POSIX fixture; Windows runs no local commands' : false };
async function fixture(t: TestContext) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "lectern-tail-'")));
  const workspace: Workspace = { id: 'pages', name: 'History', kind: 'local', cwd };
  fixtureClaudeConfig(join(cwd, 'config'));
  const dir = join(join(cwd, 'config'), 'projects', projectSlug(cwd));
  await mkdir(dir, { recursive: true });
  const sessionId = randomUUID();
  const file = join(dir, sessionId + '.jsonl');
  // 隔离的纯历史样本不启动 CLI，也不用后台探测原生账号状态。
  const backend = new Backend({ tmuxSocket: 'tail-' + sessionId, claudeCommand: 'false' });
  t.after(async () => { await backend.dispose(); await rm(cwd, { recursive: true, force: true }); });
  const row = (type: string, uuid: string, content: string) => JSON.stringify({ type, uuid, sessionId, cwd, message: { content } }) + '\n';
  const poll = () => backend.readSession(workspace, sessionId, false, [], true);
  return { workspace, sessionId, file, backend, row, poll };
}

test('discovery only checks changed transcript ranges for complete background replies', posix, async t => {
  const { workspace, sessionId, file, backend, row, poll } = await fixture(t);
  const seed = row('user','u','cold history');
  const answer = (body: string) => JSON.stringify({ type:'assistant', sessionId, cwd:workspace.cwd, message:{content:body,stop_reason:'end_turn'} })+'\n';
  await writeFile(file, seed + answer('old'));
  const counters: number[] = [];
  const run = Transport.prototype.run;
  t.mock.method(Transport.prototype,'run', async function(this: Transport,w:Workspace,cmd:string,opts:CommandOptions={}) {
    const result = await run.call(this,w,cmd,opts); if (opts.tag === 'session.history_page') counters.push(result.stdout.length); return result;
  });
  const discover = async (prior?: { inode:string; offset:number }) => (await backend.discover(workspace, prior && {[sessionId]:prior})).sessions[0].replyProgress!;
  const cold = await discover(); assert.equal(cold.completedThrough,undefined);
  await discover(cold); assert.deepEqual(counters,[],'no extra transcript reads for a baseline or unchanged file');
  const big = Buffer.from(answer('跨'.repeat(150_000))); await appendFile(file,big.subarray(0,-1));
  const half = await discover(cold); assert.equal(half.completedThrough,undefined);
  await appendFile(file,'\n'); const finished = await discover(half);
  assert.equal(finished.completedThrough,cold.offset+big.length,'complete record crossing a scan and byte budget');
  assert.deepEqual((await poll()).transcriptPosition,{ inode:finished.inode, offset:finished.offset });
  await appendFile(file,JSON.stringify({type:'custom-title',customTitle:'renamed'})+'\n');
  const rename = await discover(finished); assert.equal(rename.completedThrough,undefined);
  await writeFile(file,seed); assert.equal((await discover(rename)).reset,true);
});

test('cold tail, reverse pages and forward appends cover each original byte exactly once', posix, async t => {
  const { workspace, sessionId, file, backend, row, poll } = await fixture(t);
  const original = Buffer.from(Array.from({ length: 270 }, (_, i) =>
    row('user', 'u' + i, '第' + i + '问') + row('assistant', 'a' + i, '🧭答'.repeat(100) + i)).join(''));
  const appended = Buffer.from(row('user', 'live', '正在写入 🧭 跨块'));
  const split = appended.indexOf('🧭') + 2;
  await writeFile(file, Buffer.concat([original, appended.subarray(0, split)]));
  const run = Transport.prototype.run;
  let pollBytes = 0, pageReads = 0;
  t.mock.method(Transport.prototype, 'run', async function (this: Transport, w: Workspace, cmd: string, opts: CommandOptions = {}) {
    const r = await run.call(this, w, cmd, opts);
    if (opts.tag === 'session.poll') pollBytes += r.stdout.length;
    if (opts.tag === 'session.history_page') pageReads++;
    return r;
  });
  const first = await poll();
  assert.ok(first.reset && first.olderCursor);
  assert.equal(first.hasMore, false);
  assert.ok(pollBytes < 140_000 && first.olderCursor.before > 128_000);
  assert.equal(pageReads, 0, '普通文字首屏不用额外的 Python / SSH 分页往返');
  const decoder = new JsonlDecoder();
  const rows = decoder.push(first.jsonl);
  assert.equal(rows.filter(r => r.type === 'user').length, 24);
  assert.equal(rows.at(-1)?.uuid, 'a269');
  const pages = [first.jsonl];
  await appendFile(file, appended.subarray(split));
  let cursor = first.olderCursor;
  for (;;) {
    const page = await backend.readOlderHistory(workspace, sessionId, cursor);
    assert.equal(page.jsonl.at(-1), 10);
    assert.equal(new JsonlDecoder().push(page.jsonl).length, page.jsonl.toString().trimEnd().split('\n').length);
    pages.unshift(page.jsonl);
    if (!page.olderCursor) break;
    assert.ok(page.olderCursor.before < cursor.before);
    cursor = page.olderCursor;
  }
  const live = await poll();
  assert.equal(live.reset, false);
  assert.equal(decoder.push(live.jsonl)[0]?.uuid, 'live');
  assert.equal(decoder.invalidLines, 0);
  assert.deepEqual(Buffer.concat([...pages, live.jsonl]), Buffer.concat([original, appended]));
  assert.equal((await poll()).jsonl.length, 0);
});

test('首屏补齐跨过 5 MiB 工具回执的整轮，普通上翻不重读回执', posix, async t => {
  const { workspace, sessionId, file, backend, row } = await fixture(t);
  const store = new WorkspaceStore(join(workspace.cwd, 'profile'));
  await store.save(workspace);
  const controller = new Controller(store, backend);
  const history: string[] = [];
  for (let i = 0; i < 60; i++) history.push(row('user', `q${i}`, `提问 ${i}`), row('assistant', `a${i}`, `回复 ${i}`));
  history.push(row('user', 'long', '检查训练进度'));
  for (let i = 0; i < 32; i++) {
    const id = `tool-${i}`;
    history.push(JSON.stringify({ sessionId, cwd: workspace.cwd, type: 'assistant', uuid: `call-${i}`,
      message: { content: [{ type: 'tool_use', id, name: 'Read', input: {} }] } }) + '\n');
    history.push(JSON.stringify({ sessionId, cwd: workspace.cwd, type: 'user', uuid: `result-${i}`,
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(160 * 1024) }] } }) + '\n');
  }
  history.push(row('assistant', 'end', '已完成'));
  const input = Buffer.from(history.join(''));
  await writeFile(file, input);
  try {
    const run = Transport.prototype.run;
    let requests = 0, bytes = 0;
    t.mock.method(Transport.prototype, 'run', async function(this: Transport, w: Workspace, cmd: string, opts: CommandOptions = {}) {
      if (opts.tag === 'session.history_page') {
        requests++;
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      const result = await run.call(this, w, cmd, opts);
      if (opts.tag === 'session.history_page') bytes += result.stdout.length;
      return result;
    });
    const start = performance.now();
    const tail = await controller.watchSession(workspace.id, sessionId);
    assert.ok(tail.historyPage?.hasOlder);
    assert.deepEqual(tail.messages.map(m => m.text), ['检查训练进度', '已完成']);
    assert.equal(tail.messages[1].tools.length, 32);
    assert.ok(requests <= 3, `首屏补读命令过多：${requests}`);
    const openBytes = bytes;
    const earlier = await controller.loadEarlierMessages(workspace.id, sessionId, tail.historyPage.cursor);
    t.diagnostic(`文件 ${input.length} 字节，读取 ${bytes} 字节，${requests} 次命令，每次模拟延迟 40 ms，共 ${Math.round(performance.now() - start)} ms`);
    assert.ok(earlier.messages.some(m => m.text === '提问 59'));
    assert.equal(earlier.messages.at(-1)?.tools.length, 32);
    assert.equal(earlier.historyPage?.hasOlder, false);
    assert.equal(earlier.messages.filter(message => message.role === 'user').length, 61);
    assert.ok(requests <= 4, `读取命令过多：${requests}`);
    assert.ok(openBytes <= input.length + 64, '长回合的补读不重复传输已收到的记录');
    assert.ok(bytes - openBytes < 128 * 1024, '上翻不重复读取已显示的长回合');
  } finally { await controller.detach(); }
});

test('首屏字节窗口从孤立回复开始时，同时补齐页首和窗口内更晚的完整轮次', posix, async t => {
  const { workspace, sessionId, file, backend, row } = await fixture(t);
  const store = new WorkspaceStore(join(workspace.cwd, 'profile'));
  await store.save(workspace);
  await writeFile(file, row('user','u0','尚未翻到') + row('assistant','a0','较早的回复') +
    row('user','u1','窗口外的提问') + row('progress','p','x'.repeat(256 * 1024)) + row('assistant','a1','窗口首条回复') +
    row('user','u2','最新提问') + row('assistant','a2','最新回复'));
  const controller = new Controller(store, backend);
  try {
    const tail = await controller.watchSession(workspace.id, sessionId);
    assert.deepEqual(tail.messages.map(m => m.text), ['窗口外的提问','窗口首条回复','最新提问','最新回复']);
    assert.ok(tail.historyPage?.hasOlder);
    const full = await controller.loadEarlierMessages(workspace.id, sessionId, tail.historyPage.cursor, 0.125);
    assert.deepEqual(full.messages.slice(-4), tail.messages);
    assert.deepEqual(full.messages.slice(0,2).map(m => m.text), ['尚未翻到','较早的回复']);
    assert.equal(full.historyPage?.hasOlder, false);
  } finally { await controller.detach(); }
});

test('长回合中的密集内部记录可在一次扩大的读取中跨过', posix, async t => {
  const { workspace, sessionId, file, backend, row, poll } = await fixture(t);
  const questions = Array.from({length: 70}, (_, i) => row('user', `q${i}`, `提问 ${i}`)).join('');
  const metadata = Array.from({length: 4000}, (_, i) => row('progress', `p${i}`, '')).join('');
  await writeFile(file, questions + metadata);
  const tail = await poll();
  assert.ok(tail.olderCursor);
  assert.equal(new JsonlDecoder().push(tail.jsonl).length, 256);
  const earlier = await backend.readOlderHistory(workspace, sessionId, tail.olderCursor, NaN);
  const rows = new JsonlDecoder().push(earlier.jsonl);
  assert.ok(rows.length > 3000);
  assert.equal(rows.filter(r => r.type === 'user').length, 70);
  assert.equal(earlier.olderCursor, undefined);
  assert.deepEqual(Buffer.concat([earlier.jsonl, tail.jsonl]), Buffer.from(questions + metadata));

  const input = Buffer.from(questions + metadata);
  let cursor = tail.olderCursor;
  for (const sizeMiB of [0.1456789, 0.125]) {
    const offset = cursor.before - Math.round(sizeMiB * 1024 * 1024);
    const start = input.lastIndexOf(10, offset - 1) + 1;
    const page = await backend.readOlderHistory(workspace, sessionId, cursor, sizeMiB);
    assert.ok(page.olderCursor);
    assert.equal(page.olderCursor.before, start);
    assert.deepEqual(page.jsonl, input.subarray(start, cursor.before));
    cursor = page.olderCursor;
  }
});

test('a last giant record and a partially appended multibyte record survive a reverse read', posix, async t => {
  const { file, row, poll } = await fixture(t);
  const prompt = row('user', 'before', 'A large reply follows.');
  const reply = Buffer.from(row('assistant', 'large', 'abc🧭'.repeat(200_000) + '完成'));
  const split = reply.lastIndexOf('🧭') + 1;
  await writeFile(file, Buffer.concat([Buffer.from(prompt), reply.subarray(0, split)]));
  const first = await poll();
  assert.equal(first.olderCursor, undefined);
  const decoder = new JsonlDecoder();
  assert.deepEqual(decoder.push(first.jsonl).map(r => r.uuid), ['before']);
  await appendFile(file, reply.subarray(split));
  assert.equal(decoder.push((await poll()).jsonl)[0]?.uuid, 'large');
  assert.equal(decoder.invalidLines, 0);
  assert.deepEqual(first.jsonl, Buffer.concat([Buffer.from(prompt), reply.subarray(0, split)]));
});

test('small files with many short turns page by turns; older cursors reject truncation and rotation', posix, async t => {
  const { workspace, sessionId, file, backend, row, poll } = await fixture(t);
  const small = Array.from({ length: 45 }, (_, i) => row('user', 'u' + i, 'yes')).join('');
  await writeFile(file, small);
  const first = await poll();
  assert.ok(first.olderCursor);
  assert.equal(new JsonlDecoder().push(first.jsonl).length, 24);
  await writeFile(file, row('user', 'after', 'replacement'));
  await assert.rejects(backend.readOlderHistory(workspace, sessionId, first.olderCursor), /历史文件已变化/);
  assert.equal((await poll()).reset, true);
  await rename(file, file + '.old');
  await writeFile(file, small + small);
  await assert.rejects(backend.readOlderHistory(workspace, sessionId, first.olderCursor), /历史文件已变化/);
  const rotated = await poll();
  assert.ok(rotated.reset && rotated.olderCursor);
  assert.equal(new JsonlDecoder().push(rotated.jsonl).length, 24);
  backend.resetRead(workspace.id, sessionId);
  const forward = await backend.readSession(workspace, sessionId);
  assert.equal(forward.jsonl.toString(), small + small);
});

test('giant middle records are fetched once and oversized unfinished tails keep forward framing', posix, async t => {
  const { workspace, sessionId, file, backend, row, poll } = await fixture(t);
  const front = row('user', 'before', 'ordinary prompt');
  const giant = row('assistant', 'large', '跨'.repeat(180_000));
  const recent = Array.from({ length: 70 }, (_, i) => row('user', 'u' + i, 'q')).join('');
  const initial = front + giant + recent;
  await writeFile(file, initial);
  const page = await poll();
  assert.ok(page.olderCursor);
  const parts = [page.jsonl];
  let cursor = page.olderCursor;
  for (;;) {
    const older = await backend.readOlderHistory(workspace, sessionId, cursor);
    parts.unshift(older.jsonl);
    if (!older.olderCursor) break;
    cursor = older.olderCursor;
  }
  assert.deepEqual(Buffer.concat(parts), Buffer.from(initial));
  // A sparse single physical record exercises the decoder limit without
  // allocating a 50 MiB test string or transferring it through the transport.
  const handle = await open(file, 'w');
  try {
    await handle.write(front);
    await handle.write('{"type":"assistant","text":"');
    await handle.write(Buffer.from('x'), 0, 1, 50 * 1024 * 1024);
  } finally { await handle.close(); }
  backend.resetRead(workspace.id, sessionId);
  const partial = await poll();
  assert.equal(partial.jsonl.toString(), front);
  assert.equal(partial.olderCursor, undefined);
  assert.equal(partial.skippedHistoryRecords, 1);
  await appendFile(file, '"}\n' + row('user', 'new', 'after large record'));
  const forward = await poll();
  assert.equal(forward.jsonl.toString(), row('user', 'new', 'after large record'));
  assert.equal(forward.reset, false);
});

test('按字节上翻时跳过跨界的超大记录，保留同页的其他完整行', posix, async t => {
  const { workspace, sessionId, file, backend, row, poll } = await fixture(t);
  const front = row('user', 'first', '开头');
  const suffix = Array.from({length: 70}, (_, i) => row('user', `q${i}`, `问题 ${i}`)).join('');
  const handle = await open(file, 'w');
  try {
    await handle.write(front);
    await handle.write(Buffer.from('\n' + suffix), 0, Buffer.byteLength('\n' + suffix), 49 * 1024 * 1024);
  } finally { await handle.close(); }
  const tail = await poll();
  assert.ok(tail.olderCursor);
  const page = await backend.readOlderHistory(workspace, sessionId, tail.olderCursor);
  assert.equal(page.skippedHistoryRecords, 1);
  assert.equal(page.olderCursor?.before, Buffer.byteLength(front));
  assert.equal(Buffer.concat([page.jsonl, tail.jsonl]).toString(), suffix);
});

test('copy-truncate followed by immediate regrowth invalidates cursors with a matching inode and size', posix, async t => {
  const { workspace, sessionId, file, backend, row, poll } = await fixture(t);
  const contents = (letter: string) => Array.from({ length: 35 }, (_, i) => row('user', letter + i, letter.repeat(99))).join('');
  await writeFile(file, contents('a'));
  const first = await poll();
  assert.ok(first.olderCursor);
  await writeFile(file, contents('b'));
  await assert.rejects(backend.readOlderHistory(workspace, sessionId, first.olderCursor), /历史文件已变化/);
  const changed = await poll();
  assert.ok(changed.reset);
  assert.equal(new JsonlDecoder().push(changed.jsonl).at(-1)?.uuid, 'b34');
});

const image = (data: string) => ({ type: 'image', filename: 'image.png', source: { type: 'base64', media_type: 'image/png', data } });


test('含内嵌大图的首屏、上翻和实时追加逐字节保留原始 JSONL', posix, async t => {
  const { workspace, sessionId, file, backend, row, poll } = await fixture(t);
  const front = Array.from({length: 50}, (_, i) => row('user', 'u' + i, '题目')).join('');
  const data = Buffer.alloc(256 * 1024, 37).toString('base64');
  const older = JSON.stringify({ sessionId, type: 'attachment', uuid: 'old', attachment: image(data) }) + '\r\n';
  const photo = JSON.stringify({ sessionId, cwd: workspace.cwd, type: 'user', uuid: 'photo',
    message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: [image(data)] }] },
    toolUseResult: { type: 'image', file: { base64: data } } }) + '\n';
  const complete = Buffer.from(row('assistant', 'tail', '字节分段'));
  const split = complete.indexOf('字') + 1;
  await writeFile(file, Buffer.concat([Buffer.from(older + front + photo), complete.subarray(0, split)]));
  const run = Transport.prototype.run;
  t.mock.method(Transport.prototype, 'run', function(this: Transport, w: Workspace, cmd: string, opts: CommandOptions = {}) {
    if (opts.tag === 'session.poll' || opts.tag === 'session.history_page') assert.doesNotMatch(cmd, /\bpython3?\b/);
    return run.call(this, w, cmd, opts);
  });
  const first = await poll();
  let cursor = first.olderCursor;
  assert.ok(cursor);
  assert.ok(first.jsonl.includes(photo));
  const pages = [first.jsonl];
  while (cursor) {
    const page = await backend.readOlderHistory(workspace, sessionId, cursor);
    pages.unshift(page.jsonl);
    cursor = page.olderCursor;
  }
  await appendFile(file, complete.subarray(split));
  assert.deepEqual(Buffer.concat([...pages, (await poll()).jsonl]), Buffer.concat([Buffer.from(older + front + photo), complete]));
});
