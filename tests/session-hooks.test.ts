import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { canonical, dialogHookStatus, hookPermissionCall, hookQuestionCall, hooksLive } from '../src/main/session-hooks';
import { readHookPermission, screenShowsCall } from '../src/core/permission-hook';
import { parsePermissionScreen } from '../src/core/permission-screen';
import { performPermissionAction } from '../src/backend/native-permission-actions';
import type { DialogHookObservation, DialogHookRecord } from '../src/shared/dialog-hooks';
import type { ChatMessage, ToolBlock } from '../src/shared/types';

const ASK = { questions: [{ question: 'Tea?', header: 'Drink', options: [{ label: 'Yes' }, { label: 'No' }] }] };
const BASH = { command: 'echo hello > greeting.txt', description: 'Write a greeting file' };
let seq = 0;
const record = (event: DialogHookRecord['event'], extra: Partial<DialogHookRecord> = {}): DialogHookRecord => ({ event, seq: ++seq, at: 1, ...extra });
const hooks = (...records: DialogHookRecord[]): DialogHookObservation => ({ folder: true, started: { at: 1, source: 'startup' }, records, rejected: 0 });
const started = () => record('SessionStart', { source: 'startup' });
const call = (id: string, name: string, input: object, result?: string): ToolBlock => ({ id, name, input: JSON.stringify(input), ...result !== undefined && { result } });
const turn = (...tools: ToolBlock[]): ChatMessage[] => [
  { id: 'u', role: 'user', text: 'go', tools: [] } as unknown as ChatMessage,
  { id: 'a', role: 'assistant', text: '', tools } as unknown as ChatMessage,
];

test('hook data counts only after SessionStart, while the launch folder is there', () => {
  assert.equal(hooksLive(undefined), false);
  assert.equal(hooksLive({ folder: true, records: [], rejected: 0 }), false);
  assert.equal(hooksLive({ ...hooks(), folder: false }), false);
  assert.equal(hooksLive(hooks()), true);
  assert.deepEqual(dialogHookStatus(false, undefined, true), { state: 'off' });
  assert.deepEqual(dialogHookStatus(true, undefined, true), { state: 'unavailable', reason: 'not-launched' });
  assert.deepEqual(dialogHookStatus(true, { folder: true, records: [], rejected: 0 }, true), { state: 'waiting' });
  assert.deepEqual(dialogHookStatus(true, { ...hooks(), folder: false }, true), { state: 'unavailable', reason: 'no-folder' });
  assert.equal(dialogHookStatus(false, hooks(), true).state, 'active', 'a process launched with them keeps them');
});

test('the question\'s call: the newest main-conversation AskUserQuestion PreToolUse without a result', () => {
  const pre = (id: string, extra: Partial<DialogHookRecord> = {}) => record('PreToolUse', { toolName: 'AskUserQuestion', toolUseId: id, input: ASK, ...extra });
  assert.equal(hookQuestionCall(hooks(started(), pre('t1')), [])?.toolUseId, 't1', 'before the transcript has it');
  assert.equal(hookQuestionCall(hooks(started(), pre('t1')), turn(call('t1', 'AskUserQuestion', ASK)))?.toolUseId, 't1');
  assert.equal(hookQuestionCall(hooks(started(), pre('t1')), turn(call('t1', 'AskUserQuestion', ASK, 'answered'))), undefined, 'answered');
  assert.equal(hookQuestionCall(hooks(started(), pre('t1'), pre('t2')), turn(call('t1', 'AskUserQuestion', ASK, 'a')))?.toolUseId, 't2');
  assert.equal(hookQuestionCall(hooks(started(), pre('t1'), pre('t2', { agentId: 'sub' })), [])?.toolUseId, 't1', 'a subagent\'s is not the card\'s');
  assert.equal(hookQuestionCall(hooks(started(), pre('t1', { input: { questions: 'x' } })), []), undefined, 'not a question set');
  assert.equal(hookQuestionCall({ ...hooks(pre('t1')), started: undefined }, []), undefined, 'no SessionStart');
});

test('the permission\'s call: the newest PermissionRequest, bound by input to the transcript, never an answered or superseded one', () => {
  const request = (input: object = BASH, extra: Partial<DialogHookRecord> = {}) => record('PermissionRequest', { toolName: 'Bash', input: input as Record<string, unknown>, ...extra });
  // Before the transcript has the call (a streamed call is written once answered): unbound.
  assert.deepEqual(hookPermissionCall(hooks(started(), request()), []), { toolName: 'Bash', input: BASH });
  // Bound to the turn's open call of the same tool and input, key order aside.
  assert.equal(hookPermissionCall(hooks(started(), request()), turn(call('b1', 'Bash', { description: BASH.description, command: BASH.command })))?.toolUseId, 'b1');
  // That call answered: an old request.
  assert.equal(hookPermissionCall(hooks(started(), request()), turn(call('b1', 'Bash', BASH, 'done'))), undefined);
  // A subagent's request is the dialog now: none here. A tool call started since: not this dialog.
  assert.equal(hookPermissionCall(hooks(started(), request(), request(BASH, { agentId: 'sub' })), []), undefined);
  assert.equal(hookPermissionCall(hooks(started(), request(), record('PreToolUse', { toolName: 'AskUserQuestion', toolUseId: 'q', input: ASK })), []), undefined);
  // Bound by a PreToolUse of the same call when there is one (a matcher that covers it).
  const pre = record('PreToolUse', { toolName: 'Bash', toolUseId: 'p1', input: BASH });
  assert.equal(hookPermissionCall(hooks(started(), pre, request()), [])?.toolUseId, 'p1');
  assert.equal(hookPermissionCall(hooks(started(), pre, request()), turn(call('p1', 'Bash', BASH, 'done'))), undefined);
  // AskUserQuestion asks permission too: that dialog is the question card's.
  assert.equal(hookPermissionCall(hooks(started(), request(ASK, { toolName: 'AskUserQuestion' })), []), undefined);
  assert.equal(canonical({ b: [1, { d: 2, c: 3 }], a: null }), '{"a":null,"b":[1,{"c":3,"d":2}]}');
});

const bashShot = readFileSync(new URL('./fixtures/permission-2.1.328/bash.txt', import.meta.url), 'utf8');
const BASH_CALL = { toolName: 'Bash', input: { command: 'echo hello > greeting.txt && ls', description: 'Write a greeting file' } };
// The same dialog with its top out of the pane: from the box's lower edge down.
const cutShot = bashShot.split('\n').slice(16).join('\n');

test('a tool dialog with its PermissionRequest: the whole input on the card, the bottom alone when the top is cut off', () => {
  const whole = parsePermissionScreen(bashShot)!;
  assert.equal(screenShowsCall(whole, BASH_CALL), true);
  assert.deepEqual(readHookPermission(bashShot, BASH_CALL), { ...whole, call: BASH_CALL });
  // Another call's request is not this dialog (Claude Code asks without a hook after "Auto mode can't check actions").
  assert.equal(readHookPermission(bashShot, { toolName: 'Bash', input: { command: 'rm -rf build' } }), undefined);
  assert.equal(readHookPermission(bashShot, { toolName: 'Write', input: { file_path: '/work/new.md', content: 'x' } }), undefined);
  assert.equal(parsePermissionScreen(cutShot), undefined, 'the screen alone cannot read it');
  const cut = readHookPermission(cutShot, BASH_CALL)!;
  assert.deepEqual({ ...cut, options: cut.options.map(o => o.label) }, { title: 'Bash', subtitle: [], content: [], question: 'Do you want to proceed?',
    options: ['Yes', 'Yes, and always allow access to /private/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T/lectern-perm-rZI2VL/work from this project', 'No'],
    footer: 'Esc to cancel · Tab to amend', call: BASH_CALL });
  // Long text is cut for the card (the snapshot goes out with every poll); the input stays Claude Code's.
  const long = readHookPermission(bashShot, { toolName: 'Bash', input: { ...BASH_CALL.input, note: 'x'.repeat(30_000) } })!;
  assert.equal((long.call!.input.note as string).length, 20_002);
});

test('the driver reads every frame with the call: choosing on a cut-off dialog moves, proves and confirms', async () => {
  let current = cutShot, status = 'waiting';
  const down = cutShot.replace(' ❯ 1. Yes', '   1. Yes').replace('   3. No', ' ❯ 3. No');
  const keys: string[] = [];
  const driver = {
    frame: async () => ({ paneId: '%1', panePid: 10, viewport: current, nativeStatus: status, nativeWaitingFor: status === 'waiting' ? 'permission prompt' : undefined }),
    questionKey: async (key: string) => {
      keys.push(key);
      if (key === 'Down') current = current === cutShot ? cutShot.replace(' ❯ 1. Yes', '   1. Yes').replace('   2. Yes, and', ' ❯ 2. Yes, and') : down;
      if (key === 'Enter') { current = '⏺ Bash(echo hello > greeting.txt && ls)\n'; status = 'busy'; }
    },
  };
  const expected = readHookPermission(cutShot, BASH_CALL)!;
  await performPermissionAction(driver, '%1', 10, expected, { kind: 'choose', number: 3 }, () => {}, BASH_CALL);
  assert.deepEqual(keys, ['Down', 'Down', 'Enter']);
});
