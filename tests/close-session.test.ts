import { fixtureClaudeConfig } from './helpers/claude-config';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Backend, quoteShell, runCommand } from '../src/backend';
import type { Workspace } from '../src/shared/types';

test('close validates current pane and PID, drains final writes, leaves siblings live and the original UUID resumable', { skip: process.platform === 'win32', timeout: 30_000 }, async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'lectern-close-')));
  const config = join(dir, 'config');
  const target: Workspace = { id: 'close-test', name: 'Close', kind: 'local', cwd: dir };
  fixtureClaudeConfig(config);
  const script = join(dir, 'cli.mjs');
  const socket = 'close-' + randomUUID().slice(0, 8);
  const backend = new Backend({ tmuxSocket: socket, claudeCommand: process.execPath, claudeArgs: [script] });
  const tmux = (...args: string[]) => runCommand(target, ['tmux', '-L', socket, ...args].map(quoteShell).join(' '));
  try {
    try { await runCommand(target, 'command -v tmux'); } catch { t.skip('tmux unavailable'); return; }
    await mkdir(config);
    await writeFile(script, `import fs from 'node:fs';import path from 'node:path';
const dir=path.join(process.env.CLAUDE_CONFIG_DIR,'projects',process.cwd().replace(/[^A-Za-z0-9]/g,'-'));
fs.mkdirSync(dir,{recursive:true});const id=process.argv.at(-1),file=path.join(dir,id+'.jsonl');
if (!fs.existsSync(file)) fs.writeFileSync(file,JSON.stringify({type:'user',sessionId:id,cwd:process.cwd(),uuid:'question',message:{content:'keep this'}})+'\\n');
process.on('SIGTERM',()=>{fs.appendFileSync(file,JSON.stringify({type:'system',subtype:'close-drained'})+'\\n');process.exit(0)});
console.log('fixture-ready');setInterval(()=>{},10000);`);
    const session = await backend.createSession(target);
    const sibling = (await tmux('split-window', '-d', '-P', '-F', '#{pane_id}', '-t', session.paneId!, 'sleep 60')).stdout.toString().trim();
    let seen = await backend.readSession(target, session.id);
    for (let n = 0; !seen.screen.includes('fixture-ready') && n < 20; n++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      seen = await backend.readSession(target, session.id);
    }
    assert.ok(seen.screen.includes('fixture-ready'));
    await assert.rejects(backend.closeSession(target, session.id, sibling, seen.panePid!), /变化/);
    await assert.rejects(backend.closeSession(target, session.id, session.paneId!, seen.panePid! + 1), /变化/);
    await tmux('set-option', '-p', '-t', session.paneId!, 'remain-on-exit', 'on');
    const closed = await backend.closeSession(target, session.id, session.paneId!, seen.panePid!);
    assert.equal(closed?.status, 'history');
    assert.equal(closed?.paneId, undefined);
    assert.match((await backend.readSession(target, session.id)).jsonl.toString(), /close-drained/);
    assert.equal((await tmux('list-panes', '-a', '-F', '#{pane_id}')).stdout.toString().trim(), sibling);
    const resumed = await backend.resumeSession(target, session.id);
    assert.ok(resumed.paneId && resumed.paneId !== session.paneId);
    assert.equal(resumed.id, session.id);
  } finally {
    await tmux('kill-server').catch(() => {});
    await backend.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test('quitting: running sessions with pane PIDs, what discovery knew, and closing a listed conversation after checking it again', { skip: process.platform === 'win32', timeout: 40_000 }, async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'lectern-quit-')));
  const config = join(dir, 'config');
  const target: Workspace = { id: 'quit-test', name: 'Quit', kind: 'local', cwd: dir };
  fixtureClaudeConfig(config);
  const missing: Workspace = { id: 'quit-missing', name: 'Gone', kind: 'local', cwd: join(dir, 'missing') };
  const script = join(dir, 'cli.mjs');
  const socket = 'quit-' + randomUUID().slice(0, 8);
  const backend = new Backend({ tmuxSocket: socket, claudeCommand: process.execPath, claudeArgs: [script] });
  const tmux = (...args: string[]) => runCommand(target, ['tmux', '-L', socket, ...args].map(quoteShell).join(' '));
  try {
    try { await runCommand(target, 'command -v tmux'); } catch { t.skip('tmux unavailable'); return; }
    await mkdir(config);
    await writeFile(script, `import fs from 'node:fs';import path from 'node:path';
const dir=path.join(process.env.CLAUDE_CONFIG_DIR,'projects',process.cwd().replace(/[^A-Za-z0-9]/g,'-'));
fs.mkdirSync(dir,{recursive:true});const id=process.argv.at(-1),file=path.join(dir,id+'.jsonl');
if (!fs.existsSync(file)) fs.writeFileSync(file,JSON.stringify({type:'user',sessionId:id,cwd:process.cwd(),uuid:'q-'+id,message:{content:'task '+id}})+'\\n');
process.on('SIGTERM',()=>process.exit(0));console.log('fixture-ready');setInterval(()=>{},10000);`);
    const first = await backend.createSession(target), second = await backend.createSession(target);
    const running = async () => (await backend.runningSessions(target)).sort((a, b) => a.paneId.localeCompare(b.paneId));
    let found = await running();
    for (let n = 0; found.length < 2 && n < 40; n++) { await new Promise(resolve => setTimeout(resolve, 50)); found = await running(); }
    assert.deepEqual(found.map(item => [item.id, item.paneId]), [[first.id, first.paneId], [second.id, second.paneId]].sort((a, b) => a[1]!.localeCompare(b[1]!)));
    const pids = Object.fromEntries((await tmux('list-panes', '-a', '-F', '#{pane_id} #{pane_pid}')).stdout.toString().trim().split('\n').map(line => line.split(' ')));
    for (const item of found) assert.equal(item.panePid, Number(pids[item.paneId]));
    // What the last discovery saw, without asking the machine; failures are remembered too.
    await backend.discover(target);
    const known = backend.knownRunning(target.id);
    assert.deepEqual(known.sessions.map(item => item.paneId).sort(), found.map(item => item.paneId).sort());
    assert.ok(known.okAt && !known.failedAt);
    await assert.rejects(backend.discover(missing));
    assert.ok(backend.knownRunning(missing.id).failedAt && backend.knownRunning(missing.id).error);
    // Checked again before closing: a changed PID refuses, the right one closes only that pane.
    const one = found[0], other = found[1];
    await assert.rejects(backend.closeListed(target, one.id, one.paneId, one.panePid + 1), /变化/);
    await assert.rejects(backend.closeListed(target, one.id, other.paneId, other.panePid), /变化/);
    await backend.closeListed(target, one.id, one.paneId, one.panePid);
    assert.deepEqual((await running()).map(item => item.id), [other.id]);
    // Already gone counts as closed.
    await backend.closeListed(target, one.id, one.paneId, one.panePid);
    await backend.closeListed(target, other.id, other.paneId);
    assert.deepEqual(await running(), []);
  } finally {
    await tmux('kill-server').catch(() => {});
    await backend.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
