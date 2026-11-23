import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performTurnAction, type TurnDriver } from '../src/backend/native-turn-controls';
import { forkCapability, submitNativeFork } from '../src/backend/native-fork';
import { focusedTurnCommandDescription, readRewind, turnComposer } from '../src/core/turn-controls';
import { focusedSettingCommandHistory, hasPendingSettingCommand, isIdleEmptyComposer, observeUltracode } from '../src/core/settings-screen';
import { completionBlocks } from '../src/core/slash-completions';
import { classifySessionScreen, stripTerminalEscapes } from '../src/core/screen';
import { parseQuestionScreen } from '../src/core/question-screen';
import { t } from '../src/shared/i18n';

// Frames captured (capture-pane -e) from Claude Code 2.1.330 in a 120×40 pane, the size
// Lectern gives its sessions. The session was renamed to 示例开发 (*-named, *-wrapped,
// rewind-menu, rewind-erased) or to an 80-character CJK name that the input box's upper
// border cuts with an ellipsis (*-long-name). User skills with long CJK descriptions wrap
// in the slash completion list: review-reminder and weekly-reminder are offered for
// /rewind, fork-and-branch-guide for /fork, model-effort-notes for /model and /effort.
// The reported screen: the completion for /rewind was shown, but its wrapped neighbour
// hid it from Lectern, which neither pressed Enter nor took the typed /rewind out again.
const frame = (name: string) => readFileSync(new URL(`./fixtures/rewind-2.1.330/${name}.ansi`, import.meta.url), 'utf8');
const idle = frame('idle-named'), typed = frame('rewind-typed-wrapped'), menu = frame('rewind-menu'), erased = frame('rewind-erased');
const idleLong = frame('idle-long-name'), typedLong = frame('rewind-typed-long-name'), menuLong = frame('rewind-menu-long-name');
// The same long-name session in Claude Code 2.1.300, whose /rewind completion says something else.
const frame300 = (name: string) => readFileSync(new URL(`./fixtures/rewind-2.1.300/${name}.ansi`, import.meta.url), 'utf8');
const idle300 = frame300('idle-long-name'), typed300 = frame300('rewind-typed-long-name'), menu300 = frame300('rewind-menu-long-name');
const REWIND = 'Restore earlier code, conversation, or both';
const plain = (view: string) => stripTerminalEscapes(view).split('\n');
/** The row of the input box's draft: the last one starting with ❯. */
const draftRow = (view: string) => { const lines = plain(view); let i = lines.length - 1; while (i >= 0 && !lines[i].startsWith('❯')) i--; return i; };
const borderOf = (view: string) => plain(view)[draftRow(view) - 1].trimEnd();
/** The same frame with the draft in the input box changed. */
const edit = (view: string) => { assert.ok(view.includes('❯\u00a0\x1b[97m/rewind')); return view.replace('❯\u00a0\x1b[97m/rewind', '❯\u00a0\x1b[97m/rewind x'); };
/** The same frame with the input box's upper border replaced. */
const withBorder = (view: string, border: string) => {
  const lines = view.split('\n'), at = draftRow(view) - 1;
  lines[at] = border;
  return lines.join('\n');
};

test('2.1.330 renamed sessions: the input box under a CJK name and under a name cut short', () => {
  assert.match(borderOf(idle), /^─{100,} 示例开发 ─$/u);
  assert.match(borderOf(idleLong), /^ 超长会话名称截断测试.*截断… ─$/u, 'no rule before a name as wide as the row');
  for (const [view, text] of [[idle, ''], [erased, ''], [idleLong, ''], [typed, '/rewind'], [typedLong, '/rewind'],
    [frame('fork-typed-long-name'), '/fork'], [frame('model-typed-long-name'), '/model']] as const) assert.equal(turnComposer(view)?.text, text);
  for (const view of [idle, erased, idleLong]) {
    assert.ok(isIdleEmptyComposer(view));
    assert.equal(classifySessionScreen(view).status, 'idle');
    // A name in the border says nothing about Ultracode.
    assert.equal(observeUltracode(view), undefined);
  }
  assert.equal(readRewind(menu)?.stage, 'checkpoint');
  assert.equal(readRewind(menuLong)?.stage, 'checkpoint');
});

test('every width of name the upper border holds (measured at 119–121 columns)', () => {
  const shapes = [
    '─────── ' + 'a'.repeat(110) + ' ─', '──── ' + 'a'.repeat(113) + ' ─', '─ ' + 'a'.repeat(116) + ' ─',
    ' ' + 'a'.repeat(117) + ' ─', ' ' + 'a'.repeat(116) + '… ─', '─ ' + '名'.repeat(57) + '… ─', ' ' + '名称'.repeat(29) + ' ─',
  ];
  for (const border of shapes) {
    assert.equal(turnComposer(withBorder(idle, border))?.empty, true, border);
    assert.ok(isIdleEmptyComposer(withBorder(idle, border)), border);
    assert.equal(focusedTurnCommandDescription(withBorder(typed, border), '/rewind'), REWIND, border);
    assert.ok(hasPendingSettingCommand(withBorder(frame('model-typed-wrapped'), border), '/model', withBorder(idle, border)), border);
  }
  // A draft row is indented by two: one ending in a rule character is still the draft.
  const box = (rows: string) => `● Done\n\n${'─'.repeat(40)} 示例 ─\n${rows}\n${'─'.repeat(48)}\n  ? for shortcuts\n`;
  assert.equal(turnComposer(box('❯ first\n  second ─'))?.text, 'first\nsecond ─');
  // Nor is a row with more indentation, or none before its text, a border.
  assert.equal(turnComposer(box('❯ first').replace(`${'─'.repeat(40)} 示例 ─`, '  some text ─')), undefined);
  assert.equal(turnComposer(box('❯ first').replace(`${'─'.repeat(40)} 示例 ─`, 'text ─')), undefined);
});

test('a wrapped completion description does not hide the focused /rewind, /fork, /model or /effort', () => {
  assert.equal(focusedTurnCommandDescription(typed, '/rewind'), REWIND);
  assert.equal(focusedTurnCommandDescription(typedLong, '/rewind'), REWIND);
  assert.equal(forkCapability(frame('fork-typed-wrapped'), '/fork'), 'background');
  assert.equal(forkCapability(frame('fork-typed-long-name'), '/fork'), 'background');
  assert.ok(hasPendingSettingCommand(frame('model-typed-wrapped'), '/model', idle));
  assert.ok(hasPendingSettingCommand(frame('effort-typed-wrapped'), '/effort', idle));
  assert.ok(hasPendingSettingCommand(frame('model-typed-long-name'), '/model', idleLong));
  assert.ok(focusedSettingCommandHistory(frame('model-typed-long-name'), '/model'));
  // Only the exact description counts, and only for the focused row of the list beside the box.
  assert.equal(focusedTurnCommandDescription(typed.replace(REWIND, 'Restore an older session'), '/rewind'), 'Restore an older session');
  assert.equal(focusedTurnCommandDescription(edit(typed), '/rewind'), undefined, 'a different draft');
  // The rows of a wrapped description belong to its entry, never start one.
  const lines = plain(typed), top = turnComposer(typed)!.top;
  const [block] = completionBlocks(lines.slice(0, top).map(line => line.trimEnd())).filter(b => b.end === top);
  assert.equal(block.end - block.start, 5);
  const focusedSkill = completionBlocks(lines.slice(0, top).map(line => line.replace('  ❯ /rewind', '    /rewind').replace('    /review-reminder', '  ❯ /review-reminder')))
    .find(b => b.end === top)!.focused;
  assert.deepEqual(focusedSkill.map(f => f.command), ['/review-reminder']);
  assert.match(focusedSkill[0].description!, /^读取最近一次代码评审的记录.*没有结论， 以及合并之前需要先确认的地方。用户说“评审提醒”时使用。 \(user\)$/u);
});

test('a question dialog in a session with a cut-off name still drops the closing named rule', () => {
  const named = readFileSync(new URL('./fixtures/question-single-2.1.330/short-named.txt', import.meta.url), 'utf8');
  const rule = named.split('\n').find(line => /^─+ 示例开发 ─\s*$/u.test(line))!;
  assert.ok(rule);
  const cut = named.replace(rule, ' ' + '超长会话名称截断测试'.repeat(6).slice(0, 58) + '… ─');
  assert.deepEqual(parseQuestionScreen(cut, { pendingToolUse: true }), parseQuestionScreen(named, { pendingToolUse: true }));
  assert.ok(parseQuestionScreen(cut, { pendingToolUse: true }));
});

// Variants: the transcript above changed (the guard refuses on them), and a /rewind whose
// completion does not read as the native rewind.
const changed = (view: string, n: number) => { assert.ok(view.includes('Fixture answer 3')); return view.replace('Fixture answer 3', 'Fixture answer 3' + '.'.repeat(n)); };
const unknown = typed.replace(REWIND, 'Restore an older session');
type Step = 'paste /rewind' | 'submit' | 'erase' | 'paste /fork' | 'switchSession';
const next: Record<Step, Map<string, string>> = {
  'paste /rewind': new Map([[idle, typed], [idleLong, typedLong], [idle300, typed300]]),
  'submit': new Map([[typed, menu], [typedLong, menuLong], [typed300, menu300]]),
  'erase': new Map([[unknown, erased], ...[1, 2, 3].map(n => [changed(typed, n), erased] as [string, string])]),
  'paste /fork': new Map(),
  'switchSession': new Map(),
};
function pane(start: string, between: Partial<Record<Step, (() => string)[]>> = {}, after: Partial<Record<Step, Map<string, string>>> = {}) {
  let screen = start, observed: string | undefined;
  const attempts: Step[] = [], sent: Step[] = [];
  const dispatch = async (step: Step) => {
    attempts.push(step);
    const change = between[step]?.shift();
    if (change) screen = change();
    if (screen !== observed) throw new Error(t('native.screenChangedNoKeys'));
    sent.push(step);
    screen = after[step]?.get(screen) ?? next[step].get(screen) ?? assert.fail(`no recorded screen after ${step}`);
  };
  const driver: TurnDriver = {
    frame: async () => { observed = screen; return { viewport: screen, paneId: '%1', panePid: 7, nativeStatus: 'idle' }; },
    pasteForTurn: async text => dispatch(`paste ${text}` as Step),
    keyForTurn: async key => dispatch(key as Step),
  };
  return { driver, attempts, sent, screen: () => screen };
}

test('rewind opens in a renamed session whose /rewind completion has wrapped neighbours, and under a cut-off name', async () => {
  // 2.1.300–2.1.321 describe /rewind as "Restore the code and/or conversation to a previous point".
  assert.equal(focusedTurnCommandDescription(typed300, '/rewind'), 'Restore the code and/or conversation to a previous point');
  assert.equal(readRewind(menu300)?.stage, 'checkpoint');
  // Its confirmation asks "Confirm you want to restore …" and adds notes before the choices
  // (captured by the compatibility matrix, rewind-renamed).
  const confirm300 = readRewind(readFileSync(new URL('./fixtures/rewind-2.1.300/rewind-confirm.txt', import.meta.url), 'utf8'));
  assert.deepEqual([confirm300?.stage, confirm300?.message, confirm300?.rows.map(row => row.label), confirm300?.focused],
    ['confirm', 'Rewind check two ccm:rw-two', ['Restore conversation', 'Summarize from here', 'Summarize up to here', 'Never mind'], 0]);
  for (const [start, opened] of [[idle, menu], [idleLong, menuLong], [idle300, menu300]]) {
    const { driver, sent, screen } = pane(start);
    await performTurnAction(driver, '%1', 7, { kind: 'openRewind' });
    assert.deepEqual(sent, ['paste /rewind', 'submit']);
    assert.equal(screen(), opened);
  }
});

test('an unconfirmed /rewind is taken out of the input box, never submitted', async () => {
  const { driver, sent, screen } = pane(idle, {}, { 'paste /rewind': new Map([[idle, unknown]]) });
  await assert.rejects(performTurnAction(driver, '%1', 7, { kind: 'openRewind' }), { message: t('native.slashCommandUnconfirmed', { command: '/rewind' }) });
  assert.deepEqual(sent, ['paste /rewind', 'erase']);
  assert.equal(screen(), erased);
  assert.ok(isIdleEmptyComposer(screen()));
});

test('a /rewind that cannot be taken out either says so, and sends nothing into a changed input box', async () => {
  // The user edits the draft before the erase: Ctrl+U would delete their text too.
  const edited = edit(unknown);
  assert.equal(turnComposer(edited)?.text, '/rewind x');
  const { driver, sent } = pane(idle, { erase: [() => edited] }, { 'paste /rewind': new Map([[idle, unknown]]) });
  await assert.rejects(performTurnAction(driver, '%1', 7, { kind: 'openRewind' }), { message: t('native.slashCommandUnconfirmedLeft', { command: '/rewind' }) });
  assert.deepEqual(sent, ['paste /rewind']);
});

test('a /rewind whose Enter stays refused is taken out again', async () => {
  const { driver, attempts, sent, screen } = pane(idle, { submit: [1, 2, 3].map(n => () => changed(typed, n)) });
  await assert.rejects(performTurnAction(driver, '%1', 7, { kind: 'openRewind' }), { message: t('native.slashCommandNotSubmitted', { command: '/rewind' }) });
  assert.deepEqual(attempts, ['paste /rewind', 'submit', 'submit', 'submit', 'erase']);
  assert.deepEqual(sent, ['paste /rewind', 'erase']);
  assert.equal(screen(), erased);
});

test('fork: a /fork whose completion is not understood is taken out, not submitted', async () => {
  const forkTyped = frame('fork-typed-wrapped');
  const odd = forkTyped.replace('Copy this conversation into a new background session and keep working here', 'Fork something else');
  assert.equal(forkCapability(odd, '/fork'), undefined);
  const { driver, sent, screen } = pane(idle, {}, { 'paste /fork': new Map([[idle, odd]]), erase: new Map([[odd, erased]]) });
  await assert.rejects(submitNativeFork(driver, '%1', 7), { message: t('native.slashCommandUnconfirmed', { command: '/fork' }) });
  assert.deepEqual(sent, ['paste /fork', 'erase']);
  assert.equal(screen(), erased);
});
