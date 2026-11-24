// node --import tsx scripts/native-split-conversations.mjs [packaged-executable]
import { createPrivateTmux } from './fixtures/private-tmux.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron } from './fixtures/electron.mjs';
import { Backend, projectSlug } from '../src/backend/index.ts';

const exec = promisify(execFile);
// A full model ID the operator's Claude Code can use (LECTERN_NATIVE_MODEL); the report checks replies came from it.
const model = process.env.LECTERN_NATIVE_MODEL || 'claude-sonnet-5-5';
const out = path.resolve('test-results', 'native-split-' + Date.now());
const cwd = path.join(out,'project'), profile = path.join(out,'profile');
await Promise.all([mkdir(cwd,{recursive:true,mode:0o700}),mkdir(profile,{recursive:true,mode:0o700})]);
const socket = await realpath(await mkdtemp('/tmp/lectern-split-'));
const config = await realpath(await mkdtemp(path.join(tmpdir(),'lectern-split-config-')));
const workspace = { id:'split-fixture', name:'Split fixture', kind:'local', cwd };
await writeFile(path.join(profile,'workspaces.json'),JSON.stringify([workspace]));
const sourceDir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(),'.claude');
const privateServer = createPrivateTmux(socket);
const env = {...privateServer.env, CLAUDE_CONFIG_DIR:config, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA:profile,LECTERN_LOG_DIR:path.join(out,'diagnostics'),LECTERN_DIAGNOSTIC_CONTENT:'0'};
delete env.ELECTRON_RUN_AS_NODE;
delete env.LECTERN_DEV_URL;
process.env.TMUX_TMPDIR=socket;
process.env.CLAUDE_CONFIG_DIR=config;
delete process.env.TMUX;
delete process.env.TMUX_PANE;
const backend = new Backend({claudeArgs:['--model',model,'--permission-mode','manual']});
const report = {success:false,version:(await exec('claude',['--version'])).stdout.trim(),model,sessions:[],rendererErrors:[]};
let app,page;
try {
  // The interactive CLI reads the operator's existing native model route.
  // This harness never opens the routing settings or serializes their env.
  await symlink(path.join(sourceDir,'settings.json'), path.join(config,'settings.json'));
  await writeFile(path.join(config,'.claude.json'),JSON.stringify({
    hasCompletedOnboarding:true, hasResetAutoModeOptInForDefaultOffer:true, projects:{},
  }),{mode:0o600});
  // Starting the two original native sessions in sequence also covers recovery
  // of already-running sessions when the Electron window launches.
  const left = await backend.createSession(workspace);
  const right = await backend.createSession(workspace);
  assert.notEqual(left.paneId,right.paneId);
  report.sessions = [left,right].map(({id,paneId})=>({id,paneId}));
  const executablePath=process.argv[2] && path.resolve(process.argv[2]);
  app=await _electron.launch({env,args:executablePath?[]:['.'],...(executablePath&&{executablePath}),timeout:60000});
  page=await app.firstWindow();
  page.setDefaultTimeout(45000);
  page.on('pageerror',e=>report.rendererErrors.push(String(e)));
  await page.waitForFunction(()=>!!window.desktop);
  await page.evaluate(()=>{window.__splitObservations={};window.desktop.onSnapshot(s=>{window.__splitObservations[s.sessionId]=s;});});
  const pane = view => page.locator('.desk-pane[data-view="'+view+'"]');
  const leftPane=pane('primary'), rightPane=pane('secondary');
  const row=s=>page.locator('.session-row[data-session-id="'+s.id+'"]');
  await row(left).click();
  async function prepare(container,session) {
    await page.waitForFunction(id => {
      const s=window.__splitObservations[id];
      return s && (s.directoryTrust || s.nativeInputReady || /Make auto mode your default permission mode/.test(s.viewport||''));
    },session.id);
    const trust=await page.evaluate(id=>window.__splitObservations[id]?.directoryTrust,session.id);
    if(trust) {
      assert.equal(await realpath(trust.cwd),await realpath(cwd));
      await container.locator('[data-trust-decision="trust"]').click();
    }
    await page.waitForFunction(id=>{
      const s=window.__splitObservations[id];
      return s?.nativeInputReady || /Make auto mode your default permission mode/.test(s?.viewport||'');
    },session.id);
    const screen=await page.evaluate(id=>window.__splitObservations[id]?.viewport||'',session.id);
    if(/Make auto mode your default permission mode/.test(screen)) {
      if(/❯\s*Yes, set auto mode/.test(screen)) await page.evaluate(({ws,id})=>window.desktop.sendKey(ws,id,'Down'),{ws:workspace.id,id:session.id});
      await page.waitForFunction(id=>/❯\s*No, keep manual mode/.test(window.__splitObservations[id]?.viewport||''),session.id);
      await page.evaluate(({ws,id})=>window.desktop.sendKey(ws,id,'Enter'),{ws:workspace.id,id:session.id});
    }
    await page.waitForFunction(({id,model})=>{
      const s=window.__splitObservations[id];return s?.statusLine?.modelId===model && s.nativeInputReady;
    },{id:session.id,model});
  }
  await prepare(leftPane,left);
  await leftPane.getByRole('button',{name:'并排打开对话',exact:true}).click();
  await rightPane.waitFor();
  await prepare(rightPane,right);
  const id=randomUUID().slice(0,7);
  const tags=['LEFT_'+id,'RIGHT_'+id], prompts=tags.map(tag=>'Reply exactly '+tag+'. Use no tools.');
  const containers=[leftPane,rightPane];
  const boxes=containers.map(c=>c.getByRole('textbox',{name:'发送给 Claude 的消息'}));
  for(let i=0;i<2;i++)await boxes[i].fill(prompts[i]);
  assert.deepEqual(await Promise.all(boxes.map(b=>b.inputValue())),prompts);
  const buttons=containers.map(c=>c.getByRole('button',{name:'发送消息',exact:true}));
  // Native DOM click events traverse each real form; the same renderer tick
  // applies concurrent pressure without racing two Playwright mouse pointers.
  const handles=await Promise.all(buttons.map(b=>b.elementHandle()));
  const starts=await page.evaluate(([a,b])=>{
    if(a.matches(':disabled, [aria-disabled="true"]') || b.matches(':disabled, [aria-disabled="true"]'))throw Error('Both split composers must be enabled');
    const start=performance.now();a.click();const after=performance.now();b.click();return [start,after];
  },handles);
  report.sendSkewMs=Math.round(100*(starts[1]-starts[0]))/100;
  const sessions=[left,right];
  for(let i=0;i<2;i++){
    await page.waitForFunction(({id,tag})=>window.__splitObservations[id]?.messages.some(m=>m.role==='assistant'&&m.source==='jsonl'&&m.text.includes(tag)),{id:sessions[i].id,tag:tags[i]},{timeout:300000});
    const messages=await page.evaluate(id=>window.__splitObservations[id].messages,sessions[i].id);
    assert.ok(messages.some(m=>m.role==='user'&&m.text===prompts[i]));
    assert.ok(!messages.some(m=>m.text.includes(tags[1-i])));
    const conversation=containers[i].locator('.conversation');
    assert.ok((await conversation.innerText()).includes(tags[i]));
    assert.ok(!(await conversation.innerText()).includes(tags[1-i]));
    const file=path.join(config,'projects',projectSlug(cwd),sessions[i].id+'.jsonl');
    const rows=(await readFile(file,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    const replies=rows.filter(r=>r.type==='assistant'&&r.message?.model&&r.message.model!=='<synthetic>');
    assert.ok(replies.some(r=>r.message.content?.some(b=>b.type==='text'&&b.text.includes(tags[i]))));
    const models=[...new Set(replies.map(r=>r.message.model))];
    assert.deepEqual(models,[model]);
    assert.ok(!rows.some(r=>r.type==='user'&&JSON.stringify(r.message?.content).includes(tags[1-i])));
    Object.assign(report.sessions[i],{tag:tags[i],models,canonicalReply:true,foreignMessages:0});
  }
  await page.screenshot({path:path.join(out,'two-live-conversations.png')});
  const retained='UNSENT_RIGHT_'+id;
  await boxes[1].fill(retained);
  await leftPane.getByRole('button',{name:'关闭此分屏',exact:true}).click();
  await rightPane.waitFor({state:'detached'});
  await page.waitForFunction(tag=>document.querySelector('.desk-pane[data-view="primary"] .conversation')?.textContent.includes(tag),tags[1]);
  await page.waitForFunction(draft=>document.querySelector('.desk-pane[data-view="primary"] textarea')?.value===draft,retained);
  assert.ok(!(await leftPane.locator('.conversation').innerText()).includes(tags[0]));
  for(const session of sessions) {
    const probe=(await exec('tmux',privateServer.args('display-message','-p','-t',session.paneId,'#{pane_dead}|#{@lectern_session_id}'),{env})).stdout.trim();
    assert.equal(probe,'0|'+session.id);
  }
  report.retainedSecondaryDraft=true;
  report.bothNativePanesAlive=true;
  assert.deepEqual(report.rendererErrors,[]);
  await page.screenshot({path:path.join(out,'retained-conversation.png')});
  report.success=true;
}catch(e){
  report.error=String(e?.stack||e); process.exitCode=1;
  await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});
  const states=await page?.evaluate(()=>Object.fromEntries(Object.entries(window.__splitObservations||{}).map(([id,s])=>[id,{pane:s.paneId,status:s.status,viewport:s.viewport?.slice(-1400)}]))).catch(()=>undefined);
  if(states)report.lastObserved=states;
}finally{
  await app?.close();
  await backend.dispose();
  privateServer.cleanup();
  await rm(config,{recursive:true,force:true});
  await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({out,...report}));
}
