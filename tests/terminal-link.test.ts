import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Backend } from '../src/backend';
import { linkLine } from '../src/backend/terminal-link';
import type { TerminalFrame, Workspace } from '../src/shared/types';

const exec = promisify(execFile);
const posix = { skip: process.platform === 'win32' ? 'tmux runs on POSIX hosts' : false, timeout: 30_000 };

test('each input is one validated stdin line', () => {
  assert.equal(linkLine({ type: 'key', key: 'Backspace' }), 'K BSpace\n');
  assert.equal(linkLine({ type: 'literal', text: 'a;' }), 'K -H 61 3b\n');
  assert.equal(linkLine({ type: 'literal', text: '中' }), 'K -H e4 b8 ad\n');
  assert.equal(linkLine({ type: 'text', text: "x'\n$y" }), `P ${Buffer.from("x'\n$y").toString('base64')}\n`);
});

test('the takeover link types at once, keeps every repeated key, pastes, and stops when the pane changes', posix, async t => {
  try { await exec('tmux', ['-V']); } catch { t.skip('tmux is unavailable'); return; }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lectern-link-')));
  const socket = 'lectern-link-' + randomUUID().slice(0, 8);
  const tmux = (...args: string[]) => exec('tmux', ['-L', socket, '-f', '/dev/null', ...args]).then(r => r.stdout.trim());
  const backend = new Backend({ tmuxSocket: socket });
  t.after(async () => { await tmux('kill-server').catch(() => {}); await backend.dispose(); await rm(root, { recursive: true, force: true }); });
  // A plain line editor stands in for Claude's input box.
  const pane = await tmux('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', 'lectern-link', '-x', '80', '-y', '12', '-c', root, 'sh', '-c', 'stty -echoctl; exec cat');
  const pid = Number(await tmux('display-message', '-p', '-t', pane, '#{pane_pid}'));
  const workspace: Workspace = { id: 'link', name: 'link', kind: 'local', cwd: root };
  const frames: TerminalFrame[] = [];
  let closed = '';
  const link = await backend.openTerminalLink(workspace, pane, pid, { onFrame: frame => frames.push(frame), onClosed: reason => { closed = reason; } });
  const screen = () => frames.at(-1)?.ansi.replace(/\x1b\[[\d;]*m/g, '') ?? '';
  const until = async (test: () => boolean, label: string) => {
    for (let i = 0; i < 100 && !test(); i++) await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(test(), label + ': ' + JSON.stringify(screen()));
  };
  const started = Date.now();
  for (const ch of 'hello world') link.send({ type: 'literal', text: ch });
  await until(() => screen().includes('hello world'), 'typed text appears');
  assert.ok(Date.now() - started < 1500, 'no per-key round trip');
  // A held Backspace: every repeat arrives, none is dropped or merged away.
  for (let i = 0; i < 6; i++) link.send({ type: 'key', key: 'Backspace' });
  await until(() => /hello\s*$/m.test(screen().split('\n')[0]) && !screen().includes('hello w'), 'six repeats delete six characters');
  link.send({ type: 'text', text: ' 粘贴 \'$HOME\'' });
  await until(() => screen().includes("hello 粘贴 '$HOME'"), 'paste is literal');
  assert.ok(frames.every((frame, i) => !i || frame.seq! > frames[i - 1].seq!), 'frames are ordered');
  // Replacing the process in the pane ends the link instead of typing into the new one.
  await tmux('respawn-pane', '-k', '-t', pane, 'sh', '-c', 'exec cat');
  link.send({ type: 'literal', text: 'x' });
  await until(() => closed === 'pane', 'a different process closes the link');
  assert.equal(link.closed, true);
  await assert.rejects(backend.openTerminalLink(workspace, pane, pid, { onFrame: () => {}, onClosed: () => {} }), /终端已变化/);
});
