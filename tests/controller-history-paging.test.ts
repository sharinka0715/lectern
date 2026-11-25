import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Backend, HistoryCursor, ReadResult } from '../src/backend';
import { Controller } from '../src/main/controller';
import { WorkspaceStore } from '../src/main/store';

const cursor: HistoryCursor = { before: 1234, size: 9876, inode: '71' };
const empty = Buffer.alloc(0);
function pair(n: number) {
  const id = 'u' + n, sid = 'session';
  const row = (type: string, uuid: string, parentUuid: string | null, text: string) =>
    JSON.stringify({ type, uuid, sessionId: sid, parentUuid, message: {
      role: type, content: text, ...(type === 'assistant' ? { id: uuid, stop_reason: 'end_turn' } : {}),
    } });
  return Buffer.from([row('user', id, n > 1 ? 'a' + (n - 1) : null, 'Question ' + n),
    row('assistant', 'a' + n, id, 'Answer ' + n)].join('\n') + '\n');
}
const pause = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
};
function result(bytes: Buffer, reset: boolean, active = false): ReadResult {
  return { session: { id: 'session', title: 'Paged', mapping: 'manual', ...(active && { paneId: '%1' }) },
    screen: '', active, reset, jsonl: bytes, hasMore: false, ...(reset && { olderCursor: cursor }) };
}
type OlderPage = { jsonl: Buffer; olderCursor?: HistoryCursor };
async function fixture(read: () => Promise<ReadResult>, older: (cursor: HistoryCursor, sizeMiB?: number) => Promise<OlderPage>, turnAction?: Backend['turnAction']) {
  const directory = await mkdtemp(path.join(tmpdir(), 'lectern-page-control-'));
  const store = new WorkspaceStore(directory);
  await store.save({id: 'project', name: 'Paging', kind: 'local', cwd: '/tmp'});
  const backend = { readSession: (_w: unknown, _s: string, _v: boolean, _a: unknown, tailFirst: boolean) => {
    assert.equal(tailFirst, true); return read();
  }, readOlderHistory: (_workspace: unknown, _session: string, cursor: HistoryCursor, sizeMiB?: number) => older(cursor, sizeMiB),
    turnAction, resetRead() {}, async dispose() {} } as unknown as Backend;
  const controller = new Controller(store, backend);
  return {controller, cleanup: async () => { await controller.dispose(); await rm(directory, {recursive:true, force:true}); }};
}

test('rewind projects older pages once, counts duplicate prompts by UUID, and leaves a failed read retryable', async () => {
  const pairWithSamePrompt = (n: number) => Buffer.from(pair(n).toString().replace('Question ' + n, 'Repeated prompt'));
  const reads: number[] = [];
  const snapshots: string[][] = [];
  let fail = true, dispatched = 0;
  const { controller, cleanup } = await fixture(async () => ({
    ...result(pairWithSamePrompt(3), true, true), panePid: 7, nativeStatus: 'idle',
  }), async (current, sizeMiB) => {
    assert.equal(sizeMiB, 16);
    reads.push(current.before);
    if (current.before === cursor.before) return { jsonl: pair(2), olderCursor: { ...cursor, before: 1 } };
    if (fail) { fail = false; throw new Error('interrupted'); }
    return { jsonl: pairWithSamePrompt(1) };
  }, async (_workspace, _session, _pane, _pid, _action, target) => {
    dispatched++;
    assert.deepEqual(target, { index: 2, prompts: ['Repeated prompt', 'Question 2', 'Repeated prompt'] });
    assert.deepEqual(snapshots.filter(messages => messages.length !== 2), [[
      'Repeated prompt', 'Answer 1', 'Question 2', 'Answer 2', 'Repeated prompt', 'Answer 3',
    ]]);
    assert.equal(controller.currentSnapshot?.historyPage?.hasOlder, false);
    return undefined;
  });
  try {
    const first = await controller.watchSession('project', 'session');
    controller.on('snapshot', snapshot => snapshots.push(snapshot.messages.map((message: { text: string }) => message.text)));
    const rewind = () => controller.turnAction('project', 'session', '%1', 7, { kind: 'rewindTo', uuid: 'u3' });
    await assert.rejects(rewind(), /interrupted/);
    assert.equal(dispatched, 0);
    assert.equal(controller.currentSnapshot?.historyPage?.cursor, first.historyPage?.cursor);
    await rewind();
    assert.equal(dispatched, 1);
    assert.deepEqual(reads, [cursor.before, 1, cursor.before, 1]);
  } finally { await cleanup(); }
});

test('only a requested page is read, simultaneous requests share it and an old ticket cannot prepend twice', async () => {
  let reads = 0;
  const page = pause<{jsonl: Buffer}>();
  const {controller, cleanup} = await fixture(async () => result(pair(2), true), () => { reads++; return page.promise; });
  try {
    const tail = await controller.watchSession('project','session');
    assert.ok(tail.historyPage?.hasOlder);
    assert.equal(reads, 0);
    assert.deepEqual(tail.messages.map(m => m.text), ['Question 2','Answer 2']);
    const first = controller.loadEarlierMessages('project','session',tail.historyPage.cursor);
    const second = controller.loadEarlierMessages('project','session',tail.historyPage.cursor);
    assert.equal(reads, 1);
    page.resolve({jsonl:pair(1)});
    const [a,b] = await Promise.all([first,second]);
    assert.equal(a,b);
    assert.deepEqual(a.messages.map(m => m.text), ['Question 1','Answer 1','Question 2','Answer 2']);
    assert.deepEqual(a.messages.slice(-2).map(m => m.id), tail.messages.map(m => m.id));
    assert.equal(a.historyPage?.hasOlder,false);
    assert.equal(await controller.loadEarlierMessages('project','session',tail.historyPage.cursor),a);
    assert.equal(reads,1);
  } finally { await cleanup(); }
});

test('a failed page can be retried; a page from a released watch cannot enter a reopened view', async () => {
  const deferred = pause<{jsonl: Buffer}>();
  let reads = 0;
  const {controller,cleanup} = await fixture(async () => result(pair(2),true), () => {
    reads++;
    if (reads === 1) throw new Error('interrupted');
    return deferred.promise;
  });
  try {
    const first = await controller.watchSession('project','session');
    await assert.rejects(controller.loadEarlierMessages('project','session',first.historyPage!.cursor),/interrupted/);
    assert.equal(controller.currentSnapshot?.historyPage?.cursor,first.historyPage?.cursor);
    const old = controller.loadEarlierMessages('project','session',first.historyPage!.cursor);
    const next = await controller.watchSession('project','session');
    assert.notEqual(next.historyPage?.cursor,first.historyPage?.cursor);
    deferred.resolve({jsonl:pair(1)});
    await assert.rejects(old,/切换/);
    assert.equal(controller.currentSnapshot,next);
    assert.equal(await controller.loadEarlierMessages('project','session',first.historyPage!.cursor),next);
  } finally { await cleanup(); }
});

test('a live append completing during an SSH history read remains at the end after the prepend', {timeout:8000}, async () => {
  const page = pause<OlderPage>();
  let polls = 0;
  const {controller,cleanup} = await fixture(async () => {
    polls++;
    return result(polls === 1 ? pair(2) : polls === 2 ? pair(3) : empty,polls === 1,true);
  }, async current => current.before === cursor.before ? page.promise : {jsonl: pair(1)});
  try {
    const tail = await controller.watchSession('project','session');
    const nextPoll = new Promise<void>(resolve => controller.once('snapshot',() => resolve()));
    const fetching = controller.loadEarlierMessages('project','session',tail.historyPage!.cursor);
    await nextPoll;
    assert.equal(controller.currentSnapshot?.messages.at(-1)?.text,'Answer 3');
    page.resolve({jsonl: historyRow('user', 'off-branch', null, 'discarded'), olderCursor: {...cursor, before: 1}});
    const final = await fetching;
    assert.deepEqual(final.messages.map(m => m.text), ['Question 1','Answer 1','Question 2','Answer 2','Question 3','Answer 3']);
  } finally { await cleanup(); }
});

function historyRow(type: string, uuid: string, parentUuid: string | null, content: unknown, fields = {}) {
  return Buffer.from(JSON.stringify({ type, uuid, parentUuid, sessionId: 'session', ...fields,
    message: { role: type, content, ...(type === 'assistant' && { id: uuid, stop_reason: 'end_turn' }) } }) + '\n');
}

test('opening recovers the orphan’s actual prompt; one prepend crosses notifications and discarded prompts to reach another pair', async () => {
  const pages = [
    historyRow('user', 'result', 'call', [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(200_000) }]),
    historyRow('assistant', 'call', 'q3', [{ type: 'tool_use', id: 't', name: 'Read', input: {} }]),
    historyRow('user', 'q3', 'notice', 'same question'),
    historyRow('user', 'notice', 'a2', '<task-notification>done</task-notification>', { origin: { kind: 'task-notification' } }),
    Buffer.concat([historyRow('user', 'abandoned', 'a1', 'discarded'), historyRow('assistant', 'a2', 'q2', 'earlier answer')]),
    historyRow('user', 'q2', 'a1', 'same question'),
  ];
  const reads: number[] = [];
  let failOnce = true;
  const {controller, cleanup} = await fixture(async () => result(historyRow('assistant', 'a3', 'result', 'latest'), true), async (current, sizeMiB) => {
    const index = cursor.before - current.before;
    // Opening grows its repair reads from 256 KiB; an explicit page keeps its size.
    assert.equal(sizeMiB, index < 3 ? [0.25, 1, 4][index] : 1.5, '打开时的补读逐步放大，上翻首批和后续补读均使用指定大小');
    reads.push(index);
    if (index === 5 && failOnce) { failOnce = false; throw new Error('read interrupted'); }
    assert.ok(index < pages.length, '读取到上一轮提问后应停止');
    return { jsonl: pages[index], olderCursor: { ...cursor, before: current.before - 1 } };
  });
  try {
    const tail = await controller.watchSession('project', 'session');
    assert.deepEqual(tail.messages.map(m => m.text), ['same question', 'latest']);
    assert.deepEqual(reads, [0, 1, 2]);
    const ticket = tail.historyPage!.cursor;
    await assert.rejects(controller.loadEarlierMessages('project', 'session', ticket, 1.5), /read interrupted/);
    assert.equal(controller.currentSnapshot!.historyPage!.cursor, ticket);
    const [a, b] = await Promise.all([controller.loadEarlierMessages('project', 'session', ticket, 1.5), controller.loadEarlierMessages('project', 'session', ticket, 1.5)]);
    assert.equal(a, b);
    assert.deepEqual(reads, [0, 1, 2, 3, 4, 5, 5]);
    assert.equal(a.historyPage!.hasOlder, true);
    assert.notEqual(a.historyPage!.cursor, ticket);
    assert.deepEqual(a.messages.map(m => m.text), ['same question', 'earlier answer', 'same question', 'latest']);
    assert.deepEqual(a.messages.slice(-2).map(m => m.id), tail.messages.map(m => m.id));
    assert.equal(a.messages.at(-1)!.tools[0].result?.length, 200_000);
  } finally { await cleanup(); }
});

test('a page with complete later pairs still recovers the first image/text reply on its actual branch', async () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } };
  const pages = [
    Buffer.concat([historyRow('assistant', 'a1', 'q1', [image, {type:'text', text:'图文回复'}]), pair(2)]),
    historyRow('user', 'discarded', null, '不是这条分支的提问'),
    historyRow('user', 'q1', null, [{type:'text',text:'看图'}, image]),
  ];
  const {controller, cleanup} = await fixture(async () => result(pair(3), true), async (current, size) => {
    assert.equal(size, 0.125);
    const i = cursor.before - current.before;
    assert.ok(i < pages.length);
    return {jsonl: pages[i], olderCursor:{...cursor, before:current.before - 1}};
  });
  try {
    const tail = await controller.watchSession('project', 'session');
    const full = await controller.loadEarlierMessages('project', 'session', tail.historyPage!.cursor, 0.125);
    assert.deepEqual(full.messages.map(m => m.text), ['看图', '图文回复', 'Question 2', 'Answer 2', 'Question 3', 'Answer 3']);
    assert.ok(full.messages[0].attachments?.[0].image && full.messages[1].attachments?.[0].image);
    assert.deepEqual(full.messages.slice(-2), tail.messages);
  } finally { await cleanup(); }
});

test('metadata tail with a pending live input recovers the preceding answer without hiding the new input', async () => {
  const latest = historyRow('user', 'pending', 'a1', 'still waiting');
  let reads = 0;
  const {controller, cleanup} = await fixture(async () => result(Buffer.concat([latest, historyRow('progress', 'p', 'pending', '')]), true, true), async () => {
    reads++;
    return {jsonl: pair(1)};
  });
  try {
    const tail = await controller.watchSession('project', 'session');
    assert.equal(reads, 1);
    assert.deepEqual(tail.messages.map(m => m.text), ['Question 1','Answer 1','still waiting','']);
    assert.equal(tail.messages.at(-1)?.source, 'preview');
  } finally { await cleanup(); }
});

test('an orphan with a genuinely missing parent is shown only after checking byte zero', async () => {
  let reads = 0;
  const {controller, cleanup} = await fixture(async () => result(historyRow('assistant', 'only', 'missing', 'recorded'), true), async () => {
    reads++; return {jsonl: historyRow('user', 'unrelated', null, 'different branch')};
  });
  try {
    const tail = await controller.watchSession('project', 'session');
    assert.equal(reads, 1);
    assert.deepEqual(tail.messages.map(m => m.text), ['recorded']);
    assert.equal(tail.historyPage!.hasOlder, false);
    assert.match(tail.notice ?? '', /父记录/);
  } finally { await cleanup(); }
});

test('switching views while the opening tail is recovering cannot publish the old partial answer', async () => {
  const started = pause<void>(), page = pause<OlderPage>();
  let reads = 0;
  const {controller, cleanup} = await fixture(async () => ++reads === 1
    ? result(historyRow('assistant', 'orphan', 'old-q', 'stale answer'), true)
    : result(pair(3), true), async () => { started.resolve(); return page.promise; });
  const published: string[][] = [];
  controller.on('snapshot', s => published.push(s.messages.map((m: {text:string}) => m.text)));
  try {
    const first = controller.watchSession('project', 'session');
    await started.promise;
    const next = await controller.watchSession('project', 'session');
    page.resolve({jsonl:historyRow('user', 'old-q', null, 'stale question')});
    await first;
    assert.deepEqual(published, [['Question 3', 'Answer 3']]);
    assert.equal(controller.currentSnapshot, next);
  } finally { await cleanup(); }
});

test('a metadata-only prefix stops at byte zero including a final empty page', async () => {
  let reads = 0;
  const {controller, cleanup} = await fixture(async () => result(pair(1), true), async () => {
    reads++;
    if (reads === 1) return {jsonl: Buffer.from('invalid\n'), olderCursor: {...cursor, before: 1}};
    assert.equal(reads, 2);
    return {jsonl: empty};
  });
  try {
    const tail = await controller.watchSession('project', 'session');
    const final = await controller.loadEarlierMessages('project', 'session', tail.historyPage!.cursor);
    assert.equal(final.historyPage!.hasOlder, false);
    assert.match(final.notice ?? '', /1 条/);
    assert.deepEqual(final.messages, tail.messages);
  } finally { await cleanup(); }
});

test('file replacement invalidates an older range in flight even when session and pane remain the same', {timeout: 8000}, async () => {
  const oldPage = pause<{jsonl: Buffer}>();
  let polls = 0;
  const { controller,cleanup } = await fixture(async () => {
    const first = ++polls === 1;
    return { ...result(pair(first ? 2 : 3),true,true), olderCursor: first ? cursor : undefined };
  }, () => oldPage.promise);
  try {
    const initial = await controller.watchSession('project','session');
    const afterReset = new Promise<void>(resolve => controller.once('snapshot', () => resolve()));
    const reading = controller.loadEarlierMessages('project','session',initial.historyPage!.cursor);
    await afterReset;
    oldPage.resolve({jsonl:pair(1)});
    const latest = await reading;
    assert.equal(latest.historyPage?.hasOlder, false);
    assert.deepEqual(latest.messages.map(m => m.text), ['Question 3','Answer 3']);
  } finally { await cleanup(); }
});
