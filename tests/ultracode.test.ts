import { fixtureClaudeConfig } from './helpers/claude-config';
import { isolateTmux } from './helpers/private-tmux';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend, runCommand } from '../src/backend';
import { ultracodeReceipt } from '../src/backend/native-settings';
import { animatedLabelGuard, animatedLabelText } from '../src/backend/composer-frame-guard';
import { execFileSync } from 'node:child_process';
import { isIdleEmptyComposer, observeUltracode, parseSettingScreen } from '../src/core/settings-screen';
import { classifySessionScreen } from '../src/core/screen';
import type { Workspace } from '../src/shared/types';

// Claude Code 2.1.328 captures from an isolated profile.
const frame = (name: string) => readFileSync(new URL(`./fixtures/ultracode-2.1.328/${name}.txt`, import.meta.url), 'utf8');

test('the effort slider reports its Ultracode control without turning it into an effort level', () => {
  for (const [name, expected, focus] of [['on-menu', 'on', 'high'], ['flag-menu', 'off', 'medium'], ['on-menu-toggled', 'off', 'high'], ['disabled-menu', undefined, 'medium']] as const) {
    const menu = parseSettingScreen(frame(name), 'effort');
    assert.equal(menu.state, 'menu', name);
    if (menu.state !== 'menu') continue;
    assert.deepEqual(menu.options.map(option => option.label), ['low', 'medium', 'high', 'xhigh', 'max'], name);
    assert.equal(menu.options.find(option => option.focused)?.label, focus, name);
    assert.equal(menu.ultracode, expected, name);
  }
  // Toggling inside the native menu removes its session-only key; Lectern never presses Tab.
  const toggled = parseSettingScreen(frame('on-menu-toggled'), 'effort');
  assert.equal(toggled.state === 'menu' && toggled.sessionOnlyKey, undefined);
});

test('the composer border shows Ultracode; a session title hides it; idle and status detection are unchanged', () => {
  assert.equal(observeUltracode(frame('on-idle')), true);
  assert.equal(observeUltracode(frame('on-after-high')), true);
  assert.equal(observeUltracode(frame('flag-idle')), true);
  assert.equal(observeUltracode(frame('on-draft')), true, 'a draft keeps the border');
  assert.equal(observeUltracode(frame('on-off-idle')), false);
  assert.equal(observeUltracode(frame('disabled-refused')), false);
  assert.equal(observeUltracode(frame('named-idle')), undefined, 'a named session shows its title instead');
  assert.equal(observeUltracode(frame('on-menu')), undefined, 'no composer while the menu is open');
  for (const name of ['on-idle', 'on-after-high', 'flag-idle', 'named-idle', 'on-off-idle']) {
    assert.equal(isIdleEmptyComposer(frame(name)), true, name);
    assert.equal(classifySessionScreen(frame(name)).status, 'idle', name);
  }
});

test('Ultracode receipts: on, off, workflows off and unsupported model', () => {
  assert.equal(ultracodeReceipt(true, 'Ultracode on (this session only): dynamic workflows on every task. Effort stays medium.'), true);
  assert.equal(ultracodeReceipt(false, 'Ultracode off. Effort stays medium.'), false);
  assert.throws(() => ultracodeReceipt(true, 'Ultracode needs dynamic workflows turned on (see /config). Options: low, medium, high, xhigh, max, auto'), /没有开启动态工作流/);
  assert.throws(() => ultracodeReceipt(true, "Ultracode isn't available on Haiku 5.5. Options: low, medium, high, auto"), /Haiku 5\.5 不支持/);
  assert.throws(() => ultracodeReceipt(true, 'Ultracode off. Effort stays medium.'), /未确认/);
});

test('Lectern-launched sessions turn on dynamic workflows unless the user opted out', { skip: process.platform === 'win32', timeout: 30_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lectern-workflows-')));
  const workspace: Workspace = { id: randomUUID(), name: 'fixture', kind: 'local', cwd: root };
  fixtureClaudeConfig(join(root, 'config'));
  const socket = 'workflows-' + randomUUID().slice(0, 8), exe = join(root, 'claude'), fixture = join(root, 'fixture.mjs');
  const privateServer = isolateTmux(socket);
  const backend = new Backend({ claudeCommand: exe, tmuxSocket: socket, claudeArgs: [fixture] });
  try {
    try { await runCommand(workspace, 'command -v tmux'); } catch { t.skip('tmux unavailable'); return; }
    await mkdir(join(root, 'config'));
    await symlink(process.execPath, exe);
    await writeFile(fixture, `import fs from 'node:fs';
      const args = process.argv.slice(2);
      fs.writeFileSync(${JSON.stringify(root)} + '/' + args.at(-1) + '.json', args[args.indexOf('--settings') + 1]);
      process.stdin.setRawMode(true); process.stdin.resume();`);
    const launched = async () => {
      const session = await backend.createSession(workspace);
      for (let i = 0; i < 100; i++) {
        const settings = await readFile(join(root, session.id + '.json'), 'utf8').catch(() => '');
        if (settings) return JSON.parse(settings);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.fail('fixture did not start');
    };
    const first = await launched();
    assert.equal(first.enableWorkflows, true);
    assert.equal('promptSuggestionEnabled' in first, false, 'prompt suggestions follow native settings');
    assert.equal('env' in first, false, 'auto mode\'s check is left to Claude Code (no CLAUDE_CODE_AUTO_MODE_SERVER)');
    assert.deepEqual(first.permissions, { defaultMode: 'auto' }, 'Lectern-launched sessions start in auto mode');
    backend.setLaunchPreferences({ enableWorkflows: false });
    assert.equal('enableWorkflows' in await launched(), false, 'opting out leaves the user setting in charge');
  } finally {
    await backend.dispose();
    privateServer.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test('the animated Ultracode border label does not change the input guard digest; its text and other rows still do', { skip: process.platform === 'win32' }, () => {
  const styled = readFileSync(new URL('./fixtures/ultracode-2.1.328/on-idle.ansi', import.meta.url), 'utf8');
  // Claude moves a bold/colour highlight across the label between frames.
  const label = styled.lastIndexOf('ultracode'), relabel = (text: string) => styled.slice(0, label) + text + styled.slice(label + 'ultracode'.length);
  const shimmer = relabel('\x1b[38;5;147multrac\x1b[1mo\x1b[38;5;189md\x1b[38;5;147me\x1b[0m');
  assert.notEqual(shimmer, styled);
  assert.equal(animatedLabelText(shimmer), animatedLabelText(styled));
  const guard = animatedLabelGuard(styled);
  assert.ok(guard.filter, 'a filter is applied on the target');
  const onTarget = (frame: string) => execFileSync('/bin/sh', ['-c', `cat${guard.filter}`], { input: frame }).toString();
  assert.equal(onTarget(shimmer), guard.viewport, 'the target computes the same normalized frame');
  assert.equal(onTarget(styled), guard.viewport);
  assert.notEqual(onTarget(relabel('ultracodx')), guard.viewport, 'the label text is still guarded');
  assert.notEqual(onTarget(styled.replace('/effort ultracode on', '/effort ultracode of')), guard.viewport, 'other rows are still guarded');
  assert.ok(guard.viewport.includes('\x1b[38;5;220m⏵⏵ auto mode on'), 'styling elsewhere is kept');
  const plain = frame('named-idle');
  assert.deepEqual(animatedLabelGuard(plain), { viewport: plain, filter: '' }, 'unstyled frames are unchanged');
});

test('the effort slider keeps guarding its track and pointer while "Ultracode on" shimmers', { skip: process.platform === 'win32' }, () => {
  // Rows captured 70 ms apart from Claude Code 2.1.328 (tmux capture-pane -e).
  const track = '                             \x1b[38;5;246m──────────\x1b[1m\x1b[39m▲\x1b[0m\x1b[38;5;246m───────────────────────────────\x1b[39m      ';
  const first = track + '\x1b[1m\x1b[38;5;147mUltracode  on\x1b[0m                            ';
  const later = track + '\x1b[1m\x1b[38;5;147mU\x1b[38;5;189ml\x1b[38;5;147mtracode  on\x1b[0m                            ';
  const frame = (row: string) => `  Effort\n${row}\n  low     medium     high     xhigh      max      Tab to toggle\n`;
  const guard = animatedLabelGuard(frame(first));
  const onTarget = (viewport: string) => execFileSync('/bin/sh', ['-c', `cat${guard.filter}`], { input: viewport }).toString();
  assert.equal(animatedLabelText(frame(later)), guard.viewport);
  assert.equal(onTarget(frame(later)), guard.viewport, 'BSD/GNU awk agree with the local normalization');
  const moved = first.replace('──────────\x1b[1m\x1b[39m▲', '───────────\x1b[1m\x1b[39m▲').replace('───────────────────────────────\x1b', '──────────────────────────────\x1b');
  assert.notEqual(onTarget(frame(moved)), guard.viewport, 'a moved pointer still changes the digest');
  assert.notEqual(onTarget(frame(first.replace('Ultracode  on', 'Ultracode off'))), guard.viewport, 'the toggle state is still guarded');
  assert.ok(guard.viewport.includes('\x1b[1m\x1b[39m▲'), 'the pointer keeps its styling');
});
