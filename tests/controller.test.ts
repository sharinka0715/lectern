import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import { Controller } from '../src/main/controller';
import type { ModelCatalog } from '../src/shared/model-catalog';
import type { SettingChoices } from '../src/backend/native-settings';
import { setupDemo } from '../src/main/demo';
import { WorkspaceStore } from '../src/main/store';
import type { Backend, ReadResult } from '../src/backend';
import type { SessionSettingKind, SessionSettingSnapshot, SessionSnapshot } from '../src/shared/types';
import { REPLY } from './helpers/claude-screen';
import { isolateTmux } from './helpers/private-tmux';

test('Controller integrates real tmux capture, delayed JSONL, reopen and explicit interrupt', {
  skip: process.platform === 'win32' && 'Requires POSIX tmux; Windows runs no local commands.',
  timeout: 40_000,
}, async t => {
  const privateServer = isolateTmux(`lectern-demo-${process.pid}`);
  t.after(() => privateServer.cleanup());
  try { privateServer.tmux('-V'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    t.skip('tmux is unavailable'); return;
  }
  const previousBinary = process.env.LECTERN_NODE_BINARY;
  process.env.LECTERN_NODE_BINARY = process.execPath;
  const demo = await setupDemo(process.cwd());
  const controller = new Controller(demo.store, demo.backend);
  const snapshots: SessionSnapshot[] = [];
  controller.on('snapshot', snapshot => snapshots.push(snapshot));
  function waitFor(predicate: (snapshot: SessionSnapshot) => boolean, timeout = 12_000): Promise<SessionSnapshot> {
    const latest = snapshots.at(-1);
    if (latest && predicate(latest)) return Promise.resolve(latest);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.off('snapshot', check);
        const last = snapshots.at(-1);
        reject(new Error(`Timed out waiting for snapshot: ${JSON.stringify({ status: last?.status, error: last?.error, messages: last?.messages.map(m => ({ role: m.role, source: m.source, text: m.text.slice(0, 100) })) })}`));
      }, timeout);
      function check(snapshot: SessionSnapshot) {
        if (!predicate(snapshot)) return;
        clearTimeout(timer);
        controller.off('snapshot', check);
        resolve(snapshot);
      }
      controller.on('snapshot', check);
    });
  }
  try {
    const workspace = demo.store.list()[0];
    const discovery = await controller.discover(workspace.id);
    assert.equal(discovery.sessions.length, 1);
    const session = discovery.sessions[0];
    assert.match(session.title, /远端会话/);
    assert.equal(session.mapping, 'exact');
    const initial = await controller.watchSession(workspace.id, session.id);
    assert.equal(initial.messages.length, 2);
    assert.equal(initial.messages[1].source, 'jsonl');
    const ready = await waitFor(s => Boolean(s.paneId) && s.status === 'idle' && !s.settingBusy && s.settings?.initialization === 'ready');
    assert.equal(ready.status, 'idle', 'The padded tmux screen must expose the fixture ready prompt');

    await controller.sendMessage(workspace.id, session.id, '你好');
    const preview = await waitFor(s => s.messages.length === 4 && s.messages[3].source === 'preview' && s.messages[3].text.length > 10);
    const assistantId = preview.messages[3].id;
    assert.equal(preview.messages[3].status, 'streaming');
    const final = await waitFor(s => s.messages.length === 4 && s.messages[3].source === 'jsonl' && s.messages[3].status === 'complete');
    assert.equal(final.messages[3].id, assistantId);
    assert.equal(final.messages.filter(m => m.role === 'assistant').length, 2);
    assert.match(final.messages[3].text, /中文与 emoji 🧭 都会完整保留/);
    const raw = await readFile(session.path!, 'utf8');
    const records = raw.trim().split('\n').map(line => JSON.parse(line));
    const authoritative = records.filter(record => record.type === 'assistant').at(-1);
    assert.equal(final.messages[3].text, authoritative.message.content.map((block: { text: string }) => block.text).join('\n\n'));
    for (const snapshot of snapshots.filter(s => s.messages.length === 4)) assert.equal(snapshot.messages[3].id, assistantId);

    controller.unwatchSession();
    const other = await controller.createSession(workspace.id);
    await controller.watchSession(workspace.id, other.id);
    await controller.watchSession(workspace.id, session.id);
    const reopened = await waitFor(s => s.sessionId === session.id && s.messages.length === 4 && !s.settingBusy);
    assert.deepEqual(reopened.messages.map(m => [m.id, m.role, m.text, m.source]), final.messages.map(m => [m.id, m.role, m.text, m.source]));
    const resumed = await controller.resumeSession(workspace.id, session.id);
    assert.equal(resumed.paneId, session.paneId, 'Resuming an existing live session must not fork a second Claude process');

    // `mock-hold`: the reply shows its first words and then waits for Esc, so the stop reads a frame the mock
    // no longer redraws. A streamed reply clears and redraws the whole screen every 100 ms; a read that caught
    // the redraw half done (a macOS pty hands tmux a frame in pieces) had no spinner and no input box, and the
    // stop was refused on its first read ("Claude 原生画面已变化", macOS CI).
    await controller.sendMessage(workspace.id, session.id, '测试中断操作 mock-hold');
    // A poll can still catch that last redraw half done (the spinner drawn, the input box not yet): wait for the
    // whole frame. The mock has no footer hint; its spinner right above the box shows the turn runs (as on
    // Claude Code 2.1.316), so `running` must come true.
    const beforeInterrupt = await waitFor(s => !!s.turnControls?.canStop && s.turnControls.running === true
      && s.messages.length === 6 && s.messages[5].source === 'preview' && s.messages[5].text.length > 5);
    await controller.turnAction(workspace.id, session.id, beforeInterrupt.paneId!, beforeInterrupt.panePid!, { kind: 'stop' });
    const interrupted = await waitFor(s => s.messages.length === 6 && s.status === 'idle' && s.messages[5].status === 'complete');
    assert.equal(interrupted.messages[5].id, beforeInterrupt.messages[5].id);
    assert.equal(interrupted.messages[5].source, 'preview');
    assert.match(interrupted.notice ?? '', /中断/);
    await pause(1100);
    const afterInterrupt = snapshots.at(-1)!;
    assert.equal(afterInterrupt.messages[5].source, 'preview', 'Interrupt must not manufacture an authoritative transcript record');
    assert.equal(afterInterrupt.status, 'idle');
    await controller.sendKey(workspace.id, session.id, 'C-c');
    await assert.rejects(controller.sendMessage(workspace.id, session.id, 'must not reach a shell'), /not running/i);
  } finally {
    await controller.dispose();
    await demo.cleanup();
    if (previousBinary === undefined) delete process.env.LECTERN_NODE_BINARY;
    else process.env.LECTERN_NODE_BINARY = previousBinary;
  }
});

function queryChoices(): ModelCatalog {
  return { observedAt: new Date().toISOString(), defaults: {}, models: [{ value: 'future-model', label: 'Future dynamically discovered choice', efforts: ['low', 'high'] }] };
}

async function fakeController(read: (sessionId: string) => Promise<ReadResult>, send = async (_text: string) => {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'lectern-controller-test-'));
  const store = new WorkspaceStore(directory);
  await store.save({ id: 'test', name: 'Test', kind: 'local', cwd: '/tmp' });
  const backend = {
    readSession: (_workspace: unknown, id: string) => read(id),
    sendMessage: (_workspace: unknown, _id: string, text: string) => send(text),
    // Skills the fake machine has installed; other unknown slash names are refused.
    completions: { isInstalled: async (_workspace: unknown, name: string) => ['compact-review'].includes(name) },
    probeModelCatalog: async () => queryChoices(),
    bindSettingChoices: (_ws: unknown, sessionId: string, paneId: string, choices: SettingChoices) =>
      ({ ...choices, token: 'test-ticket', sessionId, paneId, observedAt: '', options: choices.options.map((option, index) => ({ id: 'bound-' + index, label: option.label, current: false })) }),
    verifyTerminalPane: async () => {},
    sendTerminalInput: async () => {},
    resetRead() {}, dispose() {},
  } as unknown as Backend;
  const controller = new Controller(store, backend);
  return { controller, cleanup: async () => { await controller.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

function readResult(id: string, records: unknown[] = []): ReadResult {
  return {
    session: { id, title: id, mapping: 'exact', paneId: '%1' }, screen: '──────────\n❯ \n──────────',
    jsonl: Buffer.from(records.map(record => JSON.stringify(record) + '\n').join('')),
    active: true, reset: false, hasMore: false,
  };
}

test('a slow previous watch never publishes over a newer selected session', async () => {
  let finishOld: (result: ReadResult) => void = () => {};
  const oldRead = new Promise<ReadResult>(resolve => { finishOld = resolve; });
  const { controller, cleanup } = await fakeController(id => id === 'old' ? oldRead : Promise.resolve(readResult(id)));
  const published: string[] = [];
  controller.on('snapshot', snapshot => published.push(snapshot.sessionId));
  try {
    const oldWatch = controller.watchSession('test', 'old');
    const newer = await controller.watchSession('test', 'new');
    assert.equal(newer.sessionId, 'new');
    finishOld(readResult('old'));
    await oldWatch;
    assert.deepEqual([...new Set(published)], ['new'], 'every poll and catalog publication belongs to the new watch');
  } finally { await cleanup(); }
});

test('a canonical user record arriving before send returns does not create an optimistic duplicate', { timeout: 5000 }, async () => {
  let records: unknown[] = [];
  let releaseSend: () => void = () => {};
  let observedCanonical: () => void = () => {};
  const observed = new Promise<void>(resolve => { observedCanonical = resolve; });
  const { controller, cleanup } = await fakeController(async id => {
    const result = readResult(id, records);
    records = [];
    return result;
  }, async text => {
    records = [{ type: 'user', uuid: 'user1', sessionId: 'chat', message: { content: text.trim() } }];
    await new Promise<void>(resolve => { releaseSend = resolve; });
  });
  let snapshot: SessionSnapshot | undefined;
  controller.on('snapshot', next => {
    snapshot = next;
    if (next.messages.some((message: { role: string; source: string }) => message.role === 'user' && message.source === 'jsonl')) observedCanonical();
  });
  try {
    await controller.watchSession('test', 'chat');
    const sending = controller.sendMessage('test', 'chat', '  hello world\n');
    await observed;
    const canonicalUserId = snapshot!.messages[0].id;
    releaseSend();
    await sending;
    assert.equal(snapshot!.messages.filter(message => message.role === 'user').length, 1);
    assert.equal(snapshot!.messages.length, 2);
    assert.equal(snapshot!.messages[0].id, canonicalUserId);
    assert.equal(snapshot!.messages[0].source, 'jsonl');
  } finally { releaseSend(); await cleanup(); }
});

test('a tabbed send is its saved record (tab as four spaces), before or after send returns', { timeout: 5000 }, async () => {
  let records: unknown[] = [];
  let releaseSend: () => void = () => {};
  let observedCanonical: () => void = () => {};
  let early = true;
  const { controller, cleanup } = await fakeController(async id => {
    const result = readResult(id, records);
    records = [];
    return result;
  }, async text => {
    // Claude Code's paste handler saves each tab as four spaces.
    const saved = { type: 'user', uuid: `user-${text.length}`, sessionId: 'chat', origin: { kind: 'human' }, promptSource: 'typed', message: { content: text.replace(/\t/g, '    ') } };
    if (early) {
      records = [saved];
      await new Promise<void>(resolve => { releaseSend = resolve; });
    } else setTimeout(() => { records = [saved]; }, 0);
  });
  let snapshot: SessionSnapshot | undefined;
  controller.on('snapshot', (next: SessionSnapshot) => {
    snapshot = next;
    if (next.messages.some(message => message.role === 'user' && message.source === 'jsonl')) observedCanonical();
  });
  try {
    await controller.watchSession('test', 'chat');
    const observed = new Promise<void>(resolve => { observedCanonical = resolve; });
    const sending = controller.sendMessage('test', 'chat', 'show name\tsize');
    await observed;
    releaseSend();
    await sending;
    assert.deepEqual(snapshot!.messages.filter(m => m.role === 'user').map(m => [m.text, m.source]), [['show name    size', 'jsonl']]);
    early = false;
    await controller.sendMessage('test', 'chat', 'then\tdate');
    for (let i = 0; i < 50 && snapshot!.messages.some(m => m.source === 'pending'); i++) await pause(20);
    assert.deepEqual(snapshot!.messages.filter(m => m.role === 'user').map(m => [m.text, m.source]),
      [['show name    size', 'jsonl'], ['then    date', 'jsonl']]);
  } finally { releaseSend(); await cleanup(); }
});

test('failed transport does not manufacture a user bubble or retry the send', async () => {
  let attempts = 0;
  const { controller, cleanup } = await fakeController(async id => readResult(id), async () => {
    attempts++;
    throw new Error('SSH transport disconnected');
  });
  const snapshots: SessionSnapshot[] = [];
  controller.on('snapshot', snapshot => snapshots.push(snapshot));
  try {
    await controller.watchSession('test', 'chat');
    await assert.rejects(controller.sendMessage('test', 'chat', 'Hello'), /disconnected/);
    assert.equal(attempts, 1);
    assert.deepEqual(snapshots.at(-1)!.messages, []);
  } finally { await cleanup(); }
});

test('native /compact keeps its output in the terminal and the next skill keeps its conversation turn', { timeout: 5000 }, async () => {
  const user = (uuid: string, parentUuid: string | null, content: string) =>
    ({ type: 'user', uuid, parentUuid, message: { content } });
  const answer = (uuid: string, parentUuid: string, text: string) =>
    ({ type: 'assistant', uuid, parentUuid, message: { content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
  const command = (name: string, args = '') =>
    `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>\n<command-args>${args}</command-args>`;
  let records: unknown[] = [user('u', null, 'Before compaction'), answer('a', 'u', 'Original answer')];
  let reset = true;
  const prompt = '──────────\n❯ \n──────────';
  let screen = prompt;
  const sent: string[] = [];
  const { controller, cleanup } = await fakeController(async id => {
    const result = { ...readResult(id, records), reset, screen };
    records = [];
    reset = false;
    return result;
  }, async text => { sent.push(text); });
  const nextSnapshot = (matches: (snapshot: SessionSnapshot) => boolean) => new Promise<SessionSnapshot>(resolve => {
    const accept = (snapshot: SessionSnapshot) => {
      if (!matches(snapshot)) return;
      controller.off('snapshot', accept);
      resolve(snapshot);
    };
    controller.on('snapshot', accept);
  });
  try {
    const initial = await controller.watchSession('test', 'chat');
    const failure = 'Error during compaction: Not enough messages to compact.';
    screen = `❯ /compact\n  ⎿  ${failure}\n${prompt}`;
    records = [user('first-command', 'a', command('compact')), user('error', 'first-command', `<local-command-stderr>${failure}</local-command-stderr>`)];
    const failed = nextSnapshot(snapshot => snapshot.screen.includes(failure));
    await controller.sendMessage('test', 'chat', '/compact');
    const afterFailure = await failed;
    assert.ok(afterFailure.screen.includes(failure));
    assert.deepEqual(afterFailure.messages, initial.messages);
    assert.equal(afterFailure.status, 'idle');

    const focus = '保留接口决策';
    records = [user('second-command', 'error', command('compact', focus)),
      { type: 'system', subtype: 'compact_boundary', uuid: 'boundary', parentUuid: null, logicalParentUuid: 'second-command',
        compactMetadata: { trigger: 'manual', preservedMessages: { anchorUuid: 'summary', uuids: [] } } },
      { ...user('summary', 'boundary', 'Internal summary'), isCompactSummary: true, isVisibleInTranscriptOnly: true }];
    screen = prompt;
    const compacted = nextSnapshot(snapshot => snapshot.screen === prompt);
    await controller.sendMessage('test', 'chat', `/compact ${focus}`);
    const afterCompact = await compacted;
    // A compacted prompt is still visible history, but is no longer a native rewind target.
    assert.deepEqual(afterCompact.messages, initial.messages.map(({rewindUuid: _checkpoint, ...message}) => message));
    assert.equal(afterCompact.status, 'idle');

    const skill = '/compact-review';
    await controller.sendMessage('test', 'chat', skill);
    const pending = controller.currentSnapshot!.messages.at(-2)!;
    assert.equal(pending.source, 'pending');
    assert.equal(pending.text, skill);
    records = [user('skill', 'summary', command('compact-review')), answer('reply', 'skill', 'Reviewed')];
    const final = await nextSnapshot(snapshot => snapshot.messages.at(-1)?.text === 'Reviewed');
    assert.equal(final.status, 'idle');
    assert.deepEqual(final.messages.slice(0, 2), afterCompact.messages);
    assert.equal(final.messages.length, 4);
    assert.equal(final.messages[2].id, pending.id);
    assert.equal(final.messages[2].source, 'jsonl');
    assert.equal(final.messages[3].text, 'Reviewed');
    assert.deepEqual(sent, ['/compact', `/compact ${focus}`, skill]);
  } finally { await cleanup(); }
});

test('typing native /rename into chat leaves the transcript unchanged', async () => {
  const sent: string[] = [];
  const { controller, cleanup } = await fakeController(async id => ({
    ...readResult(id), screen: '──────────\n❯ \n──────────',
  }), async text => { sent.push(text); });
  try {
    const before = await controller.watchSession('test', 'chat');
    await controller.sendMessage('test', 'chat', '/rename 接口方案');
    assert.deepEqual(sent, ['/rename 接口方案']);
    assert.deepEqual(controller.currentSnapshot?.messages, before.messages);
    assert.equal(controller.currentSnapshot?.status, before.status);
  } finally { await cleanup(); }
});

test('responding to a TUI permission prompt does not invent a conversation user turn', async () => {
  const sent: string[] = [];
  const { controller, cleanup } = await fakeController(async id => ({
    ...readResult(id), screen: 'Do you trust this folder?\n❯ 1. Yes\n  2. No\n\n\n',
  }), async text => { sent.push(text); });
  const snapshots: SessionSnapshot[] = [];
  controller.on('snapshot', snapshot => snapshots.push(snapshot));
  try {
    const initial = await controller.watchSession('test', 'chat');
    assert.equal(initial.status, 'waiting');
    await controller.sendMessage('test', 'chat', 'yes');
    assert.deepEqual(sent, ['yes']);
    assert.deepEqual(snapshots.at(-1)!.messages, []);
  } finally { await cleanup(); }
});

test('read disconnection retains history and reconnects without duplicating messages or replaying input', { timeout: 7000 }, async () => {
  let reads = 0;
  let sends = 0;
  const history = [
    { type: 'user', uuid: 'u1', sessionId: 'chat', message: { content: 'Already sent' } },
    { type: 'assistant', uuid: 'a1', sessionId: 'chat', message: { content: [{ type: 'text', text: 'Already answered 🧭' }], stop_reason: 'end_turn' } },
  ];
  const { controller, cleanup } = await fakeController(async id => {
    reads++;
    if (reads === 2) throw new Error('Temporary SSH disconnect');
    // Reconnection may replay a byte range. UUID identity must absorb the replay.
    return readResult(id, reads <= 3 ? history : []);
  }, async () => { sends++; });
  const snapshots: SessionSnapshot[] = [];
  let recovered: () => void = () => {};
  const recovery = new Promise<void>(resolve => { recovered = resolve; });
  controller.on('snapshot', snapshot => {
    snapshots.push(snapshot);
    if (reads >= 3 && snapshot.status === 'idle') recovered();
  });
  try {
    const initial = await controller.watchSession('test', 'chat');
    assert.equal(initial.messages.length, 2);
    await recovery;
    const offline = snapshots.find(snapshot => snapshot.status === 'offline');
    assert.ok(offline, 'The intermediate disconnect must be surfaced to the renderer');
    assert.match(offline.error ?? '', /SSH disconnect/);
    assert.deepEqual(offline.messages, initial.messages, 'A transient transport error must not clear visible history');
    const final = snapshots.at(-1)!;
    assert.equal(final.status, 'idle');
    assert.equal(final.error, undefined);
    assert.deepEqual(final.messages, initial.messages, 'Replayed JSONL must retain exact message identity and text');
    assert.equal(sends, 0, 'Reconnect must never replay a user send');
    assert.equal(reads, 3);
  } finally { await cleanup(); }
});

test('external pane exit ends a live preview without inventing a saved assistant reply', { timeout: 5000 }, async () => {
  let reads = 0;
  const userRecord = { type: 'user', uuid: 'u1', sessionId: 'chat', message: { content: 'Hello' } };
  const { controller, cleanup } = await fakeController(async id => {
    reads++;
    if (reads === 1) return {
      ...readResult(id, [userRecord]),
      screen: `❯ Hello\n\n${REPLY} An unfinished reply 🧭\n\n✻ Thinking… (esc to interrupt)\n──────────\n❯ \n──────────`,
    };
    return { ...readResult(id), active: false, session: { id, title: id, mapping: 'unbound' }, screen: '' };
  });
  let last: SessionSnapshot | undefined;
  let ended: () => void = () => {};
  const inactive = new Promise<void>(resolve => { ended = resolve; });
  controller.on('snapshot', snapshot => {
    last = snapshot;
    if (reads >= 2 && snapshot.status === 'idle') ended();
  });
  try {
    const initial = await controller.watchSession('test', 'chat');
    assert.equal(initial.status, 'working');
    assert.equal(initial.messages[1].source, 'preview');
    assert.equal(initial.messages[1].status, 'streaming');
    await inactive;
    assert.equal(last!.paneId, undefined);
    assert.equal(last!.messages[1].id, initial.messages[1].id);
    assert.equal(last!.messages[1].text, 'An unfinished reply 🧭');
    assert.equal(last!.messages[1].source, 'preview');
    assert.equal(last!.messages[1].status, 'complete');
    assert.match(last!.notice ?? '', /中断/);
  } finally { await cleanup(); }
});

test('closing keeps the transcript in the same watch and shows it as history; a failed close changes nothing', { timeout: 5000 }, async () => {
  let reads = 0, closed = false, readsAtClose = 0;
  const records = [
    { type: 'user', uuid: 'u1', sessionId: 'chat', message: { content: 'Question' } },
    { type: 'assistant', uuid: 'a1', sessionId: 'chat', message: { content: [{ type: 'text', text: 'Answer' }], stop_reason: 'end_turn' } },
  ];
  // The cursor continues after a close: later reads only add what Claude wrote on exit.
  const { controller, cleanup } = await fakeController(async id => {
    const jsonl = reads++ ? [] : records;
    return closed ? { ...readResult(id, jsonl), active: false, session: { id, title: id, mapping: 'unbound' }, screen: '' }
      : { ...readResult(id, jsonl), panePid: 42 };
  });
  let failure: Error | undefined;
  Object.assign(controller.backend, { closeSession: async () => {
    if (failure) throw failure;
    closed = true; readsAtClose = reads;
    return { id: 'chat', title: 'chat', mapping: 'unbound', status: 'history', path: '/tmp/chat.jsonl' };
  } });
  const published: SessionSnapshot[] = [];
  controller.on('snapshot', snapshot => published.push(snapshot));
  try {
    const initial = await controller.watchSession('test', 'chat');
    assert.equal(initial.paneId, '%1');
    const ids = initial.messages.map(message => message.id);
    assert.equal(ids.length, 2);
    published.length = 0;
    failure = new Error('close refused');
    await assert.rejects(controller.closeSession('test', 'chat', '%1', 42), /close refused/);
    assert.equal(controller.currentSnapshot?.paneId, '%1', 'a failed close leaves the chat live');
    assert.deepEqual(controller.currentSnapshot?.messages.map(message => message.id), ids);
    failure = undefined;
    const history = await controller.closeSession('test', 'chat', '%1', 42);
    assert.equal(history?.id, 'chat');
    assert.ok(reads > readsAtClose, 'the close read the conversation once more before returning');
    const shown = controller.currentSnapshot!;
    assert.equal(shown.sessionId, 'chat', 'the watch stays');
    assert.equal(shown.paneId, undefined);
    assert.equal(shown.status, 'idle');
    assert.deepEqual(shown.messages.map(message => message.id), ids, 'the same bubbles, not a reload');
    assert.equal(published.at(-1), shown, 'published as history before the close returns');
    assert.ok(published.every(snapshot => snapshot.messages.length === 2), 'never an empty transcript');
  } finally { await cleanup(); }
});

test('closing a conversation that saved nothing stops watching it', async () => {
  const { controller, cleanup } = await fakeController(async id => ({ ...readResult(id), panePid: 7 }));
  Object.assign(controller.backend, { closeSession: async () => null });
  try {
    await controller.watchSession('test', 'empty');
    assert.equal(await controller.closeSession('test', 'empty', '%1', 7), null);
    assert.equal(controller.currentSnapshot, undefined);
  } finally { await cleanup(); }
});

test('opening inactive JSONL history does not report a fabricated interruption', async () => {
  const { controller, cleanup } = await fakeController(async id => ({
    ...readResult(id, [
      { type: 'user', uuid: 'u1', sessionId: id, message: { content: 'Existing question' } },
      { type: 'assistant', uuid: 'a1', sessionId: id, message: { content: [{ type: 'text', text: 'Existing answer' }], stop_reason: null } },
    ]), active: false, session: { id, title: id, mapping: 'unbound' }, screen: '',
  }));
  try {
    const snapshot = await controller.watchSession('test', 'chat');
    assert.equal(snapshot.status, 'idle');
    assert.equal(snapshot.notice, undefined);
    assert.equal(snapshot.messages[1].source, 'jsonl');
    assert.equal(snapshot.messages[1].status, 'complete');
  } finally { await cleanup(); }
});

test('inactive history ending at an unanswered user message has no imaginary live reply', async () => {
  const { controller, cleanup } = await fakeController(async id => ({
    ...readResult(id, [{ type: 'user', uuid: 'u1', sessionId: id, message: { content: 'No saved answer' } }]),
    active: false, session: { id, title: id, mapping: 'unbound' }, screen: '',
  }));
  try {
    const snapshot = await controller.watchSession('test', 'chat');
    assert.equal(snapshot.status, 'idle');
    assert.equal(snapshot.notice, undefined);
    assert.equal(snapshot.messages.length, 1);
    assert.equal(snapshot.messages[0].role, 'user');
    assert.ok(snapshot.messages.every(message => message.status === 'complete'));
  } finally { await cleanup(); }
});

test('settings transactions keep raw terminal live without inventing chat turns and lock other inputs', { timeout: 5000 }, async () => {
  let inMenu = false;
  let release: () => void = () => {};
  const { controller, cleanup } = await fakeController(async id => ({
    ...readResult(id),
    screen: inMenu ? 'Select model\n❯ 1. Future dynamically discovered model ✔\nEsc to cancel' : readResult(id).screen,
  }));
  controller.backend.setSessionSetting = async () => {
    inMenu = true;
    await new Promise<void>(resolve => { release = resolve; });
    inMenu = false;
    return { kind: 'model' as const, command: '/model', complete: true, observedAt: '', token: 't', sessionId: 'chat', paneId: '%1',
      options: [{ id: 'applied', label: 'Future dynamically discovered choice', current: true }], currentOptionId: 'applied' };
  };
  const snapshots: SessionSnapshot[] = [];
  controller.on('snapshot', value => snapshots.push(value));
  try {
    await controller.watchSession('test', 'chat');
    const choices = await controller.getSessionSetting('test', 'chat', 'model');
    const applying = controller.setSessionSetting('test', 'chat', choices.token, choices.options[0].id);
    await assert.rejects(controller.sendMessage('test', 'chat', 'do not submit'), /设置操作|输入/);
    await assert.rejects(controller.sendKey('test', 'chat', 'Enter'), /设置/);
    assert.equal((await controller.getSessionSetting('test', 'chat', 'effort')).sessionId, 'chat', 'reading machine choices is independent of the mutation');
    await pause(1150);
    const menuSnapshot = snapshots.find(value => value.settingBusy && value.screen.includes('Select model'));
    assert.ok(menuSnapshot, 'The read-only viewer still receives menu captures');
    assert.equal(menuSnapshot.status, 'idle');
    assert.deepEqual(menuSnapshot.messages, []);
    release(); await applying;
    assert.equal(snapshots.at(-1)!.settingBusy, false);
    assert.deepEqual(snapshots.at(-1)!.messages, []);
  } finally { release(); await cleanup(); }
});

test('native API errors permit settings recovery while an offline or busy session still rejects it', async () => {
  const { controller, cleanup } = await fakeController(async id => ({
    ...readResult(id),
    session: { ...readResult(id).session, status: 'error', statusDetail: 'API Error: 400 Unsupported model' },
    screen: '❯ Hello\n⏺ API Error: 400 Unsupported model\n─────────────────\n❯ Once fixed, resend your message\n─────────────────',
  }));
  let calls = 0;
  controller.backend.probeModelCatalog = async () => { calls++; return queryChoices(); };
  const snapshots: SessionSnapshot[] = [];
  controller.on('snapshot', value => snapshots.push(value));
  try {
    const snapshot = await controller.watchSession('test', 'chat');
    assert.equal(snapshot.status, 'error');
    await controller.getSessionSetting('test', 'chat', 'effort');
    assert.equal(snapshots.at(-1)?.settings?.initialization, 'ready');
    assert.equal(calls, 1, 'one model-list read serves both menus while the business pane shows an API error');
    await controller.getSessionSetting('test', 'chat', 'model');
    assert.equal(calls, 1);
    assert.equal(snapshots.at(-1)?.nativeInputReady, true);
    let recoveryPane: string | undefined;
    (controller.backend as any).sendMessage = async (_workspace: unknown, _id: string, _text: string, expectedPane?: string) => { recoveryPane = expectedPane; };
    await controller.sendMessage('test', 'chat', 'A different daily question after changing the model');
    assert.equal(recoveryPane, '%1', 'Recovery messages require fresh empty-composer verification in the exact pane');
  } finally { await cleanup(); }
});

const trustFixture = {
  token: 'trust-ticket', sessionId: 'chat', paneId: '%1', cwd: '/tmp', observedAt: '2026-11-17T00:00:00Z',
  acceptLabel: 'Yes, I trust this folder', cancelLabel: 'No, exit', scope: 'unspecified' as const,
};
function waitingTrustResult(id: string): ReadResult {
  return { ...readResult(id), directoryTrust: { ...trustFixture, sessionId: id },
    screen: 'Do you trust this folder?\n❯ 1. Yes\n  2. No\n',
    session: { ...readResult(id).session, status: 'waiting' } };
}

async function pollNow(controller: Controller) {
  const internals = controller as any;
  clearTimeout(internals.timer);
  await internals.poll(internals.watch);
}

test('manual control accepts unknown native dialogs, locks automation, and keeps JSONL authoritative after release', async () => {
  let records: unknown[] = [], screen = 'An unfamiliar native dialog\nSelect any options with Space';
  const { controller, cleanup } = await fakeController(async id => {
    const result = { ...readResult(id, records), screen, viewport: screen,
      session: { ...readResult(id).session, status: 'unknown' as const } };
    records = [];
    return result;
  });
  const snapshots: SessionSnapshot[] = []; controller.on('snapshot', value => snapshots.push(value));
  const sent: unknown[] = [];
  (controller.backend as any).sendTerminalInput = async (...args: unknown[]) => { sent.push(args); };
  try {
    await controller.watchSession('test', 'chat');
    const control = await controller.setTerminalControl('test', 'chat', true);
    assert.ok(control);
    for (const action of [
      () => controller.sendMessage('test', 'chat', 'not a chat prompt'),
      () => controller.sendKey('test', 'chat', 'Enter'),
      () => controller.setSessionSetting('test', 'chat', 'unused', 'choice'),
      () => controller.respondDirectoryTrust('test', 'chat', 'any-ticket', 'trust'),
    ]) await assert.rejects(action(), /接管/);
    await controller.sendTerminalInput('test', 'chat', control.token, { type: 'key', key: 'Space' });
    await controller.sendTerminalInput('test', 'chat', control.token, { type: 'text', text: '菜单里的中文回答' });
    assert.equal(sent.length, 2);
    assert.equal((sent[1] as unknown[])[3], '%1');
    assert.deepEqual(snapshots.at(-1)!.messages, [], 'Native answers must never become optimistic human messages');
    records = [
      { type: 'user', uuid: 'manual-user', sessionId: 'chat', message: { content: '帮我安排周末' } },
      { type: 'assistant', uuid: 'manual-answer', message: { id: 'answer', content: [{ type: 'text', text: '先去公园走走。' }], stop_reason: 'end_turn' } },
    ];
    screen = '❯ 帮我安排周末\n⏺ This unknown modal text is not an answer';
    await pollNow(controller);
    assert.equal(snapshots.at(-1)!.screen, screen);
    assert.equal(snapshots.at(-1)!.messages.length, 2);
    assert.equal(snapshots.at(-1)!.messages.at(-1)!.text, '先去公园走走。');
    await controller.setTerminalControl('test', 'chat', false, control.token);
    await pollNow(controller);
    assert.equal(snapshots.at(-1)!.messages.at(-1)!.text, '先去公园走走。');
    assert.equal(snapshots.at(-1)!.terminalControl, undefined);
    await controller.sendMessage('test', 'chat', '午饭吃什么？');
    screen = `❯ 午饭吃什么？\n${REPLY} 可以做番茄面。\n✶ Thinking…\nesc to interrupt`;
    await pollNow(controller);
    assert.equal(snapshots.at(-1)!.messages.at(-1)!.text, '可以做番茄面。', 'A new normal chat restores preview in its own bubble');
  } finally { await cleanup(); }
});

test('after a released takeover the running turn still accepts queue and steer, while its prose stays JSONL-only', async () => {
  // Claude Code 2.1.328 replying in auto mode (253 columns, trimmed).
  const rule = '─'.repeat(60);
  const running = `⏺ 我在当前回复进行中抓一下自己这个 pane 的原屏。\n\n· Harmonizing… (5m 21s · ↓ 22.7k tokens)\n\n${rule}\n❯ \n${rule}\n\n  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt`;
  let screen = `${rule}\n❯ \n${rule}`, status: 'idle' | 'working' = 'idle', nativeStatus: 'idle' | 'busy' = 'idle';
  const { controller, cleanup } = await fakeController(async id => ({ ...readResult(id), screen, viewport: screen, nativeStatus,
    session: { ...readResult(id).session, status } }));
  const snapshots: SessionSnapshot[] = []; controller.on('snapshot', value => snapshots.push(value));
  try {
    await controller.watchSession('test', 'chat');
    const control = (await controller.setTerminalControl('test', 'chat', true))!;
    await controller.setTerminalControl('test', 'chat', false, control.token);
    // The prompt was typed in the terminal, so no chat send clears the recovery.
    screen = running; status = 'working'; nativeStatus = 'busy';
    await pollNow(controller);
    assert.equal((controller as any).watch.manualRecovery, true);
    const snapshot = snapshots.at(-1)!;
    assert.equal(snapshot.turnControls?.running, true, 'the composer of a running turn is read from its own frame');
    assert.equal(snapshot.turnControls?.draftOccupied, false);
    assert.ok(!snapshot.messages.some(message => message.source === 'preview'), 'the screen still never becomes reply prose');
  } finally { await cleanup(); }
});

test('manual leases reject stale tokens across release, same-session rewatch, pane changes and read failures', async () => {
  let paneId = '%1', failure = false;
  const { controller, cleanup } = await fakeController(async id => {
    if (failure) throw new Error('SSH disconnected');
    return { ...readResult(id), session: { ...readResult(id).session, paneId } };
  });
  let sends = 0;
  (controller.backend as any).sendTerminalInput = async () => { sends++; };
  const snapshots: SessionSnapshot[] = []; controller.on('snapshot', value => snapshots.push(value));
  try {
    await controller.watchSession('test', 'chat');
    const first = (await controller.setTerminalControl('test', 'chat', true))!;
    await controller.setTerminalControl('test', 'chat', false, first.token);
    const second = (await controller.setTerminalControl('test', 'chat', true))!;
    assert.notEqual(first.token, second.token);
    await assert.rejects(controller.sendTerminalInput('test', 'chat', first.token, { type: 'key', key: 'Enter' }), /失效/);
    await assert.rejects(controller.setTerminalControl('test', 'chat', false, first.token), /失效/);
    await controller.watchSession('test', 'chat');
    await assert.rejects(controller.sendTerminalInput('test', 'chat', second.token, { type: 'key', key: 'Enter' }), /失效/);
    assert.equal((controller as any).watch.manualRecovery, true, 'Returning to a manually operated native pane must not ingest an unknown dialog');
    const third = (await controller.setTerminalControl('test', 'chat', true))!;
    paneId = '%2'; await pollNow(controller);
    assert.equal(snapshots.at(-1)!.terminalControl, undefined);
    await assert.rejects(controller.sendTerminalInput('test', 'chat', third.token, { type: 'text', text: 'stale' }), /失效/);
    controller.setTerminalVisible('test', 'chat', true);
    const hidden = (await controller.setTerminalControl('test', 'chat', true))!;
    controller.setTerminalVisible('test', 'chat', false);
    assert.equal(snapshots.at(-1)!.terminalControl, undefined, 'The last visible terminal releases even if another chat view still watches the session');
    await assert.rejects(controller.sendTerminalInput('test', 'chat', hidden.token, { type: 'key', key: 'Enter' }), /失效/);
    controller.setTerminalVisible('test', 'chat', true);
    const fourth = (await controller.setTerminalControl('test', 'chat', true))!;
    failure = true; await pollNow(controller);
    assert.equal(snapshots.at(-1)!.status, 'offline');
    await assert.rejects(controller.sendTerminalInput('test', 'chat', fourth.token, { type: 'key', key: 'Enter' }), /失效/);
    await assert.rejects(controller.setTerminalControl('test', 'chat', true), /已连接/);
    assert.equal(sends, 0);
  } finally { await cleanup(); }
});

test('manual acquire and input are serialized; uncertain input revokes ownership without retry or chat mutation', async () => {
  const { controller, cleanup } = await fakeController(async id => readResult(id));
  let finishVerify: () => void = () => {}, rejectSend: (error: Error) => void = () => {}, calls = 0;
  (controller.backend as any).verifyTerminalPane = () => new Promise<void>(resolve => { finishVerify = resolve; });
  (controller.backend as any).sendTerminalInput = () => { calls++; return new Promise<void>((_, reject) => { rejectSend = reject; }); };
  const snapshots: SessionSnapshot[] = []; controller.on('snapshot', value => snapshots.push(value));
  try {
    await controller.watchSession('test', 'chat');
    const acquiring = controller.setTerminalControl('test', 'chat', true);
    await assert.rejects(controller.sendMessage('test', 'chat', 'blocked'), /输入/);
    await assert.rejects(controller.setTerminalControl('test', 'chat', true), /执行/);
    await controller.watchSession('test', 'different'); finishVerify();
    await assert.rejects(acquiring, /变化/);
    assert.equal(snapshots.at(-1)!.terminalControl, undefined);
    (controller.backend as any).verifyTerminalPane = async () => {};
    const control = (await controller.setTerminalControl('test', 'different', true))!;
    const sending = controller.sendTerminalInput('test', 'different', control.token, { type: 'key', key: 'Enter' });
    await assert.rejects(controller.sendTerminalInput('test', 'different', control.token, { type: 'key', key: 'Enter' }), /执行/);
    await assert.rejects(controller.setTerminalControl('test', 'different', false, control.token), /执行/);
    rejectSend(new Error('SSH receipt lost after write'));
    await assert.rejects(sending, /receipt lost/);
    assert.equal(calls, 1);
    assert.equal(snapshots.at(-1)!.terminalControl, undefined);
    assert.deepEqual(snapshots.at(-1)!.messages, []);
  } finally { finishVerify(); rejectSend(new Error('cleanup')); await cleanup(); }
});
test('trust discovery stays read-only and only an explicit matching choice owns native input', async () => {
  const { controller, cleanup } = await fakeController(async id => waitingTrustResult(id));
  let actions = 0, finish: (value: unknown) => void = () => {};
  (controller.backend as any).respondDirectoryTrust = async () => { actions++; return new Promise(resolve => { finish = resolve; }); };
  const snapshots: SessionSnapshot[] = []; controller.on('snapshot', value => snapshots.push(value));
  try {
    const initial = await controller.watchSession('test', 'chat');
    assert.equal(initial.directoryTrust?.cwd, '/tmp');
    assert.equal(actions, 0);
    await assert.rejects(controller.respondDirectoryTrust('test', 'chat', 'stale-ticket', 'trust'), /变化/);
    assert.equal(actions, 0);
    const confirming = controller.respondDirectoryTrust('test', 'chat', 'trust-ticket', 'trust');
    assert.equal(snapshots.at(-1)!.trustBusy, true);
    await assert.rejects(controller.sendKey('test', 'chat', 'Enter'), /目录信任/);
    await assert.rejects(controller.sendMessage('test', 'chat', 'no concurrent input'), /输入/);
    assert.equal((await controller.getSessionSetting('test', 'chat', 'model')).sessionId, 'chat');
    await assert.rejects(controller.setSessionSetting('test', 'chat', 'unused', 'choice'), /设置操作|输入/);
    finish({ decision: 'trust', sessionId: 'chat', paneId: '%1', closed: true });
    await confirming;
    assert.equal(actions, 1);
    assert.equal(snapshots.at(-1)!.trustBusy, false);
    assert.equal(snapshots.at(-1)!.directoryTrust, undefined);
    assert.deepEqual(snapshots.at(-1)!.messages, []);
  } finally { finish(undefined); await cleanup(); }
});

test('explicit No stops watching the pre-history pane and stale trust completion does not change another session', async () => {
  let reads = 0;
  const { controller, cleanup } = await fakeController(async id => { reads++; return waitingTrustResult(id); });
  (controller.backend as any).respondDirectoryTrust = async () => ({ decision: 'exit', sessionId: 'chat', paneId: '%1', closed: true });
  try {
    await controller.watchSession('test', 'chat');
    await controller.respondDirectoryTrust('test', 'chat', 'trust-ticket', 'exit');
    await pause(1100);
    assert.equal(reads, 1, 'Explicit startup exit does not poll a nonexistent JSONL and report a false disconnect');
    let finish: (value: unknown) => void = () => {};
    (controller.backend as any).respondDirectoryTrust = () => new Promise(resolve => { finish = resolve; });
    const snapshots: SessionSnapshot[] = []; controller.on('snapshot', value => snapshots.push(value));
    await controller.watchSession('test', 'chat');
    const responding = controller.respondDirectoryTrust('test', 'chat', 'trust-ticket', 'exit');
    await controller.watchSession('test', 'new');
    finish({ decision: 'exit', sessionId: 'chat', paneId: '%1', closed: true });
    await responding;
    assert.equal(snapshots.at(-1)!.sessionId, 'new');
    assert.equal(snapshots.at(-1)!.trustBusy, false);
  } finally { await cleanup(); }
});

test('a notice appended under an unchanged permission dialog keeps the card and moves it to the newer record', async () => {
  // Claude Code 2.1.321 can write "Auto mode can't check actions …" (system/informational) after the
  // follow-up dialog is up. The card used to keep its first position, so the first click was refused.
  const { readFileSync } = await import('node:fs');
  const dialog = readFileSync(new URL('./fixtures/permission-2.1.328/bash.txt', import.meta.url), 'utf8');
  const prompt = { type: 'user', uuid: 'u1', parentUuid: null, sessionId: 'chat', message: { role: 'user', content: 'run the bash step' } };
  const call = { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 'chat', message: { id: 'm1', role: 'assistant', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'echo hello > greeting.txt && ls' } }] } };
  const notice = { parentUuid: 'a1', isSidechain: false, type: 'system', subtype: 'informational', level: 'warning', uuid: 'n1', sessionId: 'chat',
    content: "Auto mode can't check actions in this session. Actions that need the check now ask for your approval." };
  let records: unknown[] = [prompt, call], offset = 900;
  const { controller, cleanup } = await fakeController(async id => {
    const result = { ...readResult(id, records), screen: dialog, viewport: dialog, panePid: 77, nativeStatus: 'waiting' as const, nativeWaitingFor: 'permission prompt',
      transcriptPosition: { inode: '42', offset }, session: { ...readResult(id).session, status: 'waiting' as const } };
    records = [];
    return result;
  });
  const answered: unknown[][] = [];
  (controller.backend as any).answerPermission = async (...args: unknown[]) => { answered.push(args); };
  const snapshots: SessionSnapshot[] = []; controller.on('snapshot', value => snapshots.push(value));
  try {
    await controller.watchSession('test', 'chat');
    await pollNow(controller);
    const card = snapshots.at(-1)!.permission!;
    assert.equal(card.toolUseId, 'toolu_bash');
    records = [notice]; offset = 1793;
    await pollNow(controller);
    assert.equal(snapshots.at(-1)!.permission!.token, card.token, 'the same dialog for the same call keeps its token');
    await controller.answerPermission('test', 'chat', '%1', 77, card.token, { kind: 'choose', number: 1 });
    assert.deepEqual(answered[0][7], { inode: '42', offset: 1793 }, 'answered at the record the backend has read');
  } finally { await cleanup(); }
});

test('the main process refuses interactive built-ins and unknown skills before anything is typed', { timeout: 5000 }, async () => {
  const sent: string[] = [];
  const { controller, cleanup } = await fakeController(async id => readResult(id, []), async text => { sent.push(text); });
  try {
    await controller.watchSession('test', 'chat');
    await assert.rejects(controller.sendMessage('test', 'chat', '/config'), /交互界面/);
    await assert.rejects(controller.sendMessage('test', 'chat', '/model'), /模型/);
    await assert.rejects(controller.sendMessage('test', 'chat', '/not-installed now'), /不是这台机器上已安装/);
    assert.deepEqual(sent, []);
    await controller.sendMessage('test', 'chat', '/compact-review the diff');
    await controller.sendMessage('test', 'chat', '/tmp/notes.txt 里写了什么');
    assert.deepEqual(sent, ['/compact-review the diff', '/tmp/notes.txt 里写了什么']);
  } finally { await cleanup(); }
});

test('the diagnostic full-state digest input is byte-identical to serializing the whole state', async () => {
  const { fullStateJson } = await import('../src/main/controller');
  const messages = [{ id: 'm', role: 'user', text: '中文 "quoted" \\ \n', tools: [], source: 'jsonl', status: 'complete' }];
  for (const state of [
    { status: 'working' as const, paneId: '%1' },
    { status: 'idle' as const, paneId: undefined, notice: '注意', error: 'boom' },
    { status: 'error' as const, error: '' },
    {} as { status: 'idle' },
  ]) {
    const expected = JSON.stringify({ messages, status: state.status, paneId: (state as any).paneId, notice: (state as any).notice, error: (state as any).error });
    assert.equal(fullStateJson(JSON.stringify(messages), state), expected, JSON.stringify(state));
  }
});

test('a tool permission dialog becomes a card only for the pending call, and each token answers once', async () => {
  const { readFileSync } = await import('node:fs');
  const dialog = readFileSync(new URL('./fixtures/permission-2.1.328/bash.txt', import.meta.url), 'utf8');
  const prompt = { type: 'user', uuid: 'u1', parentUuid: null, sessionId: 'chat', message: { role: 'user', content: 'run the bash step' } };
  const call = { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 'chat', message: { id: 'm1', role: 'assistant', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'echo hello > greeting.txt && ls' } }] } };
  let records: unknown[] = [prompt, call], screen = dialog;
  const { controller, cleanup } = await fakeController(async id => {
    const result = { ...readResult(id, records), screen, viewport: screen, panePid: 77, nativeStatus: 'waiting' as const, nativeWaitingFor: 'permission prompt',
      session: { ...readResult(id).session, status: 'waiting' as const } };
    records = [];
    return result;
  });
  const answered: unknown[][] = [];
  (controller.backend as any).answerPermission = async (...args: unknown[]) => { answered.push(args); };
  const snapshots: SessionSnapshot[] = []; controller.on('snapshot', value => snapshots.push(value));
  try {
    await controller.watchSession('test', 'chat');
    await pollNow(controller);
    const card = snapshots.at(-1)!.permission!;
    assert.equal(card.title, 'Bash command');
    assert.equal(card.toolUseId, 'toolu_bash');
    assert.deepEqual(card.content, ['echo hello > greeting.txt && ls']);
    await pollNow(controller);
    assert.equal(snapshots.at(-1)!.permission!.token, card.token, 'the same dialog keeps its token');
    await controller.answerPermission('test', 'chat', '%1', 77, card.token, { kind: 'choose', number: 2 });
    assert.equal(answered.length, 1);
    assert.deepEqual(answered[0].slice(1, 4), ['chat', '%1', 77]);
    assert.equal((answered[0][4] as { title: string }).title, 'Bash command');
    assert.deepEqual(answered[0][5], { kind: 'choose', number: 2 });
    await assert.rejects(controller.answerPermission('test', 'chat', '%1', 77, card.token, { kind: 'cancel' }), /已更新/, 'a token answers once');
    // Once the call has a result, the same-looking text is no longer a decision.
    records = [{ type: 'user', uuid: 'r1', parentUuid: 'a1', sessionId: 'chat', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'ok' }] } }];
    await pollNow(controller);
    assert.equal(snapshots.at(-1)!.permission, undefined);
  } finally { await cleanup(); }
});

test('the billing notice behind a gateway, and a native dialog Lectern does not know, are cards before the transcript has the call', async () => {
  // Claude Code 2.1.329–2.1.330 write a streamed reply's call only after its dialog is answered: a user
  // behind a gateway saw the billing notice as a "dialog open" banner and had to take over the terminal.
  const { readFileSync } = await import('node:fs');
  const notice = readFileSync(new URL('./fixtures/auto-mode-billing-2.1.330/streamed.txt', import.meta.url), 'utf8');
  const mcp = readFileSync(new URL('./fixtures/native-dialog-2.1.330/mcp-server.txt', import.meta.url), 'utf8');
  const prompt = { type: 'user', uuid: 'u1', parentUuid: null, sessionId: 'chat', message: { role: 'user', content: 'Run the probe' } };
  const call = { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 'chat', message: { id: 'm1', role: 'assistant', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_probe', name: 'Bash', input: { command: "seq -w 1 3 | sed 's/$/ ccm-unchecked/' | tee unchecked-0.txt" } }] } };
  let records: unknown[] = [prompt], screen = notice, nativeStatus: 'waiting' | 'busy' | undefined = 'waiting', waitingFor: string | undefined = 'dialog open', offset = 300;
  const { controller, cleanup } = await fakeController(async id => {
    const result = { ...readResult(id, records), screen, viewport: screen, panePid: 77, nativeStatus, nativeWaitingFor: waitingFor, transcriptPosition: { inode: '42', offset },
      session: { ...readResult(id).session, status: 'waiting' as const } };
    records = [];
    return result;
  });
  const answered: unknown[][] = [];
  (controller.backend as any).answerPermission = async (...args: unknown[]) => { answered.push(args); };
  const snapshots: SessionSnapshot[] = []; controller.on('snapshot', value => snapshots.push(value));
  try {
    await controller.watchSession('test', 'chat');
    await pollNow(controller);
    const card = snapshots.at(-1)!.permission!;
    assert.equal(card.kind, 'auto-mode-billing');
    assert.equal(card.toolUseId, undefined, 'no call known yet');
    await pollNow(controller);
    assert.equal(snapshots.at(-1)!.permission!.token, card.token, 'the same dialog keeps its token');
    // Should the call be written while the notice is up, the same card takes it (token and identity kept).
    records = [call]; offset = 900;
    await pollNow(controller);
    const adopted = snapshots.at(-1)!.permission!;
    assert.deepEqual([adopted.token, adopted.cardId, adopted.toolUseId], [card.token, card.cardId, 'toolu_probe']);
    await controller.answerPermission('test', 'chat', '%1', 77, card.token, { kind: 'cancel' });
    assert.deepEqual(answered[0][5], { kind: 'cancel' });
    assert.deepEqual(answered[0][7], { inode: '42', offset: 900 }, 'bound to the transcript as read');
    // A dialog Lectern does not know becomes the generic card while Claude Code waits, whatever for.
    records = [{ type: 'user', uuid: 'r1', parentUuid: 'a1', sessionId: 'chat', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_probe', content: 'refused', is_error: true }] } }];
    screen = mcp;
    for (const what of ['dialog open', 'sandbox request', undefined]) {
      waitingFor = what;
      await pollNow(controller);
      const generic = snapshots.at(-1)!.permission!;
      assert.equal(generic?.kind, 'native-dialog', String(what));
      assert.equal(generic.title, 'New MCP server found in this project: demo-notes');
      assert.equal(generic.escape, 'cancel');
      assert.equal(generic.toolUseId, undefined);
    }
    nativeStatus = undefined;
    await pollNow(controller);
    assert.equal(snapshots.at(-1)!.permission, undefined, 'without the status record the text proves nothing');
    // Nor the billing notice's text without a call or Claude Code's "waiting".
    screen = notice;
    await pollNow(controller);
    assert.equal(snapshots.at(-1)!.permission, undefined);
  } finally { await cleanup(); }
});

/** The Bash dialog on screen while the transcript has only `records` so far (more via `next`). */
async function earlyDialog(native: { status?: 'waiting' | 'idle' | 'busy'; waitingFor?: string } = { status: 'waiting', waitingFor: 'permission prompt' }) {
  const { readFileSync } = await import('node:fs');
  const dialog = readFileSync(new URL('./fixtures/permission-2.1.328/bash.txt', import.meta.url), 'utf8');
  const state = { records: [{ type: 'user', uuid: 'u1', parentUuid: null, sessionId: 'chat', message: { role: 'user', content: 'run the bash step' } }] as unknown[],
    screen: dialog, offset: 400, native };
  const { controller, cleanup } = await fakeController(async id => {
    const result = { ...readResult(id, state.records), screen: state.screen, viewport: state.screen, panePid: 77,
      nativeStatus: state.native.status, nativeWaitingFor: state.native.waitingFor, transcriptPosition: { inode: '42', offset: state.offset },
      session: { ...readResult(id).session, status: 'waiting' as const } };
    state.records = [];
    return result;
  });
  const answered: unknown[][] = [];
  (controller.backend as any).answerPermission = async (...args: unknown[]) => { answered.push(args); };
  const snapshots: SessionSnapshot[] = []; controller.on('snapshot', value => snapshots.push(value));
  const call = { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 'chat', message: { id: 'm1', role: 'assistant', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'echo hello > greeting.txt && ls' } }] } };
  const result = { type: 'user', uuid: 'r1', parentUuid: 'a1', sessionId: 'chat', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'ok' }] } };
  await controller.watchSession('test', 'chat');
  return { controller, cleanup, state, answered, snapshots, call, result, dialog };
}

test('a permission dialog on screen before its call is in the transcript is a card; the call then takes it over', async () => {
  const { controller, cleanup, state, answered, snapshots, call, result, dialog } = await earlyDialog();
  try {
    await pollNow(controller);
    const card = snapshots.at(-1)!.permission!;
    assert.ok(card, 'Claude Code waits for a permission prompt: the dialog is a card without its call');
    assert.equal(card.toolUseId, undefined);
    assert.equal(card.title, 'Bash command');
    assert.deepEqual(card.content, ['echo hello > greeting.txt && ls']);
    assert.deepEqual(card.options.map(option => option.label.split(',')[0]), ['Yes', 'Yes', 'No']);
    await pollNow(controller);
    assert.equal(snapshots.at(-1)!.permission!.token, card.token, 'the same dialog keeps its token');
    // The transcript catches up: the same card (token and identity) now names its call, once.
    state.records = [call]; state.offset = 1300;
    await pollNow(controller);
    const adopted = snapshots.at(-1)!.permission!;
    assert.deepEqual([adopted.token, adopted.cardId, adopted.toolUseId], [card.token, card.cardId, 'toolu_bash']);
    assert.equal(snapshots.at(-1)!.messages.filter(message => message.tools.some(tool => tool.id === 'toolu_bash')).length, 1);
    await controller.answerPermission('test', 'chat', '%1', 77, card.token, { kind: 'choose', number: 1 });
    assert.deepEqual(answered.map(args => [args[5], args[7]]), [[{ kind: 'choose', number: 1 }, { inode: '42', offset: 1300 }]], 'answered at the newer record');
    // Answered: the result arrives while a late frame still shows the dialog. Not a question again.
    state.records = [result]; state.offset = 1500;
    await pollNow(controller);
    assert.equal(snapshots.at(-1)!.permission, undefined);
    await pollNow(controller);
    assert.equal(snapshots.at(-1)!.permission, undefined, 'still the dialog that had its call');
    // Once the dialog has gone, a new one may again come before its call.
    state.screen = '──────────\n❯ \n──────────';
    await pollNow(controller);
    state.screen = dialog;
    await pollNow(controller);
    assert.equal(snapshots.at(-1)!.permission?.toolUseId, undefined);
    assert.ok(snapshots.at(-1)!.permission, 'the next dialog before its call');
  } finally { await cleanup(); }
});

test('a card read off the screen alone answers like any other, bound to the transcript as read', async () => {
  const { controller, cleanup, answered, snapshots } = await earlyDialog();
  try {
    await pollNow(controller);
    const card = snapshots.at(-1)!.permission!;
    await controller.answerPermission('test', 'chat', '%1', 77, card.token, { kind: 'choose', number: 3 });
    assert.equal(answered.length, 1);
    assert.equal((answered[0][4] as { title: string }).title, 'Bash command', 'the driver checks the live screen against this dialog');
    assert.deepEqual(answered[0][7], { inode: '42', offset: 400 }, 'and refuses if the transcript moved meanwhile');
    await assert.rejects(controller.answerPermission('test', 'chat', '%1', 77, card.token, { kind: 'cancel' }), /已更新/, 'a token answers once');
  } finally { await cleanup(); }
});

test('a card read off the screen alone, clicked while Claude Code writes its call, takes the call and sends the same answer once more', async () => {
  const { TranscriptChangedNoKeys } = await import('../src/backend/native-settings');
  const { controller, cleanup, state, snapshots, call, result } = await earlyDialog();
  const positions: unknown[] = [];
  (controller.backend as any).answerPermission = async (...args: unknown[]) => {
    positions.push([args[5], args[7]]);
    if (positions.length === 1) { state.records = [call]; state.offset = 1300; throw new TranscriptChangedNoKeys(); }
  };
  try {
    await pollNow(controller);
    const card = snapshots.at(-1)!.permission!;
    assert.equal(card.toolUseId, undefined);
    await controller.answerPermission('test', 'chat', '%1', 77, card.token, { kind: 'choose', number: 1 });
    assert.deepEqual(positions, [[{ kind: 'choose', number: 1 }, { inode: '42', offset: 400 }], [{ kind: 'choose', number: 1 }, { inode: '42', offset: 1300 }]]);
    // The call has its result while a late frame still shows the dialog: it was owned, so no card.
    state.records = [result]; state.offset = 1500;
    await pollNow(controller);
    assert.equal(snapshots.at(-1)!.permission, undefined);
    // Refused on each try: sent again once, then reported (nothing was sent).
    state.screen = '──────────\n❯ \n──────────';
    await pollNow(controller);
    state.screen = (await import('node:fs')).readFileSync(new URL('./fixtures/permission-2.1.328/bash.txt', import.meta.url), 'utf8');
    await pollNow(controller);
    const next = snapshots.at(-1)!.permission!;
    let refused = 0;
    (controller.backend as any).answerPermission = async () => { refused++; throw new TranscriptChangedNoKeys(); };
    await assert.rejects(controller.answerPermission('test', 'chat', '%1', 77, next.token, { kind: 'cancel' }), TranscriptChangedNoKeys);
    assert.equal(refused, 2);
    assert.equal(snapshots.at(-1)!.permission?.token, next.token, 'the card stands for another try');
  } finally { await cleanup(); }
});

test('without Claude Code waiting for a permission prompt, a dialog-like screen with no pending call is no card', async () => {
  for (const native of [{}, { status: 'idle' as const }, { status: 'busy' as const }, { status: 'waiting' as const },
    { status: 'waiting' as const, waitingFor: 'dialog open' }, { status: 'waiting' as const, waitingFor: 'input needed' }]) {
    const { controller, cleanup, snapshots } = await earlyDialog(native);
    try {
      await pollNow(controller);
      assert.equal(snapshots.at(-1)!.permission, undefined, JSON.stringify(native));
    } finally { await cleanup(); }
  }
});
