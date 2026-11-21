import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Controller } from '../src/main/controller';
import { WorkspaceStore } from '../src/main/store';
import type { Backend, ReadResult } from '../src/backend';
import type { SessionSnapshot } from '../src/shared/types';
import { closeDiagnostics, configureDiagnostics, flushDiagnostics, summarize } from '../src/diagnostics';
import { replayDiagnostics, replayEntries, type DiagnosticEntry } from '../scripts/replay-diagnostics';

const sessionId = 'replay-session';
const input = '你好 🧭';
const finalText = '你好，世界 🧭\n\n**JSONL 正文**完整保留。';
const user = { type: 'user', uuid: 'u1', sessionId, timestamp: '2026-11-17T00:00:00Z', message: { content: input } };
const assistant = { type: 'assistant', uuid: 'a1', sessionId, timestamp: '2026-11-17T00:00:01Z', message: { content: [{ type: 'text', text: finalText }], stop_reason: 'end_turn' } };

test('manual terminal replay classifies raw prompts without importing menu text and verifies the recorded classification', () => {
  const entries: DiagnosticEntry[] = [];
  const context = { watchId: 'manual-watch', sessionId };
  const record = (event: string, data: Record<string, unknown>) => entries.push({ schemaVersion: 1, runId: 'manual-run', seq: entries.length + 1, event, context, data });
  const checkpoint = (reason: string, status: string) => record('controller.snapshot', { reason, status, paneId: '%1', messageCount: 0,
    messagesDigest: summarize('[]'), fullStateDigest: summarize(JSON.stringify({ messages: [], status, paneId: '%1' })) });
  record('controller.watch.start', {});
  record('controller.poll.apply', { jsonl: summarize(''), active: true, screenApplied: false, paneId: '%1' });
  checkpoint('poll', 'idle'); checkpoint('terminal-control-start', 'idle');
  const screen = 'This is a native notice, not an assistant response.\nEnter to continue · Esc to cancel';
  record('capture.viewport', { captureId: 'native-notice', encoding: 'utf8', content: screen, ...summarize(screen) });
  record('controller.poll.apply', { jsonl: summarize(''), active: true, paneId: '%1', screenApplied: false,
    viewportCaptureId: 'native-notice', viewport: summarize(screen), manualRecovery: true, terminalControlActive: true,
    observedStatusSource: 'viewport', observedStatus: 'waiting' });
  checkpoint('poll', 'waiting'); checkpoint('terminal-control-end', 'waiting');
  checkpoint('terminal-input-failed', 'waiting');
  const replay = replayEntries(entries).watches[0];
  assert.equal(replay.validation.matched, 5); assert.equal(replay.validation.mismatched, 0);
  assert.deepEqual(replay.messages, []); assert.equal(replay.status, 'waiting');
  const modified = structuredClone(entries);
  modified.find(e => e.data.observedStatus === 'waiting')!.data.observedStatus = 'idle';
  assert.ok(replayEntries(modified).watches[0].validation.mismatched > 0, 'Replay must derive status from the captured frame, not trust logged metadata');
});

test('snapshot checkpoints verify each tool call position', () => {
  const content = [user, { ...assistant, message: { stop_reason: 'end_turn', content: [
    { type: 'tool_use', id: 'read', name: 'Read', input: {} }, { type: 'text', text: finalText },
  ] } }].map(row => JSON.stringify(row)).join('\n') + '\n';
  const entries: DiagnosticEntry[] = [];
  const record = (event: string, data: Record<string, unknown>) => entries.push({ schemaVersion: 1, runId: 'ordered',
    seq: entries.length + 1, event, context: { watchId: 'watch', sessionId }, data });
  record('controller.watch.start', {});
  record('capture.jsonl', { captureId: 'rows', encoding: 'utf8', content, ...summarize(content) });
  record('controller.poll.apply', { jsonl: summarize(content), jsonlCaptureId: 'rows', active: false });
  record('controller.snapshot', { reason: 'poll', status: 'idle', messageCount: 2 });
  const projected = replayEntries(entries).watches[0].messages;
  assert.equal(projected[1].tools[0].textOffset, 0);
  const withoutPosition = structuredClone(projected);
  delete withoutPosition[1].tools[0].textOffset;
  const checkpoint = entries.at(-1)!.data;
  checkpoint.messagesDigest = summarize(JSON.stringify(withoutPosition));
  checkpoint.fullStateDigest = summarize(JSON.stringify({ messages: withoutPosition, status: 'idle' }));
  assert.equal(replayEntries(entries).watches[0].validation.mismatched, 1, 'a digest without the call position does not match');
  checkpoint.messagesDigest = summarize(JSON.stringify(projected));
  checkpoint.fullStateDigest = summarize(JSON.stringify({ messages: projected, status: 'idle' }));
  assert.equal(replayEntries(entries).watches[0].validation.matched, 1);
});

test('settings lifecycle publications preserve offline presentation and do not apply menu captures', () => {
  const entries: DiagnosticEntry[] = [];
  const context = { watchId: 'settings-watch', sessionId };
  function record(event: string, data: Record<string, unknown>) {
    entries.push({ schemaVersion: 1, runId: 'settings-run', seq: entries.length + 1,
      timestamp: '2026-11-17T00:00:00Z', event, context, data });
  }
  function checkpoint(reason: string, status: 'idle' | 'offline', error?: string) {
    const messages: unknown[] = [];
    record('controller.snapshot', { reason, status, error, paneId: '%1', messageCount: 0,
      messagesDigest: summarize(JSON.stringify(messages)),
      fullStateDigest: summarize(JSON.stringify({ messages, status, paneId: '%1', error })) });
  }
  record('controller.watch.start', {});
  record('controller.poll.apply', { jsonl: summarize(''), active: true, screenApplied: false, paneId: '%1' });
  checkpoint('poll', 'idle');
  checkpoint('settings-start', 'idle');
  const screen = 'Select model\n❯ 1. Dynamically observed model ✔\nEnter to set as default · s to use this session only · Esc to cancel';
  record('capture.screen', { captureId: 'menu', encoding: 'utf8', content: screen, ...summarize(screen), redacted: false, truncated: false });
  record('controller.poll.apply', { jsonl: summarize(''), active: true, screenApplied: false, paneId: '%1', screenCaptureId: 'menu', screen: summarize(screen) });
  checkpoint('poll', 'idle');
  record('controller.poll.failed', { error: { name: 'Error', message: 'SSH disconnected during menu inspection' } });
  checkpoint('poll', 'offline', 'SSH disconnected during menu inspection');
  checkpoint('settings-end', 'offline', 'SSH disconnected during menu inspection');
  const replayed = replayEntries(entries).watches[0];
  assert.equal(replayed.complete, true);
  assert.deepEqual(replayed.validation, { checked: 5, matched: 5, mismatched: 0, unverifiable: 0 });
  assert.deepEqual(replayed.messages, []);
  assert.equal(replayed.status, 'offline');
});

test('recorded Controller captures replay exact messages, partial UTF8, cached screens and malformed-line notice', { timeout: 9000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lectern-replay-'));
  const logs = path.join(directory, 'logs');
  const store = new WorkspaceStore(path.join(directory, 'preferences'));
  await store.save({ id: 'test', name: 'Replay test', kind: 'local', cwd: '/tmp' });
  const bytes = Buffer.from(JSON.stringify(assistant) + '\n');
  const split = bytes.indexOf(Buffer.from('🧭')) + 1;
  const first = Buffer.concat([Buffer.from(JSON.stringify(user) + '\n{malformed}\n'), bytes.subarray(0, split)]);
  let sent = false, readsAfterSend = 0;
  const response = (jsonl: Buffer, reset: boolean): ReadResult => ({
    session: { id: sessionId, title: 'Replay', paneId: '%1', mapping: 'exact' },
    // The full scrollback deliberately keeps a stale spinner after completion.
    screen: sent ? `❯ ${input}\n\n⏺ ${finalText}\n✻ Thinking… (esc to interrupt)\n────────────\n❯ \n────────────\n\n\n` : '────────────\n❯ \n────────────\n\n',
    viewport: sent && readsAfterSend === 1 ? '✻ Thinking… (esc to interrupt)\n────────────\n❯ \n────────────\n'
      : '────────────\n❯ \n────────────\n\n',
    jsonl, reset, active: true, hasMore: false,
  });
  const backend = {
    resetRead() {}, dispose() {},
    async readSession() {
      if (!sent) return response(Buffer.alloc(0), true);
      readsAfterSend++;
      return response(readsAfterSend === 1 ? first : readsAfterSend === 2 ? bytes.subarray(split) : Buffer.alloc(0), readsAfterSend === 1);
    },
    async sendMessage() { sent = true; },
  } as unknown as Backend;
  const controller = new Controller(store, backend);
  configureDiagnostics({ directory: logs, captureContent: true, maxFileBytes: 8192, maxFiles: 30 });
  let final: SessionSnapshot | undefined;
  let finish: () => void = () => {};
  const completed = new Promise<void>(resolve => { finish = resolve; });
  controller.on('snapshot', (snapshot: SessionSnapshot) => {
    if (snapshot.messages.at(-1)?.source === 'jsonl' && snapshot.messages.at(-1)?.role === 'assistant') { final = snapshot; finish(); }
  });
  try {
    await controller.watchSession('test', sessionId);
    await controller.sendMessage('test', sessionId, input);
    await completed;
    await controller.dispose();
    await flushDiagnostics();
    await closeDiagnostics();
    const report = await replayDiagnostics(logs);
    assert.equal(report.watches.length, 1);
    assert.ok(report.files.length > 1, 'Fixture exercises rotated-file ordering without evicting older records');
    const replayed = report.watches[0];
    assert.equal(replayed.complete, true, JSON.stringify(report));
    assert.equal(replayed.validation.mismatched, 0, JSON.stringify(replayed.trace));
    assert.equal(replayed.validation.unverifiable, 0);
    assert.ok(replayed.validation.matched >= 4);
    assert.deepEqual(replayed.messages, final!.messages);
    assert.equal(replayed.notice, final!.notice);
    assert.match(replayed.notice!, /1/);
    assert.equal(replayed.messages[1].text, finalText);
    assert.equal(replayed.status, 'idle', 'Current viewport must override the old spinner retained in full scrollback');
    const entries: DiagnosticEntry[] = [];
    for (const filename of (await readdir(logs)).filter(name => /^events\.\d+\.jsonl$/.test(name))) {
      const lines = (await readFile(path.join(logs, filename), 'utf8')).trim().split('\n');
      entries.push(...lines.map(line => JSON.parse(line)));
    }
    const applies = entries.filter(entry => entry.event === 'controller.poll.apply').sort((a, b) => a.seq - b.seq);
    assert.equal(applies.at(-1)!.data.screenCaptureId, applies.at(-2)!.data.screenCaptureId, 'An unchanged screen is referenced and reapplied without a duplicate raw capture');
    assert.equal(applies.at(-1)!.data.viewportApplied, true);
    assert.notEqual(applies.at(-1)!.data.viewportCaptureId, applies.at(-2)!.data.viewportCaptureId, 'Fresh viewport is recorded even when full scrollback is unchanged');
    const invalid = entries.find(entry => entry.event === 'jsonl.decoder.skipped' && entry.data.reason === 'invalid-json');
    assert.ok(invalid);
    assert.equal(JSON.stringify(invalid).includes('{malformed}'), false, 'Metadata does not duplicate raw malformed content outside captures');

    await t.test('missing raw bytes report incomplete replay, never a lossless success', () => {
      const removed = entries.filter(entry => !(entry.event === 'capture.jsonl' && entry.data.bytes !== 0));
      const partial = replayEntries(removed).watches[0];
      assert.equal(partial.complete, false);
      assert.ok(partial.validation.unverifiable > 0);
      assert.equal(partial.validation.matched, 0);
      assert.match(partial.warnings.join('\n'), /capture|gap/);
    });
    await t.test('redacted and truncated source captures are explicitly rejected', () => {
      for (const flag of ['redacted', 'truncated']) {
        const changed = structuredClone(entries);
        changed.find(entry => entry.event === 'capture.input')!.data[flag] = true;
        const partial = replayEntries(changed).watches[0];
        assert.equal(partial.complete, false);
        assert.match(partial.warnings.join('\n'), new RegExp(flag));
        assert.equal(partial.validation.matched, 0);
      }
    });
    await t.test('missing watch start is reported even when later checkpoints happen to match', () => {
      const changed = entries.filter(entry => entry.event !== 'controller.watch.start');
      const partial = replayEntries(changed).watches[0];
      assert.equal(partial.complete, false);
      assert.match(partial.warnings.join('\n'), /Watch start is missing/);
    });
    await t.test('a changed expected message digest produces an actionable mismatch', () => {
      const changed = structuredClone(entries);
      const snapshot = changed.filter(entry => entry.event === 'controller.snapshot').sort((a, b) => a.seq - b.seq).at(-1)!;
      (snapshot.data.messagesDigest as { sha256: string }).sha256 = 'f'.repeat(64);
      const bad = replayEntries(changed).watches[0];
      assert.equal(bad.complete, true);
      assert.equal(bad.validation.mismatched, 1);
      assert.match(bad.warnings.join('\n'), /Snapshot mismatch/);
    });
    await t.test('session and watch filters do not mix parallel conversation traces', () => {
      assert.equal(replayEntries(entries, { sessionId: 'not-this-session' }).watches.length, 0);
      assert.equal(replayEntries(entries, { watchId: replayed.watchId }).watches.length, 1);
    });
    await t.test('self-consistent but wrongly referenced raw captures fail expected-input verification', () => {
      for (const kind of ['jsonl', 'screen', 'viewport', 'input']) {
        const changed = structuredClone(entries);
        const capture = changed.find(entry => entry.event === `capture.${kind}` && entry.data.bytes !== 0)!;
        const replacement = Buffer.from('different input');
        Object.assign(capture.data, summarize(replacement), { capturedBytes: replacement.length,
          content: capture.data.encoding === 'base64' ? replacement.toString('base64') : replacement.toString('utf8') });
        const bad = replayEntries(changed).watches[0];
        assert.equal(bad.complete, false);
        assert.match(bad.warnings.join('\n'), /expected reducer-input digest/);
      }
    });
  } finally {
    await controller.dispose();
    await closeDiagnostics();
    configureDiagnostics();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a capture of a paged history replays the tail and prepended records in chronological order', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lectern-replay-history-pages-'));
  const logs = path.join(directory, 'logs');
  const store = new WorkspaceStore(path.join(directory, 'preferences'));
  await store.save({ id: 'paged', name: 'Paged history', kind: 'local', cwd: '/tmp' });
  const tailUser = { ...user, uuid: 'u2', parentUuid: assistant.uuid, message: { content: '第二个问题' } };
  const rows = (...records: object[]) => Buffer.from(records.map(row => JSON.stringify(row)).join('\n') + '\n');
  const backend = {
    resetRead() {}, dispose() {},
    async readSession(): Promise<ReadResult> {
      return { session: { id: sessionId, title: 'History', mapping: 'unbound' }, active: false, hasMore: false, screen: '',
        reset: true, jsonl: rows(tailUser), olderCursor: { before: 400, size: 800, inode: '37' } };
    },
    async readOlderHistory(_workspace: unknown, _session: string, cursor: { before: number }) {
      return cursor.before === 400
        ? {jsonl: rows({...user, parentUuid:'a0'}, {...assistant, parentUuid:user.uuid}), olderCursor:{...cursor, before:100}}
        : {jsonl: rows({...user, uuid:'u0'}, {...assistant, uuid:'a0', parentUuid:'u0'}), skippedHistoryRecords:1};
    },
  } as unknown as Backend;
  const controller = new Controller(store, backend);
  configureDiagnostics({ directory: logs, captureContent: true });
  try {
    const tail = await controller.watchSession('paged', sessionId);
    const expanded = await controller.loadEarlierMessages('paged', sessionId, tail.historyPage!.cursor);
    assert.deepEqual(tail.messages.map(message => message.text), [input, finalText, '第二个问题']);
    assert.deepEqual(expanded.messages.map(message => message.text), [input, finalText, input, finalText, '第二个问题']);
    await controller.dispose();
    await flushDiagnostics();
    await closeDiagnostics();
    const [replay] = (await replayDiagnostics(logs)).watches;
    assert.equal(replay.complete, true);
    assert.deepEqual(replay.validation, { checked: 2, matched: 2, mismatched: 0, unverifiable: 0 });
    assert.deepEqual(replay.messages, expanded.messages);
    assert.equal(replay.notice, expanded.notice);
    assert.ok(replay.trace.some(entry => entry.event === 'controller.history.prepend'));
  } finally {
    await controller.dispose();
    await closeDiagnostics();
    configureDiagnostics();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a named pane-mapping conflict replays as an error rather than a transport disconnection', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lectern-replay-mapping-'));
  const logs = path.join(directory, 'logs');
  const store = new WorkspaceStore(path.join(directory, 'preferences'));
  await store.save({ id: 'test', name: 'Mapping test', kind: 'local', cwd: '/tmp' });
  const conflict = new Error('Multiple live Claude panes claim this session');
  conflict.name = 'SessionMappingError';
  const backend = { resetRead() {}, dispose() {}, async readSession() { throw conflict; } } as unknown as Backend;
  const controller = new Controller(store, backend);
  configureDiagnostics({ directory: logs, captureContent: true });
  try {
    const snapshot = await controller.watchSession('test', 'mapping-session');
    assert.equal(snapshot.status, 'error');
    assert.equal(snapshot.error, conflict.message);
    await controller.dispose();
    await flushDiagnostics();
    await closeDiagnostics();
    const report = await replayDiagnostics(logs);
    assert.equal(report.watches.length, 1);
    assert.equal(report.watches[0].status, 'error');
    assert.equal(report.watches[0].complete, true);
    assert.deepEqual(report.watches[0].validation, { checked: 1, matched: 1, mismatched: 0, unverifiable: 0 });
    assert.deepEqual(report.watches[0].messages, []);
  } finally {
    await controller.dispose();
    await closeDiagnostics();
    configureDiagnostics();
    await rm(directory, { recursive: true, force: true });
  }
});
