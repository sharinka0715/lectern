import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Backend, ReadResult } from '../src/backend';
import { Controller } from '../src/main/controller';
import { WorkspaceStore } from '../src/main/store';
import { MessageDisplay } from '../src/core/message-display';
import type { NativeStatusLineObservation, Workspace } from '../src/shared/types';

const composer = '──────────────────────────\n❯ \n──────────────────────────\n  ? for shortcuts';
const workspace: Workspace = { id: 'quota-test', name: 'Project A', kind: 'local', cwd: '/tmp' };
const session = '11111111-2222-4333-8444-555555555555';
// 2026-11-23 10:00 UTC.
const t0 = Date.UTC(2026, 10, 23, 10, 0);
const iso = (ms: number) => new Date(ms).toISOString();

let n = 0;
const record = (type: string, at: number, fields: Record<string, unknown> = {}) => JSON.stringify({
  type, uuid: `u${++n}`, parentUuid: n > 1 ? `u${n - 1}` : null, sessionId: session, timestamp: iso(at), isSidechain: false,
  message: type === 'assistant' ? { id: `msg${n}`, role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn',
    usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } : { role: 'user', content: 'Hello' },
  ...fields,
}) + '\n';

test('the newest reply counts only real replies of the main conversation', () => {
  const display = new MessageDisplay(session);
  display.ingestJsonl(record('user', t0 - 10_000) + record('assistant', t0 - 9000));
  assert.equal(display.lastReplyAt, t0 - 9000);
  display.ingestJsonl([
    record('assistant', t0 - 1000, { isApiErrorMessage: true }),
    record('assistant', t0 - 900, { message: { model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } }),
    record('assistant', t0 - 800, { isSidechain: true }),
    record('assistant', t0 - 700, { sessionId: '99999999-2222-4333-8444-555555555555' }),
    record('user', t0 - 600),
  ].join(''));
  assert.equal(display.lastReplyAt, t0 - 9000);
  // An older page read later does not move it back.
  display.ingestJsonl(record('assistant', t0 - 60_000));
  assert.equal(display.lastReplyAt, t0 - 9000);
  display.ingestJsonl('', true);
  assert.equal(display.lastReplyAt, undefined, 'a replaced transcript is read again');
});

async function harness(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'lectern-controller-quota-'));
  const store = new WorkspaceStore(directory);
  await store.save(workspace);
  let clock = t0;
  t.mock.method(Date, 'now', () => clock);
  const next: { jsonl: string; line?: Partial<NativeStatusLineObservation>; startedAt?: number } = { jsonl: '' };
  const backend = {
    async readSession(): Promise<ReadResult> {
      const jsonl = Buffer.from(next.jsonl);
      next.jsonl = '';
      return { session: { id: session, title: 'chat', mapping: 'exact', paneId: '%1', status: 'idle' }, screen: composer, viewport: composer,
        jsonl, reset: false, active: true, hasMore: false, panePid: 4242, runtimeInstanceId: 'instance', nativeStartedAt: next.startedAt,
        statusLineManaged: true, ...(next.line && { statusLine: { sessionId: session, modelId: 'claude-test', ...next.line } }) };
    },
    async probeModelCatalog() { throw new Error('not needed'); },
    async discover(ws: Workspace) { return { workspace: ws, sessions: [], panes: [] }; },
    invalidateWorkspace() {}, resetRead() {}, async dispose() {},
  } as unknown as Backend;
  const controller = new Controller(store, backend);
  const sibling = controller.sibling();
  t.after(async () => { await sibling.detach(); await controller.dispose(); await rm(directory, { recursive: true, force: true }); });
  const poll = async (target = controller) => {
    const internals = target as any;
    clearTimeout(internals.timer);
    await internals.poll(internals.watch);
    clearTimeout(internals.timer);
    return target.currentSnapshot!.statusLine;
  };
  return { controller, sibling, next, poll, at: (ms: number) => { clock = ms; } };
}

const five = (used: number) => ({ fiveHour: { usedPercentage: used, resetsAt: t0 / 1000 + 4 * 3600 } });

test('the snapshot dates the 5h/7d figures by the transcript, the process and what the reads saw', async t => {
  const h = await harness(t);
  // Opened with a reply from 40 minutes ago in the transcript.
  h.next.jsonl = record('user', t0 - 41 * 60_000) + record('assistant', t0 - 40 * 60_000);
  h.next.line = five(30);
  await h.controller.watchSession(workspace.id, session);
  let line = await h.poll();
  assert.equal(line?.quotaAsOf, (t0 - 40 * 60_000) / 1000);
  // A new reply, then the figures change while Lectern reads every second: dated by that read.
  h.at(t0 + 1000);
  h.next.jsonl = record('user', t0 + 200) + record('assistant', t0 + 800);
  await h.poll();
  h.at(t0 + 2000);
  h.next.line = five(31.5);
  line = await h.poll();
  assert.equal(line?.quotaAsOf, (t0 + 2000) / 1000);
  // Unchanged figures keep that time.
  h.at(t0 + 90_000);
  assert.equal((await h.poll())?.quotaAsOf, (t0 + 2000) / 1000);
  // Figures that change without a reply (a resize ran the status line) are not dated by the read.
  h.at(t0 + 91_000);
  h.next.line = five(33);
  assert.equal((await h.poll())?.quotaAsOf, (t0 + 2000) / 1000);
  // The same process read by another reader (the conversation reopened elsewhere) keeps what was seen.
  await h.controller.detach();
  h.at(t0 + 95_000);
  await h.sibling.watchSession(workspace.id, session);
  assert.equal((await h.poll(h.sibling))?.quotaAsOf, (t0 + 2000) / 1000);
  // No figures: nothing to date.
  h.next.line = {};
  assert.equal((await h.poll(h.sibling))?.quotaAsOf, undefined);
});

test('a resumed process dates its first figures by its start', async t => {
  const h = await harness(t);
  h.next.jsonl = record('user', t0 - 3 * 86400_000) + record('assistant', t0 - 3 * 86400_000 + 5000);
  h.next.line = five(12);
  h.next.startedAt = t0 - 120_000;
  await h.controller.watchSession(workspace.id, session);
  assert.equal((await h.poll())?.quotaAsOf, (t0 - 120_000) / 1000);
});

test('figures with no reply in the transcript and no start time are not dated', async t => {
  const h = await harness(t);
  h.next.line = five(12);
  await h.controller.watchSession(workspace.id, session);
  const line = await h.poll();
  assert.equal(line?.fiveHour?.usedPercentage, 12);
  assert.equal(line?.quotaAsOf, undefined);
});
