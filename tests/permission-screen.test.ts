import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { focusedPermission, parsePermissionScreen, samePermission } from '../src/core/permission-screen';

// Frames captured from Claude Code 2.1.328 in an isolated profile with a loopback model.
const frame = (name: string) => readFileSync(new URL(`./fixtures/permission-2.1.328/${name}`, import.meta.url), 'utf8');

test('a Bash permission dialog: title, description, command, question and wrapped options', () => {
  const screen = parsePermissionScreen(frame('bash.txt'))!;
  assert.equal(screen.title, 'Bash command');
  assert.deepEqual(screen.subtitle, ['Write a greeting file']);
  assert.deepEqual(screen.content, ['echo hello > greeting.txt && ls']);
  assert.equal(screen.question, 'Do you want to proceed?');
  assert.deepEqual(screen.options.map(o => [o.number, o.focused]), [[1, true], [2, false], [3, false]]);
  assert.equal(screen.options[0].label, 'Yes');
  assert.match(screen.options[1].label, /^Yes, and always allow access to \/private\/var\/.+\/work from this project$/u, 'the wrapped row is one label');
  assert.equal(screen.options[2].label, 'No');
  assert.equal(screen.footer, 'Esc to cancel · Tab to amend');
  // Colours do not change the reading.
  assert.deepEqual(parsePermissionScreen(frame('bash.ansi')), screen);
});

test('file creation and edit dialogs keep the preview and diff lines as shown', () => {
  const write = parsePermissionScreen(frame('write.txt'))!;
  assert.equal(write.title, 'Create file');
  assert.deepEqual(write.subtitle, ['new.md']);
  assert.deepEqual(write.content.map(line => line.trimEnd()), [' 1 # New', ' 2', ' 3 fresh file']);
  assert.equal(write.question, 'Do you want to create new.md?');
  assert.match(write.options[1].label, /^Yes, and switch to accept edits .+ for this session \(shift\+tab\)$/u);
  const edit = parsePermissionScreen(frame('edit.txt'))!;
  assert.equal(edit.title, 'Edit file');
  assert.deepEqual(edit.subtitle, ['notes.txt']);
  assert.deepEqual(edit.content, ['1  alpha', '2 -beta', '2 +BETA', '3  gamma']);
  assert.equal(edit.question, 'Do you want to make this edit to notes.txt?');
});

test('moving the focus changes only the focused row and the footer', () => {
  const before = parsePermissionScreen(frame('write.txt'))!, after = parsePermissionScreen(frame('write-focus-2.txt'))!;
  assert.equal(focusedPermission(before), 0);
  assert.equal(focusedPermission(after), 1);
  assert.equal(after.footer, 'Esc to cancel');
  assert.ok(samePermission(before, after));
  assert.ok(!samePermission(before, parsePermissionScreen(frame('edit.txt'))!));
});

test('ordinary screens, answered dialogs and look-alikes are not permission dialogs', () => {
  for (const name of ['edit-rejected.txt', 'rm-interrupted.txt']) assert.equal(parsePermissionScreen(frame(name)), undefined, name);
  const bash = frame('bash.txt');
  // The dialog must be at the bottom, in place of the input box.
  assert.equal(parsePermissionScreen(bash + '\n' + '─'.repeat(80) + '\n❯ \n' + '─'.repeat(80) + '\n  ? for shortcuts\n'), undefined);
  // Exactly one focused row, numbered from 1.
  assert.equal(parsePermissionScreen(bash.replace(' ❯ 1. Yes', '   1. Yes')), undefined);
  assert.equal(parsePermissionScreen(bash.replace('   3. No', '   4. No')), undefined);
  // AskUserQuestion and the directory trust prompt have their own footers.
  assert.equal(parsePermissionScreen(bash.replace('Esc to cancel · Tab to amend', 'Enter to select · ↑/↓ to navigate · Esc to cancel')), undefined);
  assert.equal(parsePermissionScreen(bash.replace('Esc to cancel · Tab to amend', 'Enter to confirm · Esc to cancel')), undefined);
  // Without the question line it is not a decision.
  assert.equal(parsePermissionScreen(bash.replace(' Do you want to proceed?\n', '')), undefined);
});

test('Claude Code 2.1.329 asks before a dynamic workflow runs: the title is the question', () => {
  const screen = readFileSync(new URL('./fixtures/workflow-2.1.329/permission.txt', import.meta.url), 'utf8');
  const parsed = parsePermissionScreen(screen)!;
  assert.equal(parsed?.title, 'Run a dynamic workflow?');
  assert.equal(parsed.question, 'Run a dynamic workflow?');
  assert.deepEqual(parsed.subtitle, ['Map two folders']);
  assert.match(parsed.content.join('\n'), /^This dynamic workflow will spin up multiple subagents across the following phases:\n  1\. Map\n/u);
  assert.match(parsed.content.join('\n'), /disable dynamic workflows in \/config\.$/u);
  assert.deepEqual(parsed.options.map(o => [o.number, o.label, o.focused]), [[1, 'Yes, run it', true], [2, 'View raw script', false], [3, 'No', false]]);
  assert.equal(parsed.footer, 'Esc to cancel · Tab to amend · ctrl+g to edit script in $EDITOR');
  // The next option focused: the same dialog.
  const moved = parsePermissionScreen(screen.replace('  ❯ 1. Yes, run it', '    1. Yes, run it').replace('    2. View raw script', '  ❯ 2. View raw script'))!;
  assert.ok(samePermission(parsed, moved)); assert.equal(focusedPermission(moved), 1);
  // Without the title's question it is not a confirmation.
  assert.equal(parsePermissionScreen(screen.replace(' Run a dynamic workflow?', ' Run a dynamic workflow')), undefined);
});
