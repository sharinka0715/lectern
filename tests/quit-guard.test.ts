import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { knownUnreachable, QuitFlow, quitPromptEnabled, summarizeRunning, withDeadline, type FolderCheck, type KnownFolder, type QuitFlowOptions, type QuitList, type SnapshotView } from '../src/main/quit-guard';
import { QuitSettings } from '../src/main/quit-settings';
import { endpointKey, quitActivityText, quitGroups, quitTitle, type QuitPrompt, type QuitSession } from '../src/shared/quit';
import { setLocale } from '../src/shared/i18n';
import type { Workspace } from '../src/shared/types';

const local: Workspace = { id: 'w-local', name: 'app', kind: 'local', cwd: '/home/dev/app' };
const nested: Workspace = { id: 'w-nested', name: 'app-web', kind: 'local', cwd: '/home/dev/app/web' };
const box: Workspace = { id: 'w-box', name: 'trainer', kind: 'ssh', host: 'box.example.com', cwd: '~/trainer' };
const gpu: Workspace = { id: 'w-gpu', name: 'eval', kind: 'ssh', host: 'gpu.example.com', port: 2222, cwd: '~/eval' };
const snapshot = (fields: Partial<SnapshotView> & Pick<SnapshotView, 'workspaceId' | 'sessionId'>): SnapshotView => ({ status: 'idle', messages: [], ...fields });

test('a checked folder lists exactly what its probe found, with titles and activity from what Lectern knows', () => {
  const list = summarizeRunning({
    workspaces: [local],
    known: new Map([[local.id, { sessions: [{ id: 'stale', title: 'Closed meanwhile', paneId: '%9' }], okAt: 1 }]]),
    checks: new Map<string, FolderCheck>([[local.id, { sessions: [
      { id: 's-named', title: 'Fix the login page', titleSource: 'custom', paneId: '%1', panePid: 101, status: 'idle' },
      { id: 's-new-123456789', title: '新对话', paneId: '%2', panePid: 102, status: 'working' },
      { id: 's-bare-abcdefgh', title: 'New conversation', paneId: '%3', panePid: 103, status: 'idle', background: 'A background shell is still running' },
    ] }]]),
    snapshots: [
      snapshot({ workspaceId: local.id, sessionId: 's-named', paneId: '%1', panePid: 101, status: 'idle', turnControls: { running: true } as SnapshotView['turnControls'],
        backgroundWork: { shells: 2, agents: 0, monitors: 1, workflows: 0 } }),
      snapshot({ workspaceId: local.id, sessionId: 's-new-123456789', paneId: '%2', messages: [{ id: 'u', role: 'user', text: '  summarize\nthe logs  ', tools: [], source: 'jsonl', status: 'complete' }] }),
      // An open reader of a conversation the probe no longer sees adds nothing.
      snapshot({ workspaceId: local.id, sessionId: 'stale', paneId: '%9' }),
    ],
  });
  assert.deepEqual(list.unchecked, []);
  assert.deepEqual(list.sessions.map(session => [session.sessionId, session.paneId, session.panePid]), [['s-named', '%1', 101], ['s-new-123456789', '%2', 102], ['s-bare-abcdefgh', '%3', 103]]);
  const [named, fresh, bare] = list.sessions;
  assert.equal(named.title, 'Fix the login page');
  assert.equal(named.activity, 'working', 'a reply the open reader sees running');
  assert.deepEqual(named.background, { shells: 2, agents: 0, monitors: 1, workflows: 0 });
  assert.equal(fresh.title, '', 'the placeholder title is no title');
  assert.equal(fresh.prompt, 'summarize the logs');
  assert.equal(quitTitle(fresh), 'summarize the logs');
  assert.equal(fresh.activity, 'working');
  assert.equal(quitTitle(bare), '对话 s-bare-a');
  assert.equal(bare.backgroundUnknown, true);
  assert.equal(quitActivityText(named), '正在回复 · 后台：2 个终端、1 个监控');
  assert.equal(quitActivityText(bare), '回复完成 · 后台：有任务在运行');
  assert.ok(list.sessions.every(session => !session.unconfirmed));
});

test('a folder that could not be checked lists what Lectern saw before, unconfirmed, and its machine', () => {
  const known = new Map<string, KnownFolder>([
    [box.id, { sessions: [{ id: 's-box', title: 'Train', titleSource: 'prompt', paneId: '%4', status: 'working' }], okAt: 100 }],
    [gpu.id, { sessions: [{ id: 's-gpu', title: 'Eval', titleSource: 'ai', paneId: '%1' }], okAt: 100, failedAt: 200, error: 'ssh: connect to host gpu.example.com port 2222: Connection refused' }],
  ]);
  const list = summarizeRunning({
    workspaces: [box, gpu], known,
    checks: new Map([[box.id, { error: '3 秒内没有回应' }]]),
    snapshots: [snapshot({ workspaceId: box.id, sessionId: 's-started', paneId: '%5', panePid: 55 })],
  });
  assert.deepEqual(list.sessions.map(session => [session.sessionId, session.unconfirmed]), [['s-box', true], ['s-started', true], ['s-gpu', true]]);
  assert.deepEqual(list.unchecked.map(folder => [folder.workspaceId, folder.error]), [[box.id, '3 秒内没有回应'], [gpu.id, known.get(gpu.id)!.error]]);
  assert.equal(list.sessions[0].activity, 'working');
  assert.equal(knownUnreachable(known.get(gpu.id)), true);
  assert.equal(knownUnreachable({ sessions: [], okAt: 300, failedAt: 200 }), false, 'a later success clears it');
  assert.equal(knownUnreachable(undefined), false);
});

test('one pane is listed once even when two folders see it; the same pane id on another machine is another pane', () => {
  const row = { id: 's-1', title: 'Shared', titleSource: 'custom' as const, paneId: '%1' };
  const list = summarizeRunning({
    workspaces: [local, nested, box],
    known: new Map(),
    checks: new Map<string, FolderCheck>([[local.id, { sessions: [row] }], [nested.id, { sessions: [row] }], [box.id, { sessions: [{ ...row, id: 's-2' }] }]]),
    snapshots: [],
  });
  assert.deepEqual(list.sessions.map(session => [session.workspaceId, session.paneId]), [[local.id, '%1'], [box.id, '%1']]);
});

test('folders not asked again (fresh knowledge) count as confirmed', () => {
  const list = summarizeRunning({ workspaces: [local], known: new Map([[local.id, { sessions: [{ id: 's', title: 'T', titleSource: 'custom', paneId: '%1' }], okAt: 5 }]]), checks: new Map(), snapshots: [] });
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0].unconfirmed, undefined);
  assert.deepEqual(list.unchecked, []);
});

const session = (id: string, workspace: Workspace, fields: Partial<QuitSession> = {}): QuitSession => ({
  workspaceId: workspace.id, sessionId: id, title: id, folder: workspace.name, endpoint: { kind: workspace.kind, host: workspace.host, port: workspace.port },
  paneId: `%${id}`, activity: 'idle', ...fields,
});

test('groups: this computer first, then machines by name; after a failed close the running ones lead', () => {
  const prompt: Pick<QuitPrompt, 'sessions' | 'unchecked'> = {
    sessions: [session('b', gpu), session('z', local, { folder: 'zz' }), session('a', local), session('c', box, { close: 'closed' }), session('d', box, { close: 'failed' })],
    unchecked: [{ workspaceId: 'w-x', folder: 'x', endpoint: { kind: 'ssh', host: 'away.example.com' }, error: 'timeout' }],
  };
  const groups = quitGroups(prompt);
  assert.deepEqual(groups.map(group => group.name), ['本地', 'away.example.com', 'box.example.com', 'gpu.example.com:2222']);
  assert.deepEqual(groups[0].sessions.map(item => item.sessionId), ['a', 'z']);
  assert.deepEqual(groups[2].sessions.map(item => item.sessionId), ['d', 'c']);
  assert.deepEqual(groups[1].sessions, []);
  assert.equal(groups[1].unchecked.length, 1);
  assert.equal(endpointKey({ kind: 'ssh', host: 'gpu.example.com', port: 2222 }), JSON.stringify(['ssh', 'gpu.example.com', 2222]));
  const named = quitGroups(prompt, endpoint => endpoint.host === 'gpu.example.com' ? 'A100' : endpoint.kind === 'local' ? 'Mac' : endpoint.host!);
  assert.deepEqual(named.map(group => group.name), ['Mac', 'A100', 'away.example.com', 'box.example.com'], 'saved connection names sort too');
});

test('texts follow the language', () => {
  try {
    setLocale('en');
    assert.equal(quitActivityText({ activity: 'waiting', background: { shells: 1, agents: 2, monitors: 0, workflows: 0 } }), 'Waiting for you · In the background: 1 background shell, 2 subagents');
    assert.equal(quitTitle({ title: '', sessionId: '0123456789abcdef' }), 'Conversation 01234567');
  } finally { setLocale('zh-CN'); }
});

test('automated runs quit without asking unless the test asks for the dialog', () => {
  assert.equal(quitPromptEnabled({}, false), true);
  assert.equal(quitPromptEnabled({}, true), false);
  assert.equal(quitPromptEnabled({ LECTERN_QUIT_PROMPT: '1' }, true), true);
  assert.equal(quitPromptEnabled({ LECTERN_QUIT_PROMPT: '0' }, false), false);
});

test('withDeadline rejects late work with the given message', async () => {
  assert.equal(await withDeadline(Promise.resolve(3), 50, () => 'late'), 3);
  await assert.rejects(withDeadline(new Promise(() => {}), 10, () => 'no answer within 3 s'), /no answer within 3 s/);
});

/** A flow with recorded calls; `closes` decides each close by session id. */
function harness(list: QuitList, { preference = 'ask', closes = {}, ...overrides }: Partial<Omit<QuitFlowOptions, 'preference'>> & { preference?: 'ask' | 'leave'; closes?: Record<string, () => Promise<void>> } = {}) {
  const calls = { collect: 0, quit: 0, focus: 0, remember: 0, presented: [] as (QuitPrompt | undefined)[], closed: [] as string[], events: [] as [string, unknown][] };
  let active = 0, peak = new Map<string, number>(), running = new Map<string, number>();
  const flow = new QuitFlow({
    collect: async () => { calls.collect++; return list; },
    promptEnabled: () => true,
    preference: async () => preference,
    remember: async () => { calls.remember++; },
    present: prompt => { calls.presented.push(prompt && structuredClone(prompt)); },
    close: async item => {
      const machine = endpointKey(item.endpoint);
      running.set(machine, (running.get(machine) ?? 0) + 1); active++;
      peak.set(machine, Math.max(peak.get(machine) ?? 0, running.get(machine)!));
      try { await (closes[item.sessionId]?.() ?? new Promise(resolve => setTimeout(resolve, 5))); calls.closed.push(item.sessionId); }
      finally { running.set(machine, running.get(machine)! - 1); active--; }
    },
    quit: () => { calls.quit++; },
    focus: () => { calls.focus++; },
    event: (name, data) => { calls.events.push([name, data]); },
    ...overrides,
  });
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const until = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check()); };
  return { flow, calls, settle, until, peak: () => peak, active: () => active };
}

const running: QuitList = { sessions: [session('a', local), session('b', box), session('c', box), session('d', box), session('e', gpu)], unchecked: [] };

test('nothing running: quit at once, no dialog; remembered "leave": the same', async () => {
  const none = harness({ sessions: [], unchecked: [] });
  none.flow.request('user');
  await none.until(() => none.calls.quit === 1);
  assert.deepEqual(none.calls.presented, []);
  const remembered = harness(running, { preference: 'leave' });
  remembered.flow.request('window');
  await remembered.until(() => remembered.calls.quit === 1);
  assert.deepEqual(remembered.calls.presented, []);
  assert.ok(remembered.calls.events.some(([name, data]) => name === 'app.quit_proceed' && (data as { why: string }).why === 'remembered'));
});

test('cancel keeps the app; a repeated quit only brings the dialog forward; stale answers do nothing', async () => {
  const { flow, calls, until } = harness(running);
  flow.request('user');
  await until(() => !!flow.current);
  assert.equal(flow.current!.phase, 'confirm');
  assert.equal(flow.current!.sessions.length, 5);
  flow.request('user'); flow.request('window');
  assert.equal(calls.collect, 1, 'no second check while the dialog is up');
  assert.equal(calls.focus, 2);
  flow.answer(flow.current!.id + 1, 'leave');
  assert.equal(calls.quit, 0, 'an answer to another dialog is ignored');
  flow.answer(flow.current!.id, 'cancel');
  assert.equal(flow.current, undefined);
  assert.equal(calls.presented.at(-1), undefined, 'the dialog is hidden');
  assert.equal(calls.quit, 0);
  flow.request('user');
  await until(() => !!flow.current);
  assert.equal(calls.collect, 2, 'the next quit checks again');
});

test('"leave" quits; remembering saves the choice first', async () => {
  const plain = harness(running);
  plain.flow.request('user');
  await plain.until(() => !!plain.flow.current);
  plain.flow.answer(plain.flow.current!.id, 'leave');
  assert.equal(plain.calls.quit, 1);
  assert.equal(plain.calls.remember, 0);
  const remember = harness(running);
  remember.flow.request('user');
  await remember.until(() => !!remember.flow.current);
  remember.flow.answer(remember.flow.current!.id, 'leave', true);
  await remember.until(() => remember.calls.quit === 1);
  assert.equal(remember.calls.remember, 1);
});

test('closing all: never remembered, machines in parallel, two at a time per machine, progress, then quit', async () => {
  const { flow, calls, until, peak } = harness(running);
  flow.request('user');
  await until(() => !!flow.current);
  const confirmId = flow.current!.id;
  flow.answer(confirmId, 'close', true);
  assert.equal(flow.current!.phase, 'closing');
  flow.request('user');
  assert.equal(calls.focus, 1, 'quitting again while closing only brings the dialog forward');
  await until(() => calls.quit === 1);
  assert.equal(calls.remember, 0, '"remember" applies to leaving only');
  assert.deepEqual([...calls.closed].sort(), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(peak().get(endpointKey(box)), 2);
  const progress = calls.presented.filter((prompt): prompt is QuitPrompt => prompt?.phase === 'closing');
  assert.ok(progress.length > 5 && progress.every(prompt => prompt.id === progress[0].id && prompt.id > confirmId), 'progress keeps one dialog');
  assert.ok(progress.some(prompt => prompt.sessions.some(item => item.close === 'closing')));
  assert.deepEqual(progress.at(-1)!.sessions.map(item => item.close), ['closed', 'closed', 'closed', 'closed', 'closed']);
});

test('failed closes are listed; Cancel keeps Lectern, "Quit Anyway" quits; a hung close times out', async () => {
  const fail = () => Promise.reject(new Error('Rehearsed failure: tmux.close_session'));
  const { flow, calls, until } = harness(running, { closeTimeoutMs: 40, closes: { d: fail, e: () => new Promise(() => {}) } });
  flow.request('user');
  await until(() => !!flow.current);
  flow.answer(flow.current!.id, 'close');
  await until(() => flow.current?.phase === 'failed');
  assert.equal(calls.quit, 0);
  const failed = flow.current!.sessions.filter(item => item.close === 'failed');
  assert.deepEqual(failed.map(item => [item.sessionId, item.error]), [['d', 'Rehearsed failure: tmux.close_session'], ['e', '0 秒内没有关闭完成']]);
  assert.deepEqual(quitGroups(flow.current!).flatMap(group => group.sessions.map(item => item.sessionId)), ['a', 'd', 'b', 'c', 'e'], 'still running first on each machine');
  flow.answer(flow.current!.id, 'cancel');
  assert.equal(flow.current, undefined);
  assert.equal(calls.quit, 0, 'Cancel after failures keeps Lectern');
  flow.request('user');
  await until(() => flow.current?.phase === 'confirm');
  flow.answer(flow.current!.id, 'close');
  await until(() => flow.current?.phase === 'failed');
  flow.answer(flow.current!.id, 'quit-anyway');
  assert.equal(calls.quit, 1);
});

test('shutdown and signals quit at once, also over an open dialog; the installer and automated runs never ask', async () => {
  const system = harness(running);
  system.flow.request('system');
  assert.equal(system.calls.quit, 1);
  assert.equal(system.calls.collect, 0);
  const open = harness(running);
  open.flow.request('user');
  await open.until(() => !!open.flow.current);
  open.flow.request('signal');
  assert.equal(open.calls.quit, 1);
  open.flow.answer(open.flow.current!.id, 'close');
  open.flow.request('user');
  assert.equal(open.calls.quit, 1, 'nothing after quitting');
  const installer = harness(running);
  installer.flow.request('installer');
  assert.equal(installer.calls.quit, 1);
  assert.equal(installer.calls.collect, 0);
  const automated = harness(running, { promptEnabled: () => false });
  automated.flow.request('user');
  assert.equal(automated.calls.quit, 1);
  assert.equal(automated.calls.collect, 0);
  const broken = harness(running, { collect: () => Promise.reject(new Error('store gone')) });
  broken.flow.request('user');
  await broken.until(() => broken.calls.quit === 1);
});

test('the preference file: "ask" by default, "leave" saved atomically, invalid values refused', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lectern-quit-settings-'));
  try {
    const file = path.join(dir, 'quit-settings.json');
    assert.deepEqual(await new QuitSettings(file).get(), { whenRunning: 'ask' });
    const settings = new QuitSettings(file);
    assert.deepEqual(await settings.set({ whenRunning: 'leave' }), { whenRunning: 'leave' });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { whenRunning: 'leave' });
    assert.deepEqual(await new QuitSettings(file).get(), { whenRunning: 'leave' });
    await assert.rejects(settings.set({ whenRunning: 'close' }), /Invalid quit preference/);
    await writeFile(file, '{broken');
    assert.deepEqual(await new QuitSettings(file).get(), { whenRunning: 'ask' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
