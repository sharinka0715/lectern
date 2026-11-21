import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { composerFrameGuard, guardWindow } from '../src/backend/composer-frame-guard';
import { classifySessionScreen, withoutTaskRows } from '../src/core/screen';
import { turnComposer } from '../src/core/turn-controls';
import { parseExecutionMode } from '../src/core/session-telemetry';
import { focusedSettingCommandHistory, hasPendingSettingCommand, isIdleEmptyComposer, observeEffortFooter, parseSettingScreen, priorComposerHistory, readSettingReceipt } from '../src/core/settings-screen';

// Claude Code 2.1.329/2.1.330 with background subagents still running, captured in the
// matrix sandbox (loopback model, 120×40 pane unless named "rows24"; subagents held by
// the fake API): "● main" and up to five subagents below the input box's footer, then
// "↓ N more"; the idle footer gains "↓ to manage". `<count>-<frame>.txt`.
const sample = (version: string, name: string) => readFileSync(new URL(`./fixtures/task-rows-${version}/${name}`, import.meta.url), 'utf8');
const v330 = (name: string) => sample('2.1.330', name);

test('real screens: the input box, its status, effort label and mode are read with subagents listed below it, "↓ N more" too', () => {
  const screens = { '1': v330('1-idle.txt'), '6': v330('6-idle.txt'), '6 styled': v330('6-idle.ansi'), '12': v330('12-idle.txt'),
    '12 in 24 rows': v330('12-rows24-idle.txt'), '2.1.329 3': sample('2.1.329', '3-idle.txt') };
  assert.match(screens['6'], /\n {2}↓ 1 more\n$/u);
  assert.match(screens['12'], /\n {2}↓ 7 more\n$/u);
  const read = (screen: string) => ({ idle: isIdleEmptyComposer(screen), status: classifySessionScreen(screen).status, empty: turnComposer(screen)?.empty,
    effort: observeEffortFooter(screen)?.value, mode: parseExecutionMode(screen)?.mode, setting: parseSettingScreen(screen, 'effort').state });
  const expected = { idle: true, status: 'idle', empty: true, effort: 'medium', mode: 'auto', setting: 'idle' };
  assert.deepEqual(Object.fromEntries(Object.entries(screens).map(([name, screen]) => [name, read(screen)])),
    Object.fromEntries(Object.keys(screens).map(name => [name, expected])));
});

const rule = '─'.repeat(120);
const box = (draft = '', footer = '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents · ↓ to manage') => [rule, `❯ ${draft}`, rule, footer];
/** Rows below the footer: the main thread and `count` subagents, timers at `tick`. */
function tasks(count: number, tick = 0, overflow = false): string[] {
  if (!count) return [];
  const rows = Array.from({ length: overflow ? Math.min(count, 5) : count }, (_, i) =>
    `  ◯ general-purpose  第 ${i + 1} 个子代理`.padEnd(100) + `${3 + i + tick}s · ↓ ${141 + tick}.6k tokens`);
  return ['', '  ● main', ...rows, ...(overflow && count > 5 ? [`  ↓ ${count - 5} more`] : [])];
}
const counts = [0, 1, 5, 12];
const screen = (rows: string[]) => rows.join('\n') + '\n';
const history = ['❯ 早先的提问', '', '● 早先的回复', ''];
const badge = (label: string) => ' '.repeat(100) + label;

test('the effort label is read above the input box with 0, 1, 5 or 12 task rows below, with or without "↓ N more"', () => {
  const observed: Record<string, string | undefined> = {}, wanted: Record<string, string | undefined> = {};
  for (const count of counts) for (const overflow of [false, true]) for (const label of [undefined, '◐ medium · /effort', '◉ xhigh · /effort']) {
    const key = `${count}${overflow ? '+more' : ''} ${label ?? 'none'}`;
    observed[key] = observeEffortFooter(screen([...history, ...(label ? [badge(label)] : []), ...box(), ...tasks(count, 0, overflow)]))?.value;
    wanted[key] = label?.split(' ')[1];
  }
  assert.deepEqual(observed, wanted);
});

test('an effort label right below the footer (earlier layouts) is never taken for a task row', () => {
  for (const label of ['  ◉ xhigh · /effort', '  ● max · /effort', '  ○ low · /effort']) {
    const rows = [...history, ...box('', '  ? for shortcuts'), label];
    assert.deepEqual(withoutTaskRows(rows), rows);
    assert.equal(observeEffortFooter(screen(rows))?.value, label.trim().split(' ')[1]);
  }
});

test('real screens: /model and /effort typed from the chat box are verified, adopted and their receipt read with subagents listed', () => {
  // Each typed frame against the idle frame right before it, as `type()` compares them:
  // the task timers moved on and the idle-only "← for agents · ↓ to manage" went away.
  const pairs: [string, string, Parameters<typeof hasPendingSettingCommand>[1]][] = [
    ['6-effort-inline-typed', '6-idle', '/effort xhigh'], ['6-model-typed', '6-effort-inline-done', '/model'],
    ['6-effort-typed', '6-model-closed', '/effort'], ['6-model-inline-typed', '6-effort-closed', '/model haiku'],
    ['1-model-typed', '1-effort-inline-done', '/model'], ['12-model-typed', '12-effort-inline-done', '/model'],
    ['12-rows24-model-typed', '12-rows24-effort-inline-done', '/model'],
  ];
  assert.deepEqual(pairs.map(([typed, idle, command]) => hasPendingSettingCommand(v330(typed + '.txt'), command, v330(idle + '.txt'))), pairs.map(() => true));
  assert.equal(hasPendingSettingCommand(sample('2.1.329', '3-model-typed.txt'), '/model', sample('2.1.329', '3-effort-inline-done.txt')), true);
  // A click on the chooser may adopt a /model already typed into the box.
  assert.deepEqual(['6-model-typed', '12-model-typed', '1-model-typed'].map(name => focusedSettingCommandHistory(v330(name + '.txt'), '/model')?.at(-1)),
    ['● Launched helpers (ccm-launched).', '● Launched helpers (ccm-launched).', '     (on supported models)']);
  // The receipt of the inline switch, above the returned input box.
  assert.equal(readSettingReceipt(v330('6-effort-inline-done.txt'), 'effort', priorComposerHistory(v330('6-idle.txt')), '/effort xhigh'),
    'Set effort level to xhigh (saved as your default for new sessions): Deeper reasoning than high, just below maximum (on supported models)');
  assert.equal(parseSettingScreen(v330('6-model-closed.txt'), 'model').state, 'idle');
});

// The 2.1.329 idle sample with the effort label and a named session's border, and the
// same box with a typed command (its completion row above, the idle-only hint gone).
const idle329 = readFileSync(new URL('./fixtures/rewind-2.1.329/idle-effort.ansi', import.meta.url), 'utf8').trimEnd();
function typed329(command: string) {
  const rows = idle329.split('\n'), border = rows.map(line => line.includes(' Branch-only ')).lastIndexOf(true);
  const typed = rows.map((line, i) => i === border + 1 ? `❯ ${command}` : line.replace(' · ← for agents', ''));
  typed.splice(border, 0, `  ❯ ${command}`.padEnd(30) + (command === '/model' ? 'Switch model' : "Set the model's effort level"));
  return typed.join('\n');
}
const withTasks = (text: string, rows: string[]) => text + '\n' + (rows.length ? rows.join('\n') + '\n' : '');

test('2.1.329 samples with 0, 1, 5 or 12 task rows appended: typed /model and /effort still check against the idle frame', () => {
  assert.ok(isIdleEmptyComposer(idle329) && idle329.includes('◉ xhigh · /effort'));
  const results: Record<string, unknown> = {}, wanted: Record<string, unknown> = {};
  for (const count of counts) for (const overflow of [false, true]) for (const command of ['/model', '/effort'] as const) {
    const idle = withTasks(idle329, tasks(count, 0, overflow)), typed = withTasks(typed329(command), tasks(count, 2, overflow));
    const key = `${count}${overflow ? '+more' : ''} ${command}`;
    results[key] = { idle: isIdleEmptyComposer(idle), effort: observeEffortFooter(idle)?.value, pending: hasPendingSettingCommand(typed, command, idle),
      adopted: focusedSettingCommandHistory(typed, command) !== undefined, wrong: hasPendingSettingCommand(typed.replace(`❯ ${command}\n`, `❯ ${command} x\n`), command, idle) };
    wanted[key] = { idle: true, effort: 'xhigh', pending: true, adopted: true, wrong: false };
  }
  assert.deepEqual(results, wanted);
});

test('completions below the input box: task rows under them are still not part of its footer', () => {
  const completions = ['  ❯ /effort'.padEnd(30) + "Set the model's effort level", '    /code-review'.padEnd(30) + 'Review the current diff'];
  const idle = screen([...history, ...box(), ...tasks(5)]);
  const typed = screen([...history, ...box('/effort', completions[0]), completions[1], '  ⏵⏵ auto mode on (shift+tab to cycle)', ...tasks(5, 3)]);
  assert.equal(hasPendingSettingCommand(typed, '/effort', idle), true);
  assert.equal(hasPendingSettingCommand(typed.replace('(shift+tab to cycle)\n', '(shift+tab to cycle)\n  Press Enter to continue\n'), '/effort', idle), false);
});

// Every key guard hashes `capture-pane | <filter>` on the target against `expected` from
// the frame the key was chosen on (src/backend/index.ts). A turn key (stop, queue, steer,
// paste) cuts it to the input box (`tail -n`), a typed /model or /effort and its Enter
// keep the whole frame. Task timers tick every second between the read and the key.
const onTarget = (filter: string, capture: string) => execFileSync('sh', ['-c', 'cat' + filter], { input: capture, encoding: 'utf8' });
const posix = { skip: process.platform === 'win32' ? 'POSIX sh, tail and awk' : false };
const tick = (capture: string, by = 1) => capture.replace(/(\d+)(s(?:\x1b\[[0-9;]*m)*(?: · ↓ \S+ tokens)?(?:\x1b\[[0-9;]*m)* *)$/gmu, (_, n, rest) => `${Number(n) + by}${rest}`);
const turnKey = (read: string) => guardWindow(read, { viewport: read, tailLines: turnComposer(read)!.tailLines - 1, filter: '' });
const wholeFrame = (read: string) => guardWindow(read, { viewport: read, filter: '' });
/** Text typed into the input box (the last prompt row of the capture). */
const typeInto = (capture: string, text: string) => { const at = capture.lastIndexOf('❯'); return capture.slice(0, at + 1) + ' ' + text + capture.slice(at + 1); };

test('real screen: a turn key is guarded on the input box down to its footer, not on the subagent timers below', posix, () => {
  const read = v330('6-idle.ansi'), later = v330('6-idle-later.ansi');
  assert.notEqual(later, read, 'the timers moved on between the two captures');
  const { filter, expected } = turnKey(read);
  const rows = expected.replace(/\x1b\[[0-9;]*m/g, '').trimEnd().split('\n');
  assert.match(rows[0], /^─{120}/u, 'from the upper border');
  assert.match(rows.at(-1)!, /auto mode on .*↓ to manage/u, 'to the footer');
  assert.deepEqual([onTarget(filter, read), onTarget(filter, later)], [expected, expected]);
  // Still refused: another draft, a row below that is no task row, one row more or fewer.
  for (const changed of [typeInto(later, 'x'), later.replace(/^.*general-purpose.*Helper 3.*$/mu, '  Press Enter to continue'),
    later.replace(/\n[^\n]*↓ 1 more[^\n]*\n$/u, '\n'), later + '  ◯ general-purpose  Helper 7  0s\n'])
    assert.notEqual(onTarget(filter, changed), expected);
});

test('turn keys and whole-frame keys pass when only the timers of 0, 1, 5 or 12 task rows changed', posix, () => {
  const results: Record<string, boolean[]> = {}, wanted: Record<string, boolean[]> = {};
  for (const count of counts) for (const overflow of [false, true]) {
    const read = screen([...history, badge('◉ xhigh · /effort'), ...box(), ...tasks(count, 0, overflow)]);
    const later = screen([...history, badge('◉ xhigh · /effort'), ...box(), ...tasks(count, 1, overflow)]);
    const typed = screen([...history, ...box('/effort', '  ⏵⏵ auto mode on (shift+tab to cycle)'), ...tasks(count, 0, overflow)]);
    const key = `${count}${overflow ? '+more' : ''}`;
    results[key] = [turnKey(read), wholeFrame(read), wholeFrame(typed)].flatMap(({ filter, expected }, i) => {
      const [base, next] = i === 2 ? [typed, tick(typed)] : [read, later];
      return [onTarget(filter, next) === expected, onTarget(filter, typeInto(next, 'y')) === expected, onTarget(filter, base) === expected];
    });
    wanted[key] = [true, false, true, true, false, true, true, false, true];
  }
  assert.deepEqual(results, wanted);
});

test('a typed /model or /effort is guarded with its tmux advisory slot and without the subagent timers', posix, () => {
  const read = v330('6-effort-inline-done.txt');
  assert.match(read, /tmux focus-events off/);
  const paste = guardWindow(read, composerFrameGuard(read));
  const later = tick(read).replace(/^ +tmux focus-events off.*$/mu, '');
  assert.notEqual(later, read);
  assert.deepEqual([onTarget(paste.filter, read), onTarget(paste.filter, later)], [paste.expected, paste.expected]);
  assert.notEqual(onTarget(paste.filter, typeInto(later, '/model')), paste.expected);
  // Its Enter is guarded on the typed frame, completion list above the box included.
  const typed = v330('6-model-typed.ansi'), enter = wholeFrame(typed);
  assert.equal(onTarget(enter.filter, tick(typed, 5)), enter.expected);
  assert.notEqual(onTarget(enter.filter, typeInto(tick(typed, 5), 'x')), enter.expected);
});
