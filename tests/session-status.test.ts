import { fixtureClaudeConfig } from './helpers/claude-config';
import { isolateTmux } from './helpers/private-tmux';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Backend, quoteShell, runCommand } from '../src/backend';
import { paneNavigationStatus } from '../src/backend/session-status';
import type { Workspace } from '../src/shared/types';

const local: Workspace = { id: 'status-test', name: 'Status test', kind: 'local', cwd: '/tmp' };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Read until the fixture's screen change is visible (under load tmux may take longer than a frame or two). */
async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout = 8000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (accept(value) || Date.now() > end) return value;
    await pause(50);
  }
}

test('navigation distinguishes inactive history, explicit abnormal exits, and unobserved live panes', () => {
  assert.equal(paneNavigationStatus(undefined).status, 'history');
  assert.equal(paneNavigationStatus({ id: '%0', active: false, dead: true, deadStatus: 0 }).status, 'history');
  assert.equal(paneNavigationStatus({ id: '%0', active: false, dead: true, deadStatus: 17 }).status, 'error');
  assert.equal(paneNavigationStatus({ id: '%0', active: false, dead: true, deadSignal: '15' }).status, 'error');
  assert.equal(paneNavigationStatus({ id: '%0', active: true, dead: false }).status, 'unknown');
  assert.equal(paneNavigationStatus({ id: '%0', active: true, dead: false }, { error: 'Capture failed' }).status, 'unknown');
  assert.equal(paneNavigationStatus({ id: '%0', active: false, dead: false }, { screen: '❯\n? for shortcuts\n' }).status, 'unknown');
});

test('navigation viewport reads are batched and bounded; unreadable panes never become gray history', async () => {
  const backend = new Backend();
  const batches: number[] = [];
  (backend as any).transport.run = async (_workspace: Workspace, script: string, options: { maxBytes: number; tag: string }) => {
    assert.equal(options.tag, 'tmux.navigation_status');
    assert.ok(options.maxBytes <= 16 * 23000);
    assert.equal(script.includes("'-S'"), false, 'navigation reads viewport rather than history');
    const marker = '\n' + /__LECTERN_VIEWPORT_[a-f0-9-]+__:/.exec(script)![0];
    const ids = [...script.matchAll(/'-t' '(%\d+)'/g)].map(match => match[1]);
    batches.push(ids.length);
    return { stdout: Buffer.from(ids.flatMap(id => [id, Buffer.from('❯\n' + marker + '0').toString('base64')]).join('\0') + '\0'), stderr: '' };
  };
  const panes = Array.from({ length: 70 }, (_, index) => ({ id: `%${index}`, dead: false, active: true }));
  const observed: Map<string, { screen?: string; error?: string }> = await (backend as any).navigationViewports(local, panes);
  assert.deepEqual(batches, [16, 16, 16, 16]);
  assert.equal(observed.size, 70);
  assert.equal(observed.get('%0')?.screen, '❯\n');
  assert.match(observed.get('%69')?.error ?? '', /64/);
  (backend as any).transport.run = async () => { throw new Error('Connection lost'); };
  const failed: Map<string, { error?: string }> = await (backend as any).navigationViewports(local, panes.slice(0, 1));
  assert.match(failed.get('%0')?.error ?? '', /读取失败/);
  await backend.dispose();
});

test('real tmux discovery observes independent idle/working/waiting states and retained abnormal exits', { timeout: 30_000, skip: process.platform === 'win32' ? 'POSIX tmux fixture' : false }, async t => {
  try { await runCommand(local, 'command -v tmux'); } catch { t.skip('tmux is not installed'); return; }
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lectern-status-')));
  const cwd = path.join(root, 'project'), config = path.join(root, 'config');
  await mkdir(cwd); await mkdir(config);
  const script = path.join(root, 'status-fixture.mjs');
  await writeFile(script, `import fs from 'node:fs'; import path from 'node:path';
const root=process.argv[2],id=process.argv.at(-1),project=path.join(process.env.CLAUDE_CONFIG_DIR,'projects',process.cwd().replace(/[^A-Za-z0-9]/g,'-'));
fs.mkdirSync(project,{recursive:true});fs.writeFileSync(path.join(project,id+'.jsonl'),JSON.stringify({type:'user',uuid:id,cwd:process.cwd(),message:{role:'user',content:'Fixture'}})+'\\n');
process.stdin.setRawMode(true);process.stdin.resume();let previous='';
setInterval(()=>{const end=path.join(root,id+'.exit');if(fs.existsSync(end))process.exit(Number(fs.readFileSync(end,'utf8')));const file=path.join(root,id+'.screen'),screen=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'❯\\n? for shortcuts\\n';if(screen!==previous){previous=screen;process.stdout.write('\\x1b[2J\\x1b[H'+screen.replace(/\\n/g,'\\r\\n'));}},25);
`);
  const socket = `lectern-status-${randomUUID().slice(0, 8)}`;
  const privateServer = isolateTmux(socket);
  const workspace: Workspace = { ...local, id: randomUUID(), cwd };
  fixtureClaudeConfig(config);
  const backend = new Backend({ tmuxSocket: socket, claudeCommand: process.execPath, claudeArgs: [script, root] });
  const tmux = async (...args: string[]) => runCommand(workspace, ['tmux', ...privateServer.args(...args)].map(quoteShell).join(' '));
  try {
    const idle = await backend.createSession(workspace), working = await backend.createSession(workspace), waiting = await backend.createSession(workspace);
    await writeFile(path.join(root, working.id + '.screen'), '✻ Thinking… (esc to interrupt)\n');
    await writeFile(path.join(root, waiting.id + '.screen'), 'Do you want to proceed?\n❯ 1. Yes\n2. No\n');
    const statusIn = (found: Awaited<ReturnType<typeof backend.discover>>, id: string) => found.sessions.find(s => s.id === id)?.status;
    let discovery = await eventually(() => backend.discover(workspace),
      found => statusIn(found, idle.id) === 'idle' && statusIn(found, working.id) === 'working' && statusIn(found, waiting.id) === 'waiting');
    assert.equal(discovery.sessions.find(s => s.id === idle.id)?.status, 'idle');
    assert.equal(discovery.sessions.find(s => s.id === working.id)?.status, 'working');
    assert.equal(discovery.sessions.find(s => s.id === waiting.id)?.status, 'waiting');
    await writeFile(path.join(root, working.id + '.screen'), 'Future terminal layout without known status markers\n');
    const freshRead = await eventually(() => backend.readSession(workspace, working.id), read => read.session.status === 'unknown');
    assert.equal(freshRead.session.status, 'unknown', 'selected reads update cached navigation state without a directory rescan');
    assert.match(freshRead.screen, /Thinking/, 'preview scrollback remains available');
    assert.equal(freshRead.viewport?.includes('Thinking'), false, 'status viewport excludes the previous spinner in scrollback');
    assert.equal((await backend.discover(workspace)).sessions.find(s => s.id === working.id)?.status, 'unknown');
    await writeFile(path.join(root, working.id + '.screen'), 'API Error: 401 invalid authentication\n');
    assert.equal((await eventually(() => backend.readSession(workspace, working.id), read => read.session.status === 'error')).session.status, 'error');
    assert.equal((await backend.discover(workspace)).sessions.find(s => s.id === working.id)?.status, 'error', 'a current explicit native API error is visible before JSONL changes');

    await tmux('set-option', '-p', '-t', idle.paneId!, 'remain-on-exit', 'on');
    await writeFile(path.join(root, idle.id + '.exit'), '17');
    await tmux('set-option', '-p', '-t', waiting.paneId!, 'remain-on-exit', 'on');
    await writeFile(path.join(root, waiting.id + '.exit'), '0');
    // Wait until both panes are dead and tmux knows how they exited. tmux 3.2a sometimes
    // marks a pane dead on the closed terminal before it reaps the process and then never
    // records the exit status: without that evidence the pane reads as ordinary history.
    const exit = (pane: string) => tmux('display-message', '-p', '-t', pane, '#{pane_dead}:#{pane_dead_status}').then(result => result.stdout.toString().trim(), () => '');
    const [idleExit, waitingExit] = await eventually(async () => [await exit(idle.paneId!), await exit(waiting.paneId!)],
      ([a, b]) => a === '1:17' && b.startsWith('1:'), 3000);
    assert.ok(idleExit.startsWith('1:') && waitingExit.startsWith('1:'), `both fixture panes exited (${idleExit}, ${waitingExit})`);
    const recorded = idleExit === '1:17';
    if (!recorded) t.diagnostic('tmux did not record the exit status of the dead pane; checking the no-evidence path');
    assert.equal((await backend.readSession(workspace, idle.id)).session.status, recorded ? 'error' : 'history', 'selected read retains abnormal dead-pane evidence');
    assert.equal((await backend.readSession(workspace, waiting.id)).session.status, 'history');
    discovery = await backend.discover(workspace);
    assert.equal(discovery.sessions.find(s => s.id === idle.id)?.status, recorded ? 'error' : 'history');
    if (recorded) assert.match(discovery.sessions.find(s => s.id === idle.id)?.statusDetail ?? '', /17/);
    assert.equal(discovery.sessions.find(s => s.id === waiting.id)?.status, 'history');
    assert.equal(discovery.sessions.find(s => s.id === idle.id)?.paneId, undefined);

    await tmux('respawn-pane', '-k', '-t', working.paneId!, '/bin/sh');
    assert.equal((await eventually(() => backend.readSession(workspace, working.id), read => read.session.status === 'unknown')).session.status, 'unknown', 'selected read does not paint a surviving shell as ordinary history');
    discovery = await backend.discover(workspace);
    assert.equal(discovery.sessions.find(s => s.id === working.id)?.status, 'unknown', 'a surviving shell is not a live Claude session');
    assert.equal(discovery.sessions.find(s => s.id === working.id)?.paneId, undefined);
    // Status reads never mutate or append transcript contents.
    assert.equal((await readFile(discovery.sessions.find(s => s.id === idle.id)!.path!, 'utf8')).trim().split('\n').length, 1);
  } finally {
    await backend.dispose();
    privateServer.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
