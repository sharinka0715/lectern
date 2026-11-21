import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifySessionScreen, parseAutoModeNudge } from '../src/core/screen';
import { isIdleEmptyComposer } from '../src/core/settings-screen';
import { parseExecutionMode } from '../src/core/session-telemetry';
import { parsePermissionScreen, samePermission } from '../src/core/permission-screen';

// Sampled with scripts/cc-matrix/probe-startup.mjs (fresh config, loopback fake API).
const screen = (name: string) => readFileSync(new URL(`./fixtures/auto-mode/${name}.txt`, import.meta.url), 'utf8');
const moveFocus = (text: string) => text.replace(/❯ Yes, set/u, '  Yes, set').replace(/ {2}No, keep manual mode/u, '❯ No, keep manual mode');

test('"Make auto mode your default permission mode?" in both layouts, with its focus', () => {
  for (const name of ['nudge-2.1.300', 'nudge-2.1.330']) {
    const nudge = parseAutoModeNudge(screen(name));
    assert.equal(nudge?.focused, 'yes', name);
    const moved = parseAutoModeNudge(moveFocus(screen(name)));
    assert.equal(moved?.focused, 'no', name);
    assert.notEqual(moved?.signature, nudge?.signature);
    // A native dialog owns the keys: not an idle composer, the session waits.
    assert.equal(isIdleEmptyComposer(screen(name)), false, name);
    assert.equal(classifySessionScreen(screen(name)).status, 'waiting', name);
  }
});

test('the nudge parser rejects anything but the complete dialog at the bottom', () => {
  const text = screen('nudge-2.1.330');
  for (const changed of [
    text + '  3. Something else\n',
    text + '────\n❯ \n',
    text.replace(/^─+$/mu, ''),
    text.replace('blocks the rest.', 'blocks the rest, and approves account changes.'),
    text.replace('No, keep manual mode', 'No, keep manual mode forever'),
    text.replace('  ❯ Yes', '    Yes'),
    text.replace('    No, keep', '  ❯ No, keep'),
  ]) assert.equal(parseAutoModeNudge(changed), undefined, changed.slice(-200));
});

test('the startup notice "Auto mode is now Claude Code\'s default permission mode." does not block', () => {
  for (const name of ['default-notice-2.1.300', 'default-notice-2.1.330']) {
    const text = screen(name);
    assert.match(text, /Auto mode is now Claude Code's default permission mode\./);
    assert.equal(parseAutoModeNudge(text), undefined, name);
    assert.equal(isIdleEmptyComposer(text), true, name);
    assert.equal(classifySessionScreen(text).status, 'idle', name);
    assert.equal(parseExecutionMode(text)?.mode, 'auto', name);
  }
});

test('auto mode asking after blocked actions is a permission dialog with its quoted reason', () => {
  for (const [name, lead] of [['confirm-2.1.300', 'Auto mode classifier requires confirmation for this command.'], ['confirm-2.1.330', 'Auto mode needs your confirmation for this command.']]) {
    const text = screen(name);
    const dialog = parsePermissionScreen(text);
    assert.ok(dialog, name);
    assert.equal(dialog.title, 'Bash command');
    assert.deepEqual(dialog.subtitle, ['Print a long list 3']);
    assert.deepEqual(dialog.content, ["seq -w 1 1000 | sed 's/$/ ccm-history-line-2/'"]);
    assert.equal(dialog.notice?.length, 2, name);
    assert.equal(dialog.notice![0], `${lead} 3 consecutive actions were blocked. Please review the transcript before continuing.`);
    assert.match(dialog.notice![1], /^Latest blocked action: Auto mode could not evaluate this action and is blocking it for safety/);
    assert.equal(dialog.question, 'Do you want to proceed?');
    assert.deepEqual(dialog.options.map(o => [o.number, o.label, o.focused]), [[1, 'Yes', true], [2, 'No', false]]);
    assert.equal(classifySessionScreen(text).status, 'waiting', name);
    // Anything but a quoted note between the box and the question still rejects.
    assert.equal(parsePermissionScreen(text.replace(' │ Auto mode', ' Auto mode')), undefined, name);
    assert.equal(samePermission(dialog, parsePermissionScreen(text.replace('❯ 1. Yes', '  1. Yes').replace('  2. No', '❯ 2. No'))!), true);
  }
});
