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
  const target: Workspace = { id: 'close-test', name: 'Close', kind: 'local', cwd: dir, claudeDir: config };
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
