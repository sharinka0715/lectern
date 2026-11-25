import { fixtureClaudeConfig } from './helpers/claude-config';
import { isolateTmux } from './helpers/private-tmux';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Backend } from '../src/backend';
import { readRewind, turnComposer } from '../src/core/turn-controls';
import { nativeBranchFixture } from './helpers/native-branch-fixture';

// No user config, credentials, endpoint or real history. Exercise local-only
// slash commands in the installed CLI; all model traffic points at a closed port.
test('installed CLI: paged duplicate rewind, fork recovery and two independently writable panes', {
  // Windows runs no local sessions (SSH only) and has no tmux.
  skip: process.env.LECTERN_NATIVE_BRANCH_TEST !== '1' || process.platform === 'win32', timeout: 120_000,
}, async () => {
  const {root,cwd,dir,config,env: fixture,ws,originalId,prompts,ids} = await nativeBranchFixture();
  // User skills whose long CJK descriptions wrap in the slash completions offered for /fork
  // and /rewind (2.1.330), beside the native command Lectern has to recognize there.
  for (const [name,description] of [['fork-and-branch-guide','说明什么时候应该 fork 一个对话、什么时候应该新开对话，以及分支之后如何合并结论、如何避免重复劳动和上下文丢失。'],
    ['review-reminder','读取最近一次代码评审的记录，简要告诉用户还有哪些评审意见没有处理、哪些讨论还没有结论，以及合并之前需要先确认的地方。用户说“评审提醒”时使用。']]) {
    await mkdir(join(config,'skills',name),{recursive:true});
    await writeFile(join(config,'skills',name,'SKILL.md'),`---\nname: ${name}\ndescription: ${description}\n---\n\nSay hello.\n`);
  }
  const socket = 'lectern-branch-' + randomUUID().slice(0,8);
  fixtureClaudeConfig(config);
  const privateServer = isolateTmux(socket, fixture);
  const tmux = (...args: string[]) => privateServer.tmux('-f', '/dev/null', ...args).trim();
  const backend = new Backend({tmuxSocket:socket});
  const frame = (pane: string) => tmux('capture-pane','-p','-J','-t',pane);
  const wait = async (condition:()=>boolean | Promise<boolean>, label:string) => {
    const until=Date.now()+12000;
    do {if(await condition()) return; await new Promise(r=>setTimeout(r,100));} while(Date.now()<until);
    throw new Error(label);
  };
  try {
    tmux('new-session','-d','-s','fixture-owner','-c',cwd,'sleep','120');
    tmux('set-option','-g','focus-events','on');
    const original = await backend.resumeSession(ws,originalId);
    const pane = original.paneId!, pid = Number(tmux('display-message','-p','-t',pane,'#{pane_pid}'));
    await wait(async () => {const r=await backend.readSession(ws,originalId,true);return r.nativeStatus==='idle' && !!turnComposer(r.viewport ?? '')?.empty;}, 'native composer not ready');
    // A second legacy tagged foreground claiming this UUID makes the source
    // ambiguous, even when the first pane has a valid native registration.
    // Only lectern- sessions are probed; a duplicate among them must still block the fork.
    const duplicate = tmux('new-session','-d','-P','-F','#{pane_id}','-s','lectern-collision','-c',cwd,'bash','-c','exec -a claude sleep 100');
    tmux('set-option','-p','-t',duplicate,'@lectern_session_id',originalId);
    await assert.rejects(backend.forkSession(ws,originalId,pane,pid), /Multiple live/);
    tmux('kill-pane','-t',duplicate);
    // Simulate a disconnect after the native command was actually delivered.
    // A guard refusal answers with its one-use receipt instead and sent nothing
    // (e.g. Claude Code appended its auto mode notice just then): pass it on.
    const transport = (backend as any).transport, run = transport.run.bind(transport);
    let submissions = 0;
    const rewindBatches: string[] = [];
    // Claude Code rewrites its PID record (status, updatedAt) as it settles. Do the same,
    // once, right before the fork's retag and the first rewind key: either guard then
    // refuses without changing anything, and the step must read again and go on.
    const rewritten = new Set<string>(), registry = join(root, 'config', 'sessions');
    const rewriteRecords = () => { for (const f of readdirSync(registry).filter(f => f.endsWith('.json'))) {
      let record; try { record = JSON.parse(readFileSync(join(registry, f), 'utf8')); } catch { continue; } // mid-write: it changes anyway
      writeFileSync(join(registry, f + '.tmp'), JSON.stringify({ ...record, updatedAt: (record.updatedAt ?? 0) + 1 }));
      renameSync(join(registry, f + '.tmp'), join(registry, f));
    } };
    transport.run = async (...args: any[]) => {
      const point = args[2]?.tag === 'session.fork.rebind' ? 'rebind' : args[2]?.tag === 'settings.input_observe' && args[1].includes("'Up'") ? 'rewind' : '';
      if (point === 'rewind') rewindBatches.push(args[1]);
      if (point && !rewritten.has(point)) { rewritten.add(point); rewriteRecords(); }
      const result = await run(...args);
      if (args[2]?.tag !== 'session.branch.submit' || String(result.stdout).startsWith('LECTERN_MENU_KEY_NOT_SENT_')) return result;
      if (++submissions === 1) throw Error('lost branch acknowledgement');
      return result;
    };
    const first = backend.forkSession(ws,originalId,pane,pid);
    await assert.rejects(backend.forkSession(ws,originalId,pane,pid),/正在发送/);
    await assert.rejects(first,/lost branch acknowledgement/);
    assert.deepEqual(backend.pendingFork(ws,originalId),{paneId:pane,panePid:pid});
    const pair = await backend.forkSession(ws,originalId,pane,pid);
    assert.equal(pair.fork.paneId,pane); assert.notEqual(pair.original.paneId,pane); assert.equal(submissions,1);
    assert.equal(backend.pendingFork(ws,originalId),undefined);
    const again=await backend.forkSession(ws,originalId,pane,pid);
    assert.equal(again.fork.id,pair.fork.id); assert.equal(again.original.paneId,pair.original.paneId); assert.equal(submissions,1);
    // The fork's name is too wide for the input box's upper border: cut there with an ellipsis.
    const branchName = 'Branch-only ' + '分支回退测试'.repeat(12);
    for(const [s,name] of [[pair.original,'源会话 Source-only'],[pair.fork,branchName]] as const) {
      await wait(async()=>{const r=await backend.readSession(ws,s.id,true);return r.nativeStatus==='idle' && !!turnComposer(r.viewport ?? '')?.empty;},'pane not ready');
      await backend.sendMessage(ws,s.id,'/rename '+name,s.paneId);
      await wait(async()=>(await readFile(join(dir,s.id+'.jsonl'),'utf8')).includes(`"customTitle":"${name}"`),'separate rename did not persist');
    }
    assert.ok(!(await readFile(join(dir,originalId+'.jsonl'),'utf8')).includes('Branch-only'));
    // The border is repainted after the title reaches the JSONL (later on a slow machine).
    await wait(()=>/^ Branch-only 分支回退测试\S*… ─\s*$/mu.test(frame(pane)), 'the name is cut in the upper border, with no rule before it');
    await wait(async()=>(await readFile(join(dir,pair.fork.id+'.jsonl'),'utf8')).includes('This may indicate the session'), 'native rename metadata not flushed');
    const position = (await backend.readSession(ws,pair.fork.id,true)).transcriptPosition;
    await backend.turnAction(ws,pair.fork.id,pane,pid,{kind:'rewindTo',uuid:ids[1]}, {index:1,prompts}, undefined, position);
    const confirm=readRewind(frame(pane)); assert.equal(confirm?.message,'Repeated prompt');
    const directionLine = rewindBatches.at(-1)!.split('\n').filter(line => line.includes("'send-keys'"));
    assert.equal(directionLine.length, 1, 'one guarded command dispatches the move');
    assert.equal(directionLine[0].match(/'Up'/g)?.length, prompts.length - 1);
    assert.match(rewindBatches.at(-1)!, /sleep 0\.06\nlectern_frame\(\)/, 'the first capture waits for the buffered keys');
    assert.match(rewindBatches.at(-1)!, /lectern_frame\nsleep 0\.06 &/, 'captures are spaced on the target');
    const restored=await backend.turnAction(ws,pair.fork.id,pane,pid,{kind:'restore',signature:confirm!.signature},{index:1,prompts}, undefined, (await backend.readSession(ws,pair.fork.id,true)).transcriptPosition);
    assert.equal(restored?.restoredDraft,'Repeated prompt');
    assert.deepEqual([...rewritten].sort(), ['rebind','rewind'], 'both native record rewrites happened');
    const cut = frame(pane);
    assert.ok(cut.includes('Fixture answer 0') && !cut.includes('Fixture answer 12'), 'the earlier of the two identical prompts was selected');
    assert.ok(frame(pair.original.paneId!).includes('Fixture answer 14'));
    // A manual session change on the previous fork must not become a successful
    // retry, nor may it rebind that process to the old branch.
    tmux('send-keys','-t',pane,'C-u'); tmux('send-keys','-t',pane,'-l','/clear'); tmux('send-keys','-t',pane,'Enter');
    await wait(async()=>{ const p=(await backend.discover(ws)).panes.find(p=>p.id===pane); return !!p?.sessionId && p.sessionId!==pair.fork.id; },'native /clear did not change identity');
    await assert.rejects(backend.forkSession(ws,originalId,pane,pid),/已变化/);
    assert.equal(submissions,1);
  } finally {
    await backend.dispose();
    privateServer.cleanup();
    // Claude Code may still be flushing its config directory while tmux takes it down.
    await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
});
