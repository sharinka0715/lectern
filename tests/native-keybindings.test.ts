import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transport } from '../src/backend/transport';
import { NativeKeybindings, parseNativeKeybindings } from '../src/backend/native-keybindings';

function defaultNativeKey(raw: string, key: string, contexts: Parameters<NonNullable<ReturnType<typeof parseNativeKeybindings>>>[1]) {
  return parseNativeKeybindings(raw)?.(key, contexts) ?? false;
}

test('an unrelated custom shortcut has no effect on native model and confirmation actions', () => {
  const bindings = JSON.stringify({ bindings: [
    { context: 'Chat', bindings: { s: 'other' } },
    { context: 'ModelPicker', bindings: { right: 'other', s: 'modelPicker:thisSessionOnly' } },
  ] });
  assert.equal(defaultNativeKey(bindings, 's', ['ModelPicker', 'Select']), true);
  assert.equal(defaultNativeKey(bindings, 'Enter', ['Confirmation', 'Select']), true);
  assert.equal(defaultNativeKey('{ // custom keys\n "bindings": [ { "context": "Chat", "bindings": { "x": "abc//def", }, }, ], }', 's', ['ModelPicker']), true);
});

test('Shift+Tab leaves auto mode in a confirmation only while it is still confirm:cycleMode', () => {
  const contexts = ['Question', 'Select', 'Confirmation', 'Tabs', 'TextInput'] as const;
  assert.equal(defaultNativeKey('{"bindings":[]}', 'shift+tab', [...contexts]), true);
  assert.equal(defaultNativeKey('{"bindings":[{"context":"Chat","bindings":{"shift+tab":"chat:cycleMode"}}]}', 'shift+tab', [...contexts]), true);
  for (const custom of [{ 'shift+tab': 'confirm:yes' }, { 'shift+tab': null }, { 'meta+m': 'confirm:cycleMode' }]) {
    assert.equal(defaultNativeKey(JSON.stringify({ bindings: [{ context: 'Confirmation', bindings: custom }] }), 'shift+tab', [...contexts]), false, JSON.stringify(custom));
  }
});

test('reassigned, unbound, prefixed and ambiguous model keys have to be handled in the terminal', () => {
  for (const custom of [{ s: 'select:accept' }, { s: null }, { 's x': 'other' }, { n: 'modelPicker:thisSessionOnly' }]) {
    const bindings = JSON.stringify({ bindings: [{ context: 'ModelPicker', bindings: custom }] });
    assert.equal(defaultNativeKey(bindings, 's', ['ModelPicker', 'Select']), false);
    assert.equal(defaultNativeKey(bindings, 'Escape', ['ModelPicker', 'Select']), true);
  }
  assert.equal(defaultNativeKey('invalid', 's', ['ModelPicker']), false);
  assert.equal(defaultNativeKey('{"bindings":[{"context":"Global","bindings":{"esc":"another"}}]}', 'Escape', ['Select']), false);
});

test('one bounded read serves multiple menu keys and detects file creation, edits and links before dispatch', { skip: process.platform === 'win32' ? 'POSIX shell target; Windows runs no local commands' : false }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'lectern-keybindings-'));
  const workspace = { id: 'keymap', name: 'fixture', cwd, kind: 'local' as const };
  const path = join(cwd, 'keybindings.json'), transport = new Transport();
  let reads = 0;
  const run = transport.run.bind(transport);
  transport.run = (...args) => {
    if (args[2]?.tag === 'settings.keybindings') reads++;
    return run(...args);
  };
  try {
    const defaults = new NativeKeybindings(transport, workspace);
    const empty = await defaults.guard(cwd, 'Enter', ['Chat']);
    await defaults.guard(cwd, 's', ['ModelPicker', 'Select']);
    await run(workspace, empty + 'true');
    assert.equal(reads, 1);
    await writeFile(path, '{"bindings":[{"context":"Chat","bindings":{"x":"custom"}}]}');
    await assert.rejects(run(workspace, empty + 'true'), /键位配置已变化/);
    const existing = new NativeKeybindings(transport, workspace);
    const guard = await existing.guard(cwd, 's', ['ModelPicker', 'Select']);
    await run(workspace, guard + 'true');
    await writeFile(path, '{"bindings":[{"context":"ModelPicker","bindings":{"s":null}}]}');
    await assert.rejects(run(workspace, guard + 'true'), /键位配置已变化/);
    await assert.rejects(new NativeKeybindings(transport, workspace).guard(cwd, 's', ['ModelPicker']), /原生键位/);
    await rm(path);
    await symlink('unreadable-target', path);
    await assert.rejects(new NativeKeybindings(transport, workspace).guard(cwd, 's', ['ModelPicker']), /原生键位/);
  } finally {
    await transport.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('model page navigation uses only the unmodified native Select bindings', () => {
  for (const [key, action] of [['home', 'select:first'], ['end', 'select:last'], ['pageup', 'select:pageUp'], ['pagedown', 'select:pageDown']]) {
    const permits = (context: string, bindings: unknown) => defaultNativeKey(JSON.stringify({ bindings: [{ context, bindings }] }), key, ['ModelPicker', 'Select']);
    assert.equal(permits('Select', { [key]: action }), true);
    assert.equal(permits('Select', { x: action }), false);
    assert.equal(permits('Global', { [key]: 'chat:submit' }), false);
    assert.equal(permits('ModelPicker', { [key]: 'modelPicker:thisSessionOnly' }), false);
  }
});
