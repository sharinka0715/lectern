import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Backend } from '../src/backend';
import { PrivacyFolderError, type FileWindowRequest } from '../src/backend/artifacts';
import type { TaskOutputWindow } from '../src/backend/task-output-files';
import { Controller } from '../src/main/controller';
import { WorkspaceStore } from '../src/main/store';

// Synthetic records with the shapes Claude Code 2.1.310–2.1.330 write for a background
// Bash (`backgroundTaskId`) and a Monitor (`taskId`), never copied from a real session.
const sid = '00000000-0000-4011-8011-0000000000bb';
const at = (s: number) => `2026-01-01T05:00:${String(s).padStart(2, '0')}.000Z`;
const call = (id: string, name: string, input: unknown, s: number, cwd = '/home/dev/proj') => ({ type: 'assistant', uuid: 'a' + id, sessionId: sid, cwd, timestamp: at(s),
  message: { id: 'm' + id, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] } });
const launched = (id: string, result: unknown, s: number) => ({ type: 'user', uuid: 'r' + id, sessionId: sid, timestamp: at(s), toolUseResult: result,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'started' }] } });
const event = (task: string, line: string, s: number) => ({ type: 'queue-operation', operation: 'enqueue', sessionId: sid, timestamp: at(s),
  content: `<task-notification>\n<task-id>${task}</task-id>\n<summary>Monitor event: "Watch"</summary>\n<event>${line}</event>\n</task-notification>` });

/** In-memory task output files and redirect files, read with the windows the backend scripts implement. */
function files() {
  const tasks = new Map<string, Buffer>(), other = new Map<string, Buffer>(), calls: string[] = [];
  const window = (data: Buffer | undefined, request: TaskOutputWindow | FileWindowRequest, inode = '7') => {
    if (!data) return { found: false as const };
    const stamp = `${inode}:${data.length}:1`;
    if (request.known === stamp) return { found: true as const, stamp, inode, identity: inode, size: data.length, unchanged: true as const };
    const { from, before, limit, appendLimit = limit } = request;
    const [start, end, mode] = before !== undefined ? [Math.max(0, Math.min(before, data.length) - limit), Math.min(before, data.length), 'before' as const]
      : from !== undefined && from <= data.length && data.length - from <= appendLimit ? [from, data.length, 'from' as const] : [Math.max(0, data.length - limit), data.length, 'tail' as const];
    return { found: true as const, stamp, inode, identity: inode, size: data.length, start, mode, bytes: data.subarray(start, end) };
  };
  const backend = {
    readTaskOutput: async (_w: unknown, session: string, task: string, request: TaskOutputWindow) => { calls.push(`task:${task}:${request.from ?? request.before ?? 'tail'}`); assert.equal(session, sid); return window(tasks.get(task), request); },
    artifacts: { readWindow: async (_w: unknown, path: string, request: FileWindowRequest, explicit: boolean) => {
      calls.push(`file:${path}`);
      if (path.startsWith('/Users/dev/Desktop/') && !explicit) throw new PrivacyFolderError('privacy');
      const found = window(other.get(path), request);
      if (!found.found) throw new Error('missing file');
      return { path, ...found };
    } },
  };
  return { tasks, other, calls, backend };
}

async function controllerWith(records: unknown[], fake: ReturnType<typeof files>) {
  const directory = await mkdtemp(join(tmpdir(), 'lectern-task-output-'));
  const store = new WorkspaceStore(directory);
  await store.save({ id: 'test', name: 'Test', kind: 'local', cwd: '/home/dev/proj' });
  const backend = {
    readSession: async (_w: unknown, id: string) => ({ session: { id, title: id, mapping: 'exact', paneId: '%1' }, screen: '──────────\n❯ \n──────────',
      jsonl: Buffer.from(records.map(r => JSON.stringify(r)).join('\n') + '\n'), active: true, reset: true, hasMore: false }),
    ...fake.backend,
    completions: { isInstalled: async () => false },
    probeModelCatalog: async () => ({ observedAt: '', defaults: {}, models: [] }),
    verifyTerminalPane: async () => {}, resetRead() {}, dispose() {},
  } as unknown as Backend;
  const controller = new Controller(store, backend);
  await controller.watchSession('test', sid);
  return { controller, done: async () => { await controller.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

test('own output first: the trailer becomes the exit code, unchanged reads send no text, new bytes are appended', async () => {
  const fake = files();
  fake.tasks.set('bplain001', Buffer.from('line 1\nline 2\n'));
  const { controller, done } = await controllerWith([call('toolu_plain', 'Bash', { command: 'make all', run_in_background: true }, 1),
    launched('toolu_plain', { stdout: '', stderr: '', backgroundTaskId: 'bplain001' }, 2)], fake);
  try {
    const first = await controller.readTaskOutput('test', sid, 'toolu_plain', {}, 'secondary');
    assert.equal(first.source, 'task');
    assert.equal(first.text, 'line 1\nline 2\n');
    assert.equal(first.state, 'ok');
    assert.equal(first.exitCode, undefined);
    const again = await controller.readTaskOutput('test', sid, 'toolu_plain', { revision: first.revision }, 'secondary');
    assert.equal(again.text, undefined, 'nothing new: no text');
    assert.equal(again.revision, first.revision);
    fake.tasks.set('bplain001', Buffer.from('line 1\nline 2\nline 3\n\n[exited with code 2]\n'));
    const more = await controller.readTaskOutput('test', sid, 'toolu_plain', { revision: first.revision }, 'secondary');
    assert.equal(more.text, 'line 1\nline 2\nline 3\n');
    assert.equal(more.exitCode, 2);
    assert.equal(fake.calls.filter(c => c === 'task:bplain001:14').length, 2, 'later reads ask only for bytes after the window');
    assert.throws(() => controller.readTaskOutput('test', sid, 'toolu_missing', {}, 'secondary'));
    assert.throws(() => controller.readTaskOutput('test', sid, '../etc', {}, 'secondary'));
    assert.throws(() => controller.readTaskOutput('test', 'other', 'toolu_plain', {}, 'secondary'));
  } finally { await done(); }
});

test('a long output starts at its last window; older pages are prepended on request', async () => {
  const fake = files();
  const lines = Array.from({ length: 40_000 }, (_, i) => `row ${String(i).padStart(5, '0')}`).join('\n') + '\n';
  fake.tasks.set('blong0001', Buffer.from(lines));
  const { controller, done } = await controllerWith([call('toolu_long', 'Bash', { command: 'seq', run_in_background: true }, 1),
    launched('toolu_long', { backgroundTaskId: 'blong0001' }, 2)], fake);
  try {
    const tail = await controller.readTaskOutput('test', sid, 'toolu_long', {}, 'primary');
    assert.ok(tail.omitted > 0 && tail.hasOlder);
    assert.ok(tail.text!.startsWith('row '), 'the cut line is dropped');
    assert.ok(tail.text!.endsWith('row 39999\n'));
    const older = await controller.readTaskOutput('test', sid, 'toolu_long', { older: true, revision: tail.revision }, 'primary');
    assert.ok(older.omitted < tail.omitted);
    assert.ok(older.text!.endsWith(tail.text!), 'the older page joins the window');
    while (true) {
      const page = await controller.readTaskOutput('test', sid, 'toolu_long', { older: true }, 'primary');
      if (!page.hasOlder) { assert.equal(page.omitted, 0); assert.equal(page.text, lines); break; }
    }
  } finally { await done(); }
});

test('nothing printed itself: the redirect file is shown, resolved against the call cwd; the user may switch', async () => {
  const fake = files();
  fake.tasks.set('bredir001', Buffer.from('\n[exited with code 0]\n'));
  fake.other.set('/srv/app/build/make.log', Buffer.from('\x1b[32mcompiled\x1b[0m\nlinked\n'));
  fake.other.set('/srv/app/build/err.log', Buffer.from('warning\n'));
  const { controller, done } = await controllerWith([call('toolu_redir', 'Bash', { command: 'cd build && make > make.log 2> err.log', run_in_background: true }, 1, '/srv/app'),
    launched('toolu_redir', { stdout: '', stderr: '', backgroundTaskId: 'bredir001' }, 2)], fake);
  try {
    const shown = await controller.readTaskOutput('test', sid, 'toolu_redir', {}, 'primary');
    assert.equal(shown.ownEmpty, true);
    assert.equal(shown.exitCode, 0);
    assert.equal(shown.source, 'file:0');
    assert.deepEqual(shown.sources.map(s => [s.key, s.path, s.stream]), [['task', undefined, undefined], ['file:0', '/srv/app/build/make.log', 'stdout'], ['file:1', '/srv/app/build/err.log', 'stderr']]);
    assert.equal(shown.text, 'compiled\nlinked\n');
    // It keeps following the file while it grows.
    fake.other.set('/srv/app/build/make.log', Buffer.from('\x1b[32mcompiled\x1b[0m\nlinked\ndone\n'));
    assert.equal((await controller.readTaskOutput('test', sid, 'toolu_redir', { revision: shown.revision }, 'primary')).text, 'compiled\nlinked\ndone\n');
    assert.equal((await controller.readTaskOutput('test', sid, 'toolu_redir', { source: 'file:1' }, 'primary')).text, 'warning\n');
    const own = await controller.readTaskOutput('test', sid, 'toolu_redir', { source: 'task' }, 'primary');
    assert.equal(own.text, '');
    // A source the renderer makes up is ignored: the default is shown.
    assert.equal((await controller.readTaskOutput('test', sid, 'toolu_redir', { source: 'file:/etc/passwd' }, 'primary')).source, 'file:0');
    assert.ok(!fake.calls.some(c => c.includes('passwd')));
  } finally { await done(); }
});

test('a redirect file in a macOS privacy folder waits for the click; a missing task file falls back to monitor events', async () => {
  const fake = files();
  fake.tasks.set('bdesk0001', Buffer.from(''));
  fake.other.set('/Users/dev/Desktop/run.log', Buffer.from('from the desktop\n'));
  const { controller, done } = await controllerWith([
    call('toolu_desk', 'Bash', { command: 'run > run.log', run_in_background: true }, 1, '/Users/dev/Desktop'),
    launched('toolu_desk', { backgroundTaskId: 'bdesk0001' }, 2),
    call('toolu_mon', 'Monitor', { command: 'tail -f app.log', description: 'Watch', timeout_ms: 60000 }, 3),
    launched('toolu_mon', { taskId: 'bmon00001', timeoutMs: 60000, persistent: false }, 4),
    event('bmon00001', 'ready on :3000', 5), event('bmon00001', 'GET / 200', 6)], fake);
  try {
    const waiting = await controller.readTaskOutput('test', sid, 'toolu_desk', {}, 'primary');
    assert.equal(waiting.source, 'file:0');
    assert.equal(waiting.state, 'privacy');
    assert.equal(waiting.text, '');
    const read = await controller.readTaskOutput('test', sid, 'toolu_desk', { explicit: true }, 'primary');
    assert.equal(read.state, 'ok');
    assert.equal(read.text, 'from the desktop\n');
    // The choice holds for later reads of this column.
    assert.equal((await controller.readTaskOutput('test', sid, 'toolu_desk', {}, 'primary')).state, 'ok');
    const monitor = await controller.readTaskOutput('test', sid, 'toolu_mon', {}, 'primary');
    assert.equal(monitor.source, 'transcript');
    assert.equal(monitor.text, 'ready on :3000\nGET / 200\n');
    assert.deepEqual(monitor.sources.map(s => s.key), ['task', 'transcript']);
    const ownMissing = await controller.readTaskOutput('test', sid, 'toolu_mon', { source: 'task' }, 'primary');
    assert.equal(ownMissing.state, 'missing');
    // Once its file is there, the transcript's copy is no longer offered.
    fake.tasks.set('bmon00001', Buffer.from('ready on :3000\nGET / 200\nGET /api 200\n'));
    const own = await controller.readTaskOutput('test', sid, 'toolu_mon', { source: 'transcript' }, 'primary');
    assert.deepEqual([own.source, own.sources.map(s => s.key), own.text], ['task', ['task'], 'ready on :3000\nGET / 200\nGET /api 200\n']);
  } finally { await done(); }
});
