import { fixtureClaudeConfig } from './helpers/claude-config';
import { isolateTmux } from './helpers/private-tmux';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkpointPosition, performTurnAction, RewindRecordChanged, type RewindTarget, type TurnDriver } from '../src/backend/native-turn-controls';
import { TranscriptChangedNoKeys } from '../src/backend/native-settings';
import { MessageDisplay } from '../src/core/message-display';
import { readRewind, turnComposer } from '../src/core/turn-controls';
import { isIdleEmptyComposer } from '../src/core/settings-screen';
import { t } from '../src/shared/i18n';
import { Controller } from '../src/main/controller';
import { WorkspaceStore } from '../src/main/store';
import { Backend, type ReadResult } from '../src/backend';
import { nativeBranchFixture } from './helpers/native-branch-fixture';
import type { SessionSnapshot, TranscriptPosition } from '../src/shared/types';

// Claude Code 2.1.330 and 2.1.300 in a 120×40 pane (cc-matrix sandbox, loopback fake API).
// Two prompts and Lectern's one-step switches: /model sonnet and /effort low after the first,
// /effort high and /model haiku after the second, the last thing in the conversation. Each
// switch wrote a local-command caveat (isMeta), the <command-name> user record and its stdout,
// and Claude Code lists the command records among the rewind points. transcript.jsonl: the
// session's records (request blobs, tool lists and machine fields dropped). Frames: idle,
// rewind-typed, menu-0 (focus on "(current)") … menu-5 (Up five times: on /model sonnet),
// confirm-model and menu-5-back (Esc from it), confirm-prompt (on the second prompt) and
// menu-3-back, closed (Esc from the list), restored-model ("Restore conversation" on
// /model sonnet: the command is back in the input box). 2.1.300 shows two rows at a time.
const versions = ['2.1.330', '2.1.300'] as const;
const fixture = (version: string, name: string) => readFileSync(new URL(`./fixtures/rewind-model-switch-${version}/${name}`, import.meta.url), 'utf8');
const frames = (version: string) => {
  const frame = (name: string) => fixture(version, name + '.ansi');
  return Object.fromEntries(['idle', 'rewind-typed', 'menu-0', 'menu-1', 'menu-2', 'menu-3', 'menu-4', 'menu-5', 'confirm-model', 'menu-5-back',
    'confirm-prompt', 'menu-3-back', 'closed', 'restored-model'].map(name => [name, frame(name)])) as Record<string, string>;
};
const FIRST = 'Summarize the build script ccm:one', SECOND = 'Now list the tests ccm:two';
const NATIVE = [FIRST, '/model sonnet', '/effort low', SECOND, '/effort high', '/model haiku'];

function display(jsonl: string) {
  const sessionId = JSON.parse(jsonl.split('\n')[0]).sessionId;
  const view = new MessageDisplay(sessionId);
  view.ingestJsonl(jsonl, true, false);
  return view;
}

test('Lectern reads the rewind list Claude Code shows: prompts and the one-step /model and /effort switches', () => {
  for (const version of versions) {
    const view = display(fixture(version, 'transcript.jsonl')), screens = frames(version);
    const points = view.rewindPoints()!;
    assert.deepEqual(points.map(point => point.text), NATIVE, version);
    // The chat still shows only the prompts, each once, with the uuid of its own native row.
    const prompts = view.getMessages().filter(message => message.rewindUuid);
    assert.deepEqual(prompts.map(message => message.text), [FIRST, SECOND]);
    assert.deepEqual(prompts.map(message => message.rewindUuid), [points[0].uuid, points[3].uuid]);
    const target: RewindTarget = { index: 3, prompts: points.map(point => point.text) };
    // Every frame of the real list lines up row by row: Up from "(current)" reaches /model sonnet.
    for (let up = 0; up <= 5; up++) {
      const menu = readRewind(screens[`menu-${up}`])!;
      assert.equal(menu.stage, 'checkpoint');
      assert.equal(checkpointPosition(menu, target), NATIVE.length - up, `${version} menu-${up}`);
    }
    if (version === '2.1.330') assert.deepEqual(readRewind(screens['menu-0'])!.rows.map(row => row.label), [...NATIVE, '(current)']);
    else assert.deepEqual([readRewind(screens['menu-0'])!.before, readRewind(screens['menu-5'])!.after], [5, 5], '2.1.300 scrolls the list');
    // The list of prompts alone (Lectern before) never lines up with it.
    for (const up of [0, 3, 5]) assert.throws(() => checkpointPosition(readRewind(screens[`menu-${up}`])!, { index: 1, prompts: [FIRST, SECOND] }), /对齐/);
  }
});

// Records shaped like Claude Code's (2.1.300–2.1.330): a prompt and its answer, and the three
// records of a local command run without a reply (caveat, command, stdout).
const SESSION = '00000000-0000-4000-8000-0000000000aa';
function transcript() {
  const records: object[] = [];
  let parent: string | null = null, n = 0;
  const add = (record: object) => { const uuid = `r${++n}`; records.push({ parentUuid: parent, isSidechain: false, sessionId: SESSION, uuid, timestamp: '2026-11-23T08:00:00.000Z', ...record }); parent = uuid; return uuid; };
  const user = (content: unknown, extra: object = {}) => add({ type: 'user', message: { role: 'user', content }, ...extra });
  return {
    records,
    prompt(text: string) {
      const uuid = user(text, { origin: { kind: 'human' }, promptSource: 'typed' });
      add({ type: 'assistant', message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Answer.' }], stop_reason: 'end_turn' } });
      add({ type: 'system', subtype: 'turn_duration', durationMs: 10 });
      return uuid;
    },
    local(name: string, args: string, stdout: string) {
      user('<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user.</local-command-caveat>', { isMeta: true });
      const uuid = user(`<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args>${args}</command-args>`);
      user(`<local-command-stdout>${stdout}</local-command-stdout>`);
      return uuid;
    },
    /** /rename, /context and a /model picker closed with Esc: system records, not listed natively. */
    system(name: string, stdout: string) {
      add({ type: 'system', subtype: 'local_command', level: 'info', content: `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args></command-args>` });
      add({ type: 'system', subtype: 'local_command', level: 'info', content: `<local-command-stdout>${stdout}</local-command-stdout>` });
    },
    skill(name: string) {
      const uuid = user(`<command-message>${name}</command-message>\n<command-name>/${name}</command-name>`);
      add({ type: 'user', isMeta: true, message: { role: 'user', content: 'Base directory for this skill: /home/dev/skills/' + name } });
      add({ type: 'assistant', message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Hello.' }], stop_reason: 'end_turn' } });
      return uuid;
    },
    compact() {
      const boundary = `r${++n}`;
      records.push({ parentUuid: null, logicalParentUuid: parent, isSidechain: false, sessionId: SESSION, uuid: boundary, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preservedMessages: { uuids: [], allUuids: [] } } });
      parent = boundary;
      user('This session is being continued from a previous conversation that ran out of context.', { isCompactSummary: true, isVisibleInTranscriptOnly: true });
      return this.local('compact', '', 'Compacted (ctrl+o to see full summary)');
    },
    jsonl() { return records.map(record => JSON.stringify(record) + '\n').join(''); },
  };
}
const points = (jsonl: string) => {
  const view = new MessageDisplay(SESSION);
  view.ingestJsonl(jsonl, true, false);
  return view.rewindPoints()?.map(point => point.text);
};

test('the rewind list with no switch, several, a switch first or last, and other local commands', () => {
  const plain = transcript();
  plain.prompt('one'); plain.prompt('two');
  assert.deepEqual(points(plain.jsonl()), ['one', 'two'], 'no switch: the prompts alone, as before');

  const many = transcript();
  many.local('model', 'sonnet', 'Set model to Sonnet 5.5 and saved as your default for new sessions');
  many.prompt('one');
  many.local('effort', 'low', 'Set effort level to low (saved as your default for new sessions)');
  many.local('model', 'opus', 'Set model to Opus 5.5 and saved as your default for new sessions');
  many.system('rename', 'Session renamed to: Example');
  many.system('model', 'Kept model as Opus 5.5 (default)');
  // The effort slider closed with Esc writes user records ("Cancelled"): listed as "/effort", as often as it happened.
  many.local('effort', '', 'Cancelled');
  many.local('effort', '', 'Cancelled');
  many.prompt('two');
  many.skill('review-reminder');
  many.local('model', 'haiku', 'Set model to Haiku 5.5 and saved as your default for new sessions');
  const list = points(many.jsonl())!;
  assert.deepEqual(list, ['/model sonnet', 'one', '/effort low', '/model opus', '/effort', '/effort', 'two', '/review-reminder', '/model haiku']);
  // Identical rows are told apart by their place in the whole list, as identical prompts are.
  const row = (label: string, focused = false) => (focused ? '  ❯ ' : '    ') + label + '\n    No code changes\n';
  const menu = readRewind(['─'.repeat(40), '  Rewind', '', '  Restore the code and/or conversation to the point before…', '', '    ↑ 3 more',
    row('/model opus'), row('/effort'), row('/effort', true), row('two'), '    ↓ 3 more', '', '  Enter to continue · Esc to cancel', ''].join('\n'))!;
  assert.equal(checkpointPosition(menu, { index: 6, prompts: list }), 5);
  assert.throws(() => checkpointPosition(menu, { index: 6, prompts: list.filter((_, i) => i !== 4) }), /对齐/, 'one /effort fewer');

  const compacted = transcript();
  compacted.prompt('before'); compacted.local('model', 'sonnet', 'Set model to Sonnet 5.5');
  compacted.compact();
  compacted.prompt('after');
  // A resumed process lists the rows after the boundary only: /compact's echo and what followed.
  assert.deepEqual(points(compacted.jsonl()), ['/compact', 'after']);
});

// The recorded screens in order, keyed by what Lectern sends. Like the target's guard, a key
// is refused when the screen is no longer the frame it was chosen from.
type Step = Parameters<TurnDriver['keyForTurn']>[0] | 'paste /rewind';
const moves: Record<string, Record<string, string>> = {
  'paste /rewind': { idle: 'rewind-typed' },
  submit: { 'rewind-typed': 'menu-0' },
  up: { 'menu-0': 'menu-1', 'menu-1': 'menu-2', 'menu-2': 'menu-3', 'menu-3': 'menu-4', 'menu-4': 'menu-5' },
  accept: { 'menu-3': 'confirm-prompt', 'menu-3-back': 'confirm-prompt', 'menu-5': 'confirm-model', 'menu-5-back': 'confirm-model', 'confirm-model': 'restored-model' },
  cancel: { 'confirm-model': 'menu-5-back', 'confirm-prompt': 'menu-3-back' },
  close: { 'confirm-model': 'menu-5-back', 'confirm-prompt': 'menu-3-back', ...Object.fromEntries(['menu-0', 'menu-1', 'menu-2', 'menu-3', 'menu-4', 'menu-5', 'menu-3-back', 'menu-5-back'].map(name => [name, 'closed'])) },
  erase: { 'rewind-typed': 'idle' },
};
function pane(version: string, change: Partial<Record<Step, (screen: string) => string | Error | undefined>> = {}, afterInput = false) {
  const screens = frames(version);
  let screen = 'idle', observed: string | undefined;
  const sent: Step[] = [];
  let reads = 0;
  // Claude Code reports "waiting" while its menu is open.
  const frame = () => { observed = screen; return { viewport: screens[screen], paneId: '%1', panePid: 7, nativeStatus: /^(?:menu|confirm)/.test(screen) ? 'waiting' : 'idle' }; };
  const dispatch = async (step: Step) => {
    const changed = change[step]?.(screen);
    if (changed instanceof Error) throw changed;
    if (screen !== observed) throw new Error(t('native.screenChangedNoKeys'));
    sent.push(step);
    screen = changed ?? moves[step]?.[screen] ?? assert.fail(`no recorded screen after ${step} on ${screen}`);
  };
  const driver: TurnDriver = {
    frame: async () => { reads++; return frame(); },
    pasteForTurn: async (text, _footer, observeAfter) => {
      await dispatch(`paste ${text}` as Step);
      if (afterInput && observeAfter) return frame();
    },
    keyForTurn: async (key, _footer, observeAfter) => {
      await dispatch(key);
      if (afterInput && observeAfter) return frame();
    },
  };
  return { driver, sent, screen: () => screen, reads: () => reads };
}
const target = (index: number): RewindTarget => ({ index, prompts: NATIVE });

test('the guarded post-key frame replaces a round trip only after validating the new ordinal', async () => {
  const action = { kind: 'rewindTo', uuid: 'second' } as const;
  const direct = pane('2.1.330', {}, true);
  await performTurnAction(direct.driver, '%1', 7, action, target(3));
  assert.equal(direct.reads(), 1, 'only the initial frame needs a separate read');
  assert.deepEqual(direct.sent, ['paste /rewind', 'submit', 'up', 'up', 'up', 'accept']);

  const skipped = pane('2.1.330', { up: () => 'menu-2' }, true);
  await assert.rejects(performTurnAction(skipped.driver, '%1', 7, action, target(3)),
    { message: t('native.rewindMenuClosed', { detail: t('native.rewindMismatch') }) });
  assert.deepEqual(skipped.sent, ['paste /rewind', 'submit', 'up', 'close']);
});

test('rewind reaches the prompt below the switches, and restoring a switch puts the command back (2.1.330, 2.1.300)', async () => {
  for (const version of versions) {
    const toPrompt = pane(version);
    await performTurnAction(toPrompt.driver, '%1', 7, { kind: 'rewindTo', uuid: 'second' }, target(3));
    assert.deepEqual(toPrompt.sent, ['paste /rewind', 'submit', 'up', 'up', 'up', 'accept'], version);
    assert.equal(readRewind(frames(version)[toPrompt.screen()])?.message, SECOND);
    // From Claude Code's own list (Lectern's rewind panel) a switch is a rewind point like any other.
    const toSwitch = pane(version);
    await performTurnAction(toSwitch.driver, '%1', 7, { kind: 'rewindTo', uuid: 'model' }, target(1));
    const confirm = readRewind(frames(version)[toSwitch.screen()])!;
    assert.equal(confirm.message, '/model sonnet');
    const restored = await performTurnAction(toSwitch.driver, '%1', 7, { kind: 'restore', signature: confirm.signature }, target(1));
    assert.deepEqual(toSwitch.sent.slice(-3), ['cancel', 'accept', 'accept']);
    assert.equal(restored?.restoredDraft, '/model sonnet');
    assert.equal(turnComposer(frames(version)['restored-model'])?.text, '/model sonnet');
  }
});

test('a rewind that fails once its menu is open closes the menu Lectern opened', async () => {
  for (const version of versions) {
    // Lectern's list without the switches (before this fix): the rows never line up.
    const stale = pane(version);
    await assert.rejects(performTurnAction(stale.driver, '%1', 7, { kind: 'rewindTo', uuid: 'second' }, { index: 1, prompts: [FIRST, SECOND] }),
      { message: t('native.rewindMenuClosed', { detail: t('native.rewindMismatch') }) });
    assert.deepEqual(stale.sent, ['paste /rewind', 'submit', 'close']);
    assert.equal(stale.screen(), 'closed');
    assert.ok(isIdleEmptyComposer(frames(version).closed), 'the input box is empty and idle again');
    // The confirmation quotes another message: Esc back to the list, Esc out of it.
    const moved = pane(version, { accept: screen => screen === 'menu-3' ? 'confirm-model' : undefined });
    await assert.rejects(performTurnAction(moved.driver, '%1', 7, { kind: 'rewindTo', uuid: 'second' }, target(3)),
      { message: t('native.rewindMenuClosed', { detail: t('native.rewindMismatch') }) });
    assert.deepEqual(moved.sent.slice(-3), ['accept', 'close', 'close']);
    assert.equal(moved.screen(), 'closed');
    // Esc cannot be sent: the error says the menu is still open.
    const stuck = pane(version, { close: () => new Error('connection lost') });
    await assert.rejects(performTurnAction(stuck.driver, '%1', 7, { kind: 'rewindTo', uuid: 'second' }, { index: 1, prompts: [FIRST, SECOND] }),
      { message: t('native.rewindMenuLeftOpen', { detail: t('native.rewindMismatch') }) });
    assert.equal(stuck.screen(), 'menu-0');
  }
});

test('a transcript change after the rewind was chosen leaves the terminal as it was, and says so', async () => {
  const recordChanged = () => new TranscriptChangedNoKeys();
  for (const version of versions) {
    // Refused before /rewind is typed: nothing at all was sent.
    const early = pane(version, { 'paste /rewind': recordChanged });
    await assert.rejects(performTurnAction(early.driver, '%1', 7, { kind: 'rewindTo', uuid: 'second' }, target(3)), RewindRecordChanged);
    assert.deepEqual(early.sent, []);
    // At its Enter: /rewind is taken out again.
    const typed = pane(version, { submit: recordChanged });
    await assert.rejects(performTurnAction(typed.driver, '%1', 7, { kind: 'rewindTo', uuid: 'second' }, target(3)), RewindRecordChanged);
    assert.deepEqual(typed.sent, ['paste /rewind', 'erase']);
    assert.equal(typed.screen(), 'idle');
    // In the list: Esc (not bound to the transcript) closes it.
    let ups = 0;
    const listed = pane(version, { up: () => ++ups === 2 ? recordChanged() : undefined });
    await assert.rejects(performTurnAction(listed.driver, '%1', 7, { kind: 'rewindTo', uuid: 'second' }, target(3)), RewindRecordChanged);
    assert.deepEqual(listed.sent, ['paste /rewind', 'submit', 'up', 'close']);
    assert.equal(listed.screen(), 'closed');
  }
  assert.doesNotMatch(new RewindRecordChanged().message, /未发送按键/, 'not a guard refusal that sendGuarded would repeat');
});

// The rename case: Claude Code writes /rename's records some 250 ms after its title, after the
// app read the transcript the rewind was chosen from. The backend refuses (nothing sent).
const renameRecords = (parent: string, sessionId: string) => [
  { parentUuid: parent, isSidechain: false, type: 'system', subtype: 'local_command', level: 'info', uuid: 'rename-1', sessionId,
    content: '<command-name>/rename</command-name>\n            <command-message>rename</command-message>\n            <command-args>示例开发</command-args>' },
  { parentUuid: 'rename-1', isSidechain: false, type: 'system', subtype: 'local_command', level: 'info', uuid: 'rename-2', sessionId, content: '<local-command-stdout>Session renamed to: 示例开发</local-command-stdout>' },
  { parentUuid: 'rename-2', isSidechain: false, type: 'user', isMeta: true, uuid: 'rename-3', sessionId, message: { role: 'user', content: '<system-reminder>\nThe user named this session "示例开发".\n</system-reminder>' } },
].map(record => JSON.stringify(record) + '\n').join('');

async function rewindController(refusals: number) {
  const jsonl = fixture('2.1.330', 'transcript.jsonl');
  const records = jsonl.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const sessionId = records[0].sessionId, leaf = records.filter(r => r.uuid).at(-1).uuid;
  let unread = jsonl, position: TranscriptPosition = { inode: '42', offset: Buffer.byteLength(jsonl) };
  const calls: { target?: RewindTarget; position?: TranscriptPosition }[] = [];
  const directory = await mkdtemp(path.join(tmpdir(), 'lectern-rewind-test-'));
  const store = new WorkspaceStore(directory);
  await store.save({ id: 'test', name: 'Test', kind: 'local', cwd: '/tmp' });
  const backend = {
    readSession: async (): Promise<ReadResult> => {
      const chunk = unread;
      unread = '';
      return { session: { id: sessionId, title: 'chat', mapping: 'exact', paneId: '%1' } as ReadResult['session'], panePid: 7, nativeStatus: 'idle',
        screen: '──────────\n❯ \n──────────', jsonl: Buffer.from(chunk), active: true, reset: false, hasMore: false, transcriptPosition: position };
    },
    turnAction: async (_ws: unknown, _id: string, _pane: string, _pid: number, _action: unknown, target?: RewindTarget, _assert?: unknown, at?: TranscriptPosition) => {
      calls.push({ target, position: at });
      if (calls.length > refusals) return undefined;
      if (calls.length === 1) {
        const added = renameRecords(leaf, sessionId);
        unread += added;
        position = { inode: '42', offset: position.offset + Buffer.byteLength(added) };
      }
      throw new RewindRecordChanged();
    },
    completions: { isInstalled: async () => false },
    probeModelCatalog: async () => ({ observedAt: new Date().toISOString(), defaults: {}, models: [] }),
    resetRead() {}, dispose() {},
  } as unknown as Backend;
  const controller = new Controller(store, backend);
  let snapshot: SessionSnapshot | undefined;
  controller.on('snapshot', next => { snapshot = next; });
  await controller.watchSession('test', sessionId);
  const uuid = snapshot!.messages.find(message => message.text === SECOND)!.rewindUuid!;
  return { controller, sessionId, uuid, calls, cleanup: async () => { await controller.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

test('a rewind refused for a transcript written meanwhile is read again and chosen once more', { timeout: 10_000 }, async () => {
  const { controller, sessionId, uuid, calls, cleanup } = await rewindController(1);
  try {
    await controller.turnAction('test', sessionId, '%1', 7, { kind: 'rewindTo', uuid });
    assert.equal(calls.length, 2);
    // The native list with the switches, the same row both times, bound to the newer read the second time.
    assert.deepEqual(calls[0].target, { index: 3, prompts: NATIVE });
    assert.deepEqual(calls[1].target, calls[0].target);
    assert.ok(calls[1].position!.offset > calls[0].position!.offset);
  } finally { await cleanup(); }
});

test('a rewind refused again after the new read is not repeated a second time', { timeout: 10_000 }, async () => {
  const { controller, sessionId, uuid, calls, cleanup } = await rewindController(2);
  try {
    await assert.rejects(controller.turnAction('test', sessionId, '%1', 7, { kind: 'rewindTo', uuid }), { message: t('native.rewindRecordChanged') });
    assert.equal(calls.length, 2);
  } finally { await cleanup(); }
});

// The installed CLI resumes a conversation in which Lectern switched model and effort in one
// step after the first prompt and after the second, and Lectern rewinds it from its own reading
// of the transcript (like native-branch-integration.test.ts: no user config, model traffic to
// a closed port). Run with an older Claude Code first on PATH to check that version.
test('installed CLI: rewind past one-step /model and /effort switches; a failed rewind closes its menu', {
  skip: process.env.LECTERN_NATIVE_BRANCH_TEST !== '1' || process.platform === 'win32', timeout: 120_000,
}, async () => {
  const { root, cwd, dir, env: fixtureEnv, ws, originalId } = await nativeBranchFixture(1);
  const file = path.join(dir, originalId + '.jsonl');
  let parent: string | null = null;
  const lines: string[] = [];
  const add = (record: object) => { const uuid = randomUUID(); lines.push(JSON.stringify({ parentUuid: parent, isSidechain: false, cwd, sessionId: originalId, version: '2.1.330', userType: 'external', uuid, timestamp: '2026-11-23T08:00:00.000Z', ...record })); parent = uuid; };
  const prompt = (text: string, answer: string) => {
    add({ type: 'user', message: { role: 'user', content: text } });
    add({ type: 'assistant', message: { id: 'msg_' + randomUUID(), type: 'message', model: 'claude-opus-4-7', role: 'assistant', content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', usage: { input_tokens: 4, output_tokens: 3 } } });
  };
  const local = (name: string, args: string, stdout: string) => {
    add({ type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>' } });
    add({ type: 'user', message: { role: 'user', content: `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args>${args}</command-args>` } });
    add({ type: 'user', message: { role: 'user', content: `<local-command-stdout>${stdout}</local-command-stdout>` } });
  };
  prompt('First question', 'First answer');
  local('model', 'sonnet', 'Set model to Sonnet and saved as your default for new sessions');
  local('effort', 'low', 'Set effort level to low (saved as your default for new sessions)');
  prompt('Second question', 'Second answer');
  local('effort', 'high', 'Set effort level to high (saved as your default for new sessions)');
  local('model', 'haiku', 'Set model to Haiku and saved as your default for new sessions');
  await writeFile(file, lines.join('\n') + '\n');
  const socket = 'lectern-rewind-' + randomUUID().slice(0, 8);
  fixtureClaudeConfig(fixtureEnv.CLAUDE_CONFIG_DIR!);
  const privateServer = isolateTmux(socket, fixtureEnv);
  const tmux = (...args: string[]) => privateServer.tmux('-f', '/dev/null', ...args).trim();
  const backend = new Backend({ tmuxSocket: socket });
  const wait = async (condition: () => boolean | Promise<boolean>, label: string) => {
    const until = Date.now() + 15000;
    do { if (await condition()) return; await new Promise(r => setTimeout(r, 100)); } while (Date.now() < until);
    throw new Error(label);
  };
  try {
    tmux('new-session', '-d', '-s', 'fixture-owner', '-c', cwd, 'sleep', '120');
    const session = await backend.resumeSession(ws, originalId);
    const paneId = session.paneId!, pid = Number(tmux('display-message', '-p', '-t', paneId, '#{pane_pid}'));
    const frame = () => tmux('capture-pane', '-p', '-J', '-t', paneId);
    const idle = async () => { const r = await backend.readSession(ws, originalId, true); return r.nativeStatus === 'idle' && isIdleEmptyComposer(r.viewport ?? ''); };
    await wait(idle, 'native composer not ready');
    const view = new MessageDisplay(originalId);
    view.ingestJsonl(await readFile(file, 'utf8'), true, false);
    const list = view.rewindPoints()!.map(point => point.text);
    assert.deepEqual(list, ['First question', '/model sonnet', '/effort low', 'Second question', '/effort high', '/model haiku']);
    const position = async () => (await backend.readSession(ws, originalId, true)).transcriptPosition;

    // Lectern's list without the switches: refused at the open menu, which is closed again.
    await assert.rejects(backend.turnAction(ws, originalId, paneId, pid, { kind: 'rewindTo', uuid: 'second' }, { index: 1, prompts: ['First question', 'Second question'] }, undefined, await position()),
      { message: t('native.rewindMenuClosed', { detail: t('native.rewindMismatch') }) });
    assert.equal(readRewind(frame()), undefined, 'no menu left open');
    await wait(idle, 'the input box is not back');

    // A record written after the read: refused before /rewind is typed.
    const read = await position();
    await appendFile(file, JSON.stringify({ type: 'custom-title', customTitle: 'Renamed', sessionId: originalId }) + '\n');
    await assert.rejects(backend.turnAction(ws, originalId, paneId, pid, { kind: 'rewindTo', uuid: 'second' }, { index: 3, prompts: list }, undefined, read), RewindRecordChanged);
    assert.equal(turnComposer(frame())?.text, '', 'nothing typed');

    // The same rewind after a new read: the row of the second prompt, below the first switches.
    await backend.turnAction(ws, originalId, paneId, pid, { kind: 'rewindTo', uuid: 'second' }, { index: 3, prompts: list }, undefined, await position());
    const confirm = readRewind(frame());
    assert.equal(confirm?.message, 'Second question');
    const restored = await backend.turnAction(ws, originalId, paneId, pid, { kind: 'restore', signature: confirm!.signature }, { index: 3, prompts: list }, undefined, await position());
    assert.equal(restored?.restoredDraft, 'Second question');
    const cut = frame();
    assert.ok(cut.includes('First answer') && cut.includes('/effort low') && !cut.includes('Second answer') && !cut.includes('/model haiku'), cut);
  } finally {
    await backend.dispose();
    privateServer.cleanup();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
