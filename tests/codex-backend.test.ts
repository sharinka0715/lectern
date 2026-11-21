import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { CodexBackend } from '../src/backend/codex';

const fakeServer = String.raw`
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [log, mode] = process.argv.slice(2);
const wire = frame => process.stdout.write(JSON.stringify(frame) + '\n');
const event = (method, params) => wire({ method, params });
const request = (id, method, params) => wire({ id, method, params });
const result = (id, value) => wire({ id, result: value });
const assistant = (id, text) => ({ id, type: 'agentMessage', text });
const user = (id, text) => ({ id, type: 'userMessage', content: [{ type: 'text', text }] });
const failure = (id, message, code = -32600) => wire({ id, error: { code, message } });
let threads = 0, turns = 0, resumes = 0, active;
const patch = (id, text) => ({ type: 'fileChange', id, changes: [{ path: 'example.txt', kind: { type: 'add' }, diff: text }] });
createInterface({ input: process.stdin }).on('line', line => {
  const { method, id, params, result: answer, error } = JSON.parse(line);
  appendFileSync(log, JSON.stringify({ id, method, params, answer, error }) + '\n');
  switch (method) {
    case 'initialize': {
      const marker = log + '.initialized';
      if (mode === 'broken-handshake' && !existsSync(marker)) {
        writeFileSync(marker, '');
        process.stdout.write('{invalid JSON}\n');
        break;
      }
      const reply = JSON.stringify({ id, result: { userAgent: 'fake' } });
      process.stdout.write(reply.slice(0, 8));
      setTimeout(() => process.stdout.write(reply.slice(8) + '\n'), 5);
      break;
    }
    case 'thread/start':
      result(id, { thread: { id: 'thread-' + ++threads, cwd: params.cwd } });
      break;
    case 'thread/resume':
      resumes++;
      if (mode === 'legacy-history') {
        const thread = { id: params.threadId, cwd: params.cwd };
        if (!params.excludeTurns) thread.turns = [{ items: [user('user', 'earlier prompt'), patch('tool', '+example'), assistant('reply', 'earlier reply')] }];
        result(id, { thread });
        break;
      }
      result(id, { cwd: params.cwd, thread: { id: params.threadId }, turnsBackwardsCursor: 'latest' });
      break;
    case 'thread/turns/list':
      if (mode === 'legacy-history') failure(id, 'Method not found', -32601);
      else if (mode === 'repeated-history-cursor' && resumes === 1) result(id, { data: [], nextCursor: params.cursor });
      else if (params.cursor === 'latest') result(id, { data: [{ items: [user('u2','new prompt'), assistant('a2','new reply')] }], nextCursor: 'older' });
      else result(id, { data: [{ items: [user('u1','old prompt'), assistant('a1','old reply')] }], nextCursor: null });
      break;
    case 'turn/start': {
      if (params.input[0].text === 'reject') { failure(id, 'Rejected before a turn exists.'); break; }
      const threadId = params.threadId, turnId = 'turn-' + ++turns;
      const scope = { threadId, turnId };
      const previous = active;
      active = scope;
      event('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
      if (params.input[0].text === 'disconnect') {
        process.stdout.end(() => process.exit(1));
        return;
      } else if (params.input[0].text === 'fast') {
        event('item/completed', { ...scope, item: assistant('quick', 'Already finished.') });
        event('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
      } else if (mode === 'multiple-workspaces') {
        event('item/agentMessage/delta', { ...scope, itemId: 'reply', delta: 'Reply to ' + params.input[0].text });
        request(turnId, 'item/commandExecution/requestApproval', { ...scope, command: 'echo example', cwd: '/fixture/path', itemId: 'cmd' });
        if (previous) {
          const wrongTurn = { threadId, turnId: previous.turnId };
          event('item/agentMessage/delta', { ...wrongTurn, itemId: 'reply', delta: 'wrong turn' });
          request('wrong-turn', 'item/commandExecution/requestApproval', { ...wrongTurn, command: 'echo example', cwd: '/fixture/path', itemId: 'cmd' });
        }
      } else {
        event('item/agentMessage/delta', { ...scope, itemId: 'reply', delta: 'Partial ' });
        event('item/agentMessage/delta', { ...scope, itemId: 'reply', delta: 'reply' });
        request(id, 'item/commandExecution/requestApproval', { ...scope, command: 'echo example', cwd: '/fixture/path', itemId: 'cmd' });
        request('unsupported', 'item/tool/requestUserInput', scope);
        event('item/started', { ...scope, item: patch('patch', '+old') });
        request('patch', 'item/fileChange/requestApproval', { ...scope, itemId: 'patch' });
      }
      result(id, { turn: { id: turnId, status: 'inProgress' } });
      break;
    }
    case 'turn/interrupt':
      event('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' } });
      result(id, {});
      break;
  }
  if (!method && answer?.decision === 'accept') {
    event('serverRequest/resolved', { threadId: active.threadId, requestId: id });
    event('item/fileChange/patchUpdated', { ...active, itemId: 'patch', changes: patch('patch', '+new').changes });
  }
});
`;

async function fixture(t: TestContext) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'lectern-codex-test-')));
  const executable = join(dir, 'server.mjs'), log = join(dir, 'rpc.jsonl'), index = join(dir, 'index.json');
  await writeFile(executable, fakeServer);
  const backends = new Set<CodexBackend>();
  t.after(async () => {
    for (const backend of backends) backend.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  return { cwd: dir, index, backend: (mode = '') => {
    const backend = new CodexBackend(index, { executable: process.execPath, args: [executable, log, mode] });
    backends.add(backend);
    return backend;
  }, async log() {
    const contents = await readFile(log, 'utf8');
    return contents.trimEnd().split('\n').map(line => JSON.parse(line));
  } };
}

async function until<T>(check: () => Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const result = await check();
    if (result !== undefined) return result;
    await delay(10);
  }
  throw new Error('Timed out waiting for fake Codex App Server');
}

test('Codex threads are scoped to their workspace and only sent chats survive restart', async t => {
  const f = await fixture(t), backend = f.backend(), cwd = f.cwd;
  assert.deepEqual(await backend.list(cwd), { threads: [] });
  await assert.rejects(f.log(), { code: 'ENOENT' });
  const chat = await backend.create(cwd), draft = await backend.create(cwd);
  assert.deepEqual(await backend.list(join(cwd, 'different')), { threads: [] });
  await assert.rejects(backend.read(join(cwd, 'different'), chat.id), /unavailable/);
  await assert.rejects(backend.read(cwd, 'externally-created'), /unavailable/);
  await assert.rejects(readFile(f.index), { code: 'ENOENT' });
  await backend.send(cwd, chat.id, 'fast');
  assert.equal(backend.hasActiveTurns(), false, 'An early turn completion must survive the turn/start response');
  assert.deepEqual((await backend.read(cwd, chat.id)).messages.map(item => item.text), ['fast', 'Already finished.']);
  backend.dispose();

  const restored = f.backend();
  assert.deepEqual((await restored.list(cwd)).threads.map(row => [row.id, row.title]), [[chat.id, 'fast']]);
  await assert.rejects(restored.read(cwd, draft.id), /unavailable/);
  const [first, second] = await Promise.all([restored.read(cwd, chat.id), restored.read(cwd, chat.id)]);
  assert.equal((await f.log()).filter(row => row.method === 'thread/resume').length, 1);
  assert.deepEqual(first, second);
  assert.deepEqual(first.messages.map(item => item.text), ['old prompt', 'old reply', 'new prompt', 'new reply']);
});

test('Codex knows when it is streaming, waiting for scope-bound approvals, and interrupted', async t => {
  const f = await fixture(t), backend = f.backend(), cwd = f.cwd;
  const chat = await backend.create(cwd), other = await backend.create(cwd);
  await assert.rejects(backend.send(cwd, chat.id, 'reject'), /Rejected before a turn exists/);
  assert.equal((await backend.read(cwd, chat.id)).messages.length, 0);
  assert.equal(backend.hasActiveTurns(), false);
  const sending = backend.send(cwd, chat.id, 'check approvals');
  await assert.rejects(backend.send(cwd, chat.id, 'duplicate'), /already responding/);
  await sending;
  const snapshot = await backend.read(cwd, chat.id);
  assert.equal(snapshot.status, 'waiting');
  assert.equal(backend.hasActiveTurns(), true);
  assert.deepEqual(snapshot.messages.map(item => item.text), ['check approvals', 'Partial reply']);
  assert.match(snapshot.approvals[0].detail, /echo example/);
  assert.match(snapshot.approvals[1].detail, /\+old/);
  const [command, originalPatch] = snapshot.approvals;
  await assert.rejects(backend.answer(cwd, other.id, command.id, 'accept'), /no longer pending/);
  await backend.answer(cwd, chat.id, command.id, 'accept');
  const patch = await until(async () => (await backend.read(cwd, chat.id)).approvals.find(item => item.detail.includes('+new')));
  await assert.rejects(backend.answer(cwd, chat.id, originalPatch.id, 'accept'), /no longer pending/);
  await backend.answer(cwd, chat.id, patch.id, 'decline');
  assert.equal((await backend.read(cwd, chat.id)).status, 'working');
  await backend.interrupt(cwd, chat.id);
  assert.equal((await backend.read(cwd, chat.id)).status, 'idle');
  assert.equal(backend.hasActiveTurns(), false);
  const recorded = await f.log();
  assert.equal(recorded.filter(row => row.method === 'turn/start').length, 2);
  assert.equal(recorded.find(row => row.id === 'unsupported' && !row.method)?.error.code, -32601);
  assert.deepEqual(recorded.filter(row => row.answer).map(row => row.answer.decision), ['accept', 'decline']);
});

test('Codex retains a confirmed chat if the bridge disconnects before the RPC reply', async t => {
  const f = await fixture(t), backend = f.backend(), cwd = f.cwd;
  const chat = await backend.create(cwd);
  await backend.send(cwd, chat.id, 'disconnect');
  assert.equal(backend.hasActiveTurns(), false);
  const saved = (await backend.list(cwd)).threads[0];
  assert.equal(saved.id, chat.id);
  assert.equal(saved.status, 'error');
  assert.equal((await f.backend().list(cwd)).threads[0].id, chat.id);
});

test('parallel Codex turns keep messages, approvals and interrupts in their own workspace', async t => {
  const f = await fixture(t), backend = f.backend('multiple-workspaces');
  const left = join(f.cwd, 'left'), right = join(f.cwd, 'right');
  const [first, second] = await Promise.all([backend.create(left), backend.create(right)]);
  await Promise.all([backend.send(left, first.id, 'first prompt'), backend.send(right, second.id, 'second prompt')]);

  const [firstLive, secondLive] = await Promise.all([backend.read(left, first.id), backend.read(right, second.id)]);
  assert.deepEqual(firstLive.messages.map(item => item.text), ['first prompt', 'Reply to first prompt']);
  assert.deepEqual(secondLive.messages.map(item => item.text), ['second prompt', 'Reply to second prompt']);
  assert.equal(firstLive.approvals.length, 1);
  assert.equal(secondLive.approvals.length, 1);
  const firstApproval = firstLive.approvals[0].id;
  const secondApproval = secondLive.approvals[0].id;
  await assert.rejects(backend.answer(right, first.id, firstApproval, 'accept'), /unavailable/);
  await assert.rejects(backend.answer(right, second.id, firstApproval, 'accept'), /no longer pending/);
  await backend.answer(left, first.id, firstApproval, 'decline');
  await backend.interrupt(left, first.id);
  assert.equal((await backend.read(left, first.id)).status, 'idle');
  assert.equal((await backend.read(right, second.id)).status, 'waiting');
  assert.deepEqual((await backend.read(right, second.id)).approvals, secondLive.approvals);
  assert.equal(backend.hasActiveTurns(), true);

  await backend.answer(right, second.id, secondApproval, 'decline');
  await backend.interrupt(right, second.id);
  assert.equal(backend.hasActiveTurns(), false);
  const recorded = await f.log();
  assert.equal(recorded.filter(row => row.method === 'initialize').length, 1);
  assert.deepEqual(recorded.filter(row => row.method === 'turn/interrupt').map(row => row.params.threadId), [first.id, second.id]);
  assert.equal(recorded.find(row => row.id === 'wrong-turn' && !row.method)?.answer.decision, 'decline');
});

test('an invalid initialization frame clears the connection for later Codex calls', async t => {
  const f = await fixture(t), backend = f.backend('broken-handshake');
  const attempts = [backend.create(f.cwd), backend.create(f.cwd)];
  await Promise.all(attempts.map(attempt => assert.rejects(attempt, /sent invalid JSON/)));
  assert.deepEqual(await backend.list(f.cwd), { threads: [] });

  const chat = await backend.create(f.cwd);
  assert.equal(chat.status, 'idle');
  assert.deepEqual((await backend.list(f.cwd)).threads.map(thread => thread.id), [chat.id]);
  const recorded = await f.log();
  assert.equal(recorded.filter(row => row.method === 'initialize').length, 2);
  assert.equal(recorded.filter(row => row.method === 'thread/start').length, 1);
});

test('Codex falls back to legacy full history when the server lacks pagination', async t => {
  const f = await fixture(t), backend = f.backend();
  const chat = await backend.create(f.cwd);
  await backend.send(f.cwd, chat.id, 'fast');
  backend.dispose();

  const restored = await f.backend('legacy-history').read(f.cwd, chat.id);
  assert.deepEqual(restored.messages.map(item => [item.role, item.text]), [['user', 'earlier prompt'], ['assistant', 'earlier reply']]);
  const recorded = await f.log();
  assert.deepEqual(recorded.filter(row => row.method === 'thread/resume').map(row => row.params.excludeTurns), [true, undefined]);
  assert.equal(recorded.filter(row => row.method === 'thread/turns/list').length, 1);
});

test('a repeated Codex history cursor fails the read and allows a subsequent retry', async t => {
  const f = await fixture(t), backend = f.backend();
  const chat = await backend.create(f.cwd);
  await backend.send(f.cwd, chat.id, 'fast');
  backend.dispose();

  const restored = f.backend('repeated-history-cursor');
  await assert.rejects(restored.read(f.cwd, chat.id), /repeated history cursor/);
  const snapshot = await restored.read(f.cwd, chat.id);
  assert.deepEqual(snapshot.messages.map(item => item.text), ['old prompt', 'old reply', 'new prompt', 'new reply']);
  assert.equal((await f.log()).filter(row => row.method === 'thread/resume').length, 2);
});
