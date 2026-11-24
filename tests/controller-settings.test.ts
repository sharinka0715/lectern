import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionMappingError, type Backend, type ReadResult } from '../src/backend';
import { Controller } from '../src/main/controller';
import { WorkspaceStore } from '../src/main/store';
import { settingMenuNeedsRefresh } from '../src/shared/session-setting-ticket';
import type { SessionSettingKind, SessionSettingSnapshot, Workspace } from '../src/shared/types';
import type { ModelCatalog } from '../src/shared/model-catalog';
import type { SettingChoices } from '../src/backend/native-settings';

const composer = '──────────────────────────\n❯ \n──────────────────────────\n  ? for shortcuts';
const workspace: Workspace = { id: 'settings-test', name: 'Project A', kind: 'local', cwd: '/tmp' };
const tick = () => new Promise(resolve => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function idle(sessionId: string, paneId = '%1'): ReadResult {
  return { session: { id: sessionId, title: sessionId, mapping: 'exact', paneId, status: 'idle' },
    screen: composer, viewport: composer, jsonl: Buffer.alloc(0), reset: false, active: true, hasMore: false };
}
/** The machine's model list as Claude Code's SDK reports it. */
function catalog(): ModelCatalog {
  return { observedAt: '2020-01-01T00:00:00Z', version: '9.9.9', defaults: { model: 'query-code', effort: 'low' }, models: [
    { value: 'query-model', resolvedModel: 'query-code', label: 'Query model', efforts: ['low', 'high'] },
    { value: 'business-model', resolvedModel: 'business-code', label: 'Business model', efforts: ['low', 'high'] },
  ] };
}

async function harness(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'lectern-controller-settings-'));
  const store = new WorkspaceStore(directory);
  await store.save(workspace);
  const states = new Map<string, ReadResult>();
  const probes: string[] = [], writes: string[] = [], launches: unknown[] = [];
  let ticket = 0;
  const tickets = new Map<string, SessionSettingSnapshot>();
  const hooks = {
    probe: async (_ws: Workspace) => catalog(),
    read: async (_ws: Workspace, id: string) => states.get(id) ?? idle(id),
    apply: async (bound: SessionSettingSnapshot, id: string): Promise<SessionSettingSnapshot> => ({
      ...bound, currentOptionId: id, options: bound.options.map(option => ({ ...option, current: option.id === id })),
    }),
  };
  const backend = {
    async probeModelCatalog(ws: Workspace) { probes.push(ws.id); return hooks.probe(ws); },
    bindSettingChoices(_ws: Workspace, sessionId: string, paneId: string, choices: SettingChoices) {
      const token = 'native-' + ++ticket;
      const bound: SessionSettingSnapshot = { kind: choices.kind, command: choices.command, complete: choices.complete, token, sessionId, paneId, observedAt: '',
        options: choices.options.map((option, index) => ({ id: token + ':' + index, label: option.label, description: option.description, current: false })) };
      tickets.set(token, bound);
      return bound;
    },
    async setSessionSetting(_ws: Workspace, sessionId: string, token: string, optionId: string) {
      const bound = tickets.get(token)!;
      assert.equal(bound.sessionId, sessionId);
      assert.ok(bound.options.some(option => option.id === optionId));
      tickets.delete(token);
      writes.push('set:' + sessionId);
      return hooks.apply(bound, optionId);
    },
    async verifyTerminalPane() {}, async sendMessage() { writes.push('message'); }, async sendKey() { writes.push('key'); },
    async readSession(ws: Workspace, id: string) { return hooks.read(ws, id); },
    async createSession(_ws: Workspace, choices: unknown) { launches.push(choices); return idle('new').session; }, async resumeSession(_ws: Workspace, id: string) { return idle(id).session; },
    async discover(ws: Workspace) { return { workspace: ws, sessions: [], panes: [{ active: true, managed: true }] }; },
    invalidateWorkspace() {}, resetRead() {}, async dispose() {},
  } as unknown as Backend;
  const controller = new Controller(store, backend);
  const sibling = controller.sibling();
  t.after(async () => { await sibling.detach(); await controller.dispose(); await rm(directory, { recursive: true, force: true }); });
  const watch = (id = 'chat') => controller.watchSession(workspace.id, id);
  const read = (kind: SessionSettingKind, id = 'chat') => controller.getSessionSetting(workspace.id, id, kind);
  const apply = (value: SessionSettingSnapshot, index: number, id = 'chat') =>
    controller.setSessionSetting(workspace.id, id, value.token, value.options[index].id);
  const poll = async () => {
    const internals = controller as any;
    clearTimeout(internals.timer);
    await internals.poll(internals.watch);
  };
  return { controller, sibling, store, states, hooks, probes, writes, launches, watch, read, apply, poll,
    latest: () => controller.currentSnapshot! };
}

test('local folders are read at startup, an SSH machine once it connects, once per machine and Claude configuration', async t => {
  const h = await harness(t);
  await h.store.save({ ...workspace, id: 'same-machine', cwd: '/elsewhere' });
  await h.store.save({ ...workspace, id: 'ssh1', kind: 'ssh', host: 'host' });
  await h.store.save({ ...workspace, id: 'ssh2', kind: 'ssh', host: 'host', cwd: '/var' });
  await h.store.save({ ...workspace, id: 'ssh-port', kind: 'ssh', host: 'host', port: 2222 });
  h.controller.warmModelCatalogs(); await tick();
  assert.deepEqual(h.probes, [workspace.id], 'no SSH machine before it connects');
  await h.controller.modelCatalog('same-machine', false, '/sample.json');
  await h.controller.modelCatalog(workspace.id, false, '/sample.json');
  for (const id of ['ssh1', 'ssh2', 'ssh-port']) await h.controller.discover(id);
  await tick();
  assert.deepEqual(h.probes, [workspace.id, 'same-machine', 'ssh1', 'ssh-port']);
  h.controller.warmModelCatalogs(); await h.controller.discover('ssh2'); await tick();
  assert.equal(h.probes.length, 4, 'kept until the app quits');
  assert.deepEqual(h.writes, []);
  assert.equal(h.controller.currentSnapshot, undefined);
});

test('a startup read, explicit reads, splits and discovery share one probe while chat input remains available', async t => {
  const h = await harness(t);
  const pending = deferred<void>();
  const other = { ...workspace, id: 'other-project', cwd: '/other' };
  await h.store.save(other);
  h.hooks.probe = async () => { await pending.promise; return catalog(); };
  try {
    h.controller.warmModelCatalogs();
    await Promise.all([h.watch(), h.sibling.watchSession(other.id, 'other'), h.controller.discover(workspace.id)]);
    const first = h.read('model'), next = h.sibling.getSessionSetting(other.id, 'other', 'effort');
    await tick();
    assert.deepEqual(h.probes, [workspace.id], 'the same machine and configuration');
    assert.equal(h.latest().settingBusy, false);
    await h.controller.sendMessage(workspace.id, 'chat', 'normal user input');
    pending.resolve();
    const [model, effort] = await Promise.all([first, next]);
    assert.equal(model.sessionId, 'chat');
    assert.equal(effort.sessionId, 'other');
    assert.ok(model.options.every(option => !option.current));
    assert.equal(settingMenuNeedsRefresh(model), false, 'a long-running app retains its machine catalog');
    await h.controller.createSession(workspace.id);
    await h.controller.resumeSession(other.id, 'other');
    await h.watch('third');
    assert.equal(h.latest().settings?.menus.model?.sessionId, 'third');
    assert.deepEqual(h.probes, [workspace.id]);
    assert.deepEqual(h.writes, ['message']);
  } finally { pending.resolve(); }
});

test('cached options project only the watched business snapshot or verified application', async t => {
  const h = await harness(t);
  const line = { sessionId: 'chat', modelId: 'business-code', modelName: 'Business model', effort: 'high' };
  h.states.set('chat', { ...idle('chat'), statusLineManaged: true, statusLine: line });
  await h.watch();
  const model = await h.read('model'), effort = await h.read('effort');
  assert.equal(model.currentOptionId, model.options[1].id);
  assert.deepEqual(effort.options.map(option => option.label), ['low', 'high'], 'the levels the session\'s model accepts');
  assert.equal(effort.currentOptionId, effort.options[1].id);
  const verified = await h.apply(model, 0);
  assert.equal(verified.options.find(option => option.current)?.label, 'Query model');
  assert.equal(h.latest().settings?.menus.model?.currentOptionId, model.options[0].id, 'option IDs stay with their rows');
  assert.equal(h.latest().settings?.menus.effort?.options.length, 2);
  await assert.rejects(h.apply(model, 0), /重新读取/);
  h.states.set('chat', { ...idle('chat'), statusLineManaged: true, statusLine: { ...line, modelId: 'new', modelName: 'Unknown model', effort: 'low' } });
  await h.poll();
  assert.equal(h.latest().settings?.menus.model?.currentOptionId, undefined);
  assert.equal(h.latest().settings?.menus.effort?.currentOptionId, effort.options[0].id);
  await h.watch('second');
  assert.ok((await h.read('model', 'second')).options.every(option => !option.current));
  await assert.rejects(h.apply(h.latest().settings!.menus.model!, 0, 'chat'), /选择/);
  await assert.rejects(h.apply(model, 0, 'second'), /重新读取/);
  assert.deepEqual(h.probes, [workspace.id]);
  assert.deepEqual(h.writes, ['set:chat']);
});

test('a failed probe shows its error, polls and discovery do not repeat it, and an explicit read retries once', async t => {
  const h = await harness(t);
  let attempts = 0;
  h.hooks.probe = async () => { if (++attempts === 1) throw new Error('Claude Code 没有回应模型列表请求'); return catalog(); };
  await h.watch(); await tick();
  assert.match(h.latest().settings?.error ?? '', /没有回应/);
  assert.equal(h.latest().settings?.initialization, 'failed');
  await h.poll(); await h.watch(); await h.controller.discover(workspace.id); await tick();
  assert.equal(h.probes.length, 1);
  const choices = await Promise.all([h.read('effort'), h.read('effort')]);
  assert.equal(choices[0].token, choices[1].token);
  assert.equal(h.probes.length, 2);
  assert.equal(h.latest().settings?.initialization, 'ready');
  assert.equal(h.latest().settings?.cliVersion, '9.9.9');
});

test('legacy panes, drafts, trust and an external binding cannot receive picker commands from reads', async t => {
  const h = await harness(t);
  for (const [name, value] of [
    ['legacy', idle('legacy')], ['draft', { ...idle('draft'), screen: composer.replace('❯ ', '❯ unsent'), viewport: composer.replace('❯ ', '❯ unsent') }],
    ['pending', { ...idle('pending'), session: { ...idle('pending').session, status: 'waiting' as const } }],
    ['external', { ...idle('external'), session: { ...idle('external').session, mapping: 'manual' as const } }],
  ] as const) {
    h.states.set(name, value);
    await h.watch(name);
    const snapshot = await h.read('model', name);
    assert.equal(snapshot.currentOptionId, undefined);
    if (name === 'draft') await assert.rejects(h.apply(snapshot, 0, name), /为空/);
  }
  assert.equal(h.probes.length, 1);
  assert.deepEqual(h.writes, []);
});

test('an old read, pane replacement, and mapping failure cannot transplant a pane-bound selection', async t => {
  const h = await harness(t);
  const pending = deferred<void>();
  h.hooks.probe = async () => { await pending.promise; return catalog(); };
  try {
    await h.watch('previous');
    const read = h.read('model', 'previous');
    await h.watch();
    pending.resolve();
    await assert.rejects(read, /变化/);
    const old = await h.read('model');
    h.states.set('chat', { ...idle('chat'), panePid: 999 });
    await h.poll();
    await assert.rejects(h.apply(old, 0), /重新读取/);
    assert.notEqual((await h.read('model')).token, old.token);
    h.hooks.read = async () => { throw new SessionMappingError('identity changed'); };
    await h.poll();
    assert.equal(h.latest().settings, undefined);
    await assert.rejects(h.read('effort'), /变化/);
    h.hooks.read = async () => idle('chat', '%2');
    await h.poll();
    assert.equal(h.latest().settings?.menus.model?.paneId, '%2');
    assert.equal(h.probes.length, 1);
    assert.deepEqual(h.writes, []);
  } finally { pending.resolve(); }
});

test('a failed mutation consumes the displayed handle without discarding machine choices or replaying input', async t => {
  const h = await harness(t);
  h.hooks.apply = async () => { throw new Error('uncertain receipt'); };
  await h.watch(); await tick();
  const model = await h.read('model');
  await assert.rejects(h.apply(model, 1), /uncertain/);
  await assert.rejects(h.apply(model, 1), /重新读取/);
  await h.poll(); await h.watch();
  assert.equal(h.latest().settings?.initialization, 'ready');
  assert.equal((await h.read('model')).currentOptionId, undefined);
  assert.equal(h.probes.length, 1);
  assert.deepEqual(h.writes, ['set:chat']);
});

test('manual terminal ownership and working or waiting status allow browsing while rejecting a write', async t => {
  const h = await harness(t);
  await h.watch(); await h.read('effort');
  const control = await h.controller.setTerminalControl(workspace.id, 'chat', true);
  assert.ok(control);
  await h.poll();
  const menu = await h.read('effort');
  assert.equal(h.latest().settings?.menus.effort?.token, menu.token);
  await assert.rejects(h.apply(menu, 1), /接管/);
  await h.controller.setTerminalControl(workspace.id, 'chat', false, control.token);
  const busy = idle('chat');
  for (const nativeStatus of ['waiting', 'busy'] as const) {
    h.states.set('chat', { ...busy, nativeStatus });
    await h.poll();
    const current = await h.read('model');
    assert.equal(current.options.length, 2);
    await assert.rejects(h.apply(current, 0));
  }
  assert.equal(h.probes.length, 1);
  assert.deepEqual(h.writes, []);
});

test('identical candidate lists keep each business pane’s choice and pending write isolated', async t => {
  const h = await harness(t);
  const pending = deferred<void>();
  h.hooks.apply = async (bound, id) => {
    await pending.promise;
    return { ...bound, currentOptionId: id, options: bound.options.map(option => ({ ...option, current: option.id === id })) };
  };
  try {
    await h.watch();
    const model = await h.read('model');
    const change = h.apply(model, 1);
    await h.sibling.watchSession(workspace.id, 'other');
    const other = await h.sibling.getSessionSetting(workspace.id, 'other', 'model');
    assert.notEqual(model.token, other.token);
    assert.equal(h.sibling.currentSnapshot?.settingBusy, false);
    await h.sibling.sendMessage(workspace.id, 'other', 'normal input');
    h.states.set('chat', { ...idle('chat'), runtimeInstanceId: 'replacement' });
    await h.poll();
    pending.resolve();
    await assert.rejects(change, /进程已变化/);
    assert.equal(h.latest().settings?.menus.model?.currentOptionId, undefined);
    assert.deepEqual(h.writes, ['set:chat', 'message']);
    assert.equal(h.probes.length, 1);
  } finally { pending.resolve(); }
});

for (const late of [false, true]) {
  test('a picker frame arriving ' + (late ? 'after' : 'before') + ' the business write closes triggers one fresh viewport check', { timeout: 5000 }, async t => {
    const h = await harness(t);
    const base = idle('chat');
    const waiting: ReadResult = { ...base, session: { ...base.session, status: 'waiting' }, nativeStatus: 'waiting' };
    const frame = deferred<ReadResult>(), ack = deferred<void>(), checked = deferred<boolean>();
    h.hooks.apply = async (bound, id) => {
      await ack.promise;
      return { ...bound, currentOptionId: id, options: bound.options.map(option => ({ ...option, current: option.id === id })) };
    };
    try {
      await h.watch();
      const model = await h.read('model');
      const applying = h.apply(model, 1);
      let reads = 0;
      h.controller.backend.readSession = async (_ws, _sid, fresh) => {
        if (++reads === 1) return frame.promise;
        checked.resolve(!!fresh);
        return late ? waiting : base;
      };
      const poll = h.poll();
      if (late) {
        ack.resolve(); await applying;
        frame.resolve(waiting); await poll;
      } else {
        frame.resolve(waiting); await poll;
        assert.equal(h.latest().navigationStatus, 'waiting');
        ack.resolve(); await applying;
      }
      assert.equal(await checked.promise, true);
      await tick();
      assert.equal(reads, 2);
      assert.equal(h.latest().navigationStatus, late ? 'waiting' : 'idle');
      assert.equal(h.latest().settings?.menus.model?.currentOptionId, model.options[1].id);
    } finally { frame.resolve(waiting); ack.resolve(); }
  });
}

test('a disconnected business pane still receives the query result and browses it without authorizing input', async t => {
  const h = await harness(t);
  const delayed = deferred<void>();
  h.hooks.probe = async () => { await delayed.promise; return catalog(); };
  try {
    await h.watch(); await tick();
    const reading = h.read('model');
    h.hooks.read = async () => { throw new Error('business pane unavailable'); };
    await h.poll();
    assert.equal(h.latest().status, 'offline');
    delayed.resolve();
    const model = await reading;
    await tick();
    assert.equal(h.latest().settings?.initialization, 'ready');
    assert.equal(h.latest().settings?.menus.model?.token, model.token);
    assert.equal((await h.read('model')).token, model.token);
    await assert.rejects(h.apply(model, 1), /已连接/);
    assert.deepEqual(h.writes, []);
    assert.equal(h.probes.length, 1);
  } finally { delayed.resolve(); }
});

test('a view attaching after warmup immediately receives a snapshot on an explicit cache hit', async t => {
  const h = await harness(t);
  await h.watch(); await tick();
  assert.equal(h.latest().settings?.initialization, 'ready');
  const received: string[] = [];
  h.controller.once('snapshot', snapshot => received.push(snapshot.settings.menus.model.token));
  const current = await h.read('model');
  assert.deepEqual(received, [current.token], 'an already-open dialog need not wait for the next business poll');
  assert.deepEqual(h.probes, [workspace.id]);
  assert.deepEqual(h.writes, []);
});

test('a new chat starts with chosen rows of the machine list only; nothing invalid reaches the launch', async t => {
  const h = await harness(t);
  await assert.rejects(h.controller.createSession(workspace.id, { model: 'business-model' }), /尚未读取完成/, 'no list yet');
  assert.deepEqual(await h.controller.modelCatalog(workspace.id), { status: 'ready', catalog: catalog() });
  await h.controller.createSession(workspace.id, { model: 'business-model', effort: 'high' });
  await h.controller.createSession(workspace.id, { model: 'default' });
  await h.controller.createSession(workspace.id, { effort: 'low' });
  await h.controller.createSession(workspace.id);
  assert.deepEqual(h.launches, [{ model: 'business-model', effort: 'high' }, {}, { effort: 'low' }, {}], '"default" starts without --model');
  for (const [options, error] of [
    [{ model: 'unknown-model' }, /不在这台机器的列表/], [{ model: 'business-model', effort: 'max' }, /不支持这个推理强度/],
    [{ model: '--dangerously-skip-permissions' }, /无效的模型/], [{ effort: 'ultracode' }, /无效的推理强度/],
    [{ validateMessage: '/doctor' }, /\/doctor/], [{ validateMessage: '/model' }, /模型/],
  ] as const) await assert.rejects(h.controller.createSession(workspace.id, options), error);
  assert.equal(h.launches.length, 4, 'a refused choice or first message starts nothing');
  assert.deepEqual(h.writes, [], 'nothing is switched or saved in the session afterwards');
});

test('the model-list state for a new chat reports loading, failure and an explicit retry', async t => {
  const h = await harness(t);
  const pending = deferred<void>();
  let fail = true;
  h.hooks.probe = async () => { await pending.promise; if (fail) throw new Error('ssh: connect to host lab port 22: Operation timed out'); return catalog(); };
  try {
    const first = h.controller.modelCatalog(workspace.id);
    pending.resolve();
    assert.deepEqual(await first, { status: 'failed', error: 'ssh: connect to host lab port 22: Operation timed out' });
    assert.deepEqual(await h.controller.modelCatalog(workspace.id), { status: 'failed', error: 'ssh: connect to host lab port 22: Operation timed out' }, 'not retried by itself');
    fail = false;
    assert.equal((await h.controller.modelCatalog(workspace.id, true)).status, 'ready');
    assert.equal(h.probes.length, 2);
  } finally { pending.resolve(); }
});

test('a launch-preference change during a probe reads the list again before anyone receives the old one', async t => {
  const h = await harness(t);
  const pending = deferred<void>();
  let workflows = true;
  h.hooks.probe = async () => {
    const seen = workflows;
    if (h.probes.length === 1) await pending.promise;
    return { ...catalog(), defaults: { ...catalog().defaults, ultracodeAvailable: seen } };
  };
  try {
    h.controller.warmModelCatalogs(); await tick();
    const waiting = h.controller.modelCatalog(workspace.id);
    workflows = false;
    h.controller.refreshModelCatalogs();
    pending.resolve();
    const state = await waiting;
    assert.equal(state.status, 'ready');
    assert.equal(state.status === 'ready' && state.catalog.defaults.ultracodeAvailable, false, 'the old preferences are never cached');
    assert.equal(h.probes.length, 2);
    assert.equal((await h.controller.modelCatalog(workspace.id)).status, 'ready');
    assert.equal(h.probes.length, 2, 'cached afterwards');
  } finally { pending.resolve(); }
});

test('a new chat asking while a retry of a failed list is in flight waits for its result', async t => {
  const h = await harness(t);
  const pending = deferred<void>();
  let attempts = 0;
  h.hooks.probe = async () => { if (++attempts === 1) throw new Error('Claude Code 没有回应模型列表请求'); await pending.promise; return catalog(); };
  try {
    assert.equal((await h.controller.modelCatalog(workspace.id)).status, 'failed');
    const retry = h.controller.modelCatalog(workspace.id, true);
    await tick();
    const draft = h.controller.modelCatalog(workspace.id);
    pending.resolve();
    assert.equal((await draft).status, 'ready', 'not left loading');
    assert.equal((await retry).status, 'ready');
    assert.equal(h.probes.length, 2);
  } finally { pending.resolve(); }
});

// Claude Code reports busy after its reply while background subagents run; its screen
// shows the empty prompt again, "Waiting for …" above it and the subagents below
// (tests/fixtures/task-rows-2.1.330/), and session-status.ts reads that as idle with
// background work.
test('with only background subagents keeping Claude Code busy, model and effort switch; never during a reply', async t => {
  const h = await harness(t);
  await h.watch();
  const box = composer.replace('? for shortcuts', '⏵⏵ auto mode on (shift+tab to cycle) · ← for agents · ↓ to manage');
  const listed = '\n\n  ● main\n  ◯ general-purpose  Helper 1' + ' '.repeat(60) + '12s\n';
  const busy = (screen: string, status: 'idle' | 'working', background?: string): ReadResult =>
    ({ ...idle('chat'), nativeStatus: 'busy', screen, viewport: screen, session: { ...idle('chat').session, status, background } });
  h.states.set('chat', busy('✻ Waiting for 1 background agent to finish\n\n' + box + listed, 'idle', '后台子代理运行中'));
  await h.poll();
  await h.apply(await h.read('model'), 1);
  await h.apply(await h.read('effort'), 1);
  assert.deepEqual(h.writes, ['set:chat', 'set:chat']);
  assert.deepEqual([h.latest().status, h.latest().settingsInputReady, h.latest().nativeInputReady], ['idle', true, false],
    'settings only: forking and rewinding still wait for the background work');
  // A reply in progress: the spinner right above the box, "esc to interrupt" in the footer.
  for (const screen of ['✻ Thinking… (3s · ↓ 12 tokens)\n' + box + listed,
    '✻ Thinking…\n' + box.replace('↓ to manage', 'esc to interrupt') + listed]) {
    for (const [status, background] of [['working', undefined], ['idle', '后台子代理运行中']] as const) {
      h.states.set('chat', busy(screen, status, background));
      await h.poll();
      assert.equal(h.latest().settingsInputReady, false, `${status} ${screen.split('\n')[0]}`);
      await assert.rejects(h.apply(await h.read('model'), 0));
    }
  }
  assert.equal(h.writes.length, 2);
});
