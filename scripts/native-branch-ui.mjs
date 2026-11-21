// npm run build && node --import tsx scripts/native-branch-ui.mjs
// Isolated synthetic history, native CLI and Electron. No model requests.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { _electron } from 'playwright';
import { nativeBranchFixture } from '../tests/helpers/native-branch-fixture.ts';

const {root, cwd, ws, env: fixture, originalId, ids} = await nativeBranchFixture(36);
const profile = path.join(root,'profile'), logs = path.join(root,'logs');
await mkdir(profile); await writeFile(path.join(profile,'workspaces.json'),JSON.stringify([ws]));
const env = {...fixture, LECTERN_LOCALE:'zh-CN', LECTERN_USER_DATA:profile,LECTERN_LOG_DIR:logs,LECTERN_DIAGNOSTIC_CONTENT:'0',LANG:'en_US.UTF-8'};
const tmux = (...args) => execFileSync('tmux',['-f','/dev/null',...args],{env,encoding:'utf8'}).trim();
let app, page, stage='launch';
const row=id=>page.locator(`.session-row[data-session-id="${id}"]`);
const pane=view=>page.locator(`.desk-pane[data-view="${view}"]`);
const button=(scope,name)=>scope.getByRole('button',{name,exact:true});
const box=scope=>scope.getByRole('textbox',{name:'发送给 Claude 的消息'});
async function send(view,text) { const p=pane(view); await box(p).fill(text); await button(p,'发送消息').click(); }
const shows=(view,id)=>page.waitForFunction(([view,id])=>document.querySelector(`.desk-pane[data-view="${view}"] [data-message-id^="${id}:"]`),[view,id]);
const ready=id=>page.waitForFunction(id=>window.__observed?.[id]?.nativeInputReady,id,{timeout:30000});
const before=new Set([originalId]);
async function nextBranch() {
  const id = await page.waitForFunction(known=>[...document.querySelectorAll('.session-row[data-session-live="true"]')].map(el=>el.dataset.sessionId).find(id=>!known.includes(id)),[...before],{timeout:35000});
  const value=await id.jsonValue(); before.add(value); return value;
}
try {
  tmux('new-session','-d','-s','fixture-owner','-c',cwd,'sleep','160'); tmux('set-option','-g','focus-events','on');
  app=await _electron.launch({env,args:['.']}); page=await app.firstWindow(); page.setDefaultTimeout(30000);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,900));
  await page.waitForFunction(()=>!!window.desktop);
  await page.evaluate(()=>{window.__observed={}; window.desktop.onSnapshot(s=>window.__observed[s.sessionId]=s);});
  stage='resume fixture'; await row(originalId).click(); await button(pane('primary'),'续接会话').click(); await ready(originalId);
  const sourcePane=await page.evaluate(id=>window.__observed[id].paneId,originalId);
  stage='split'; await button(pane('primary'),'并排打开对话').click();
  await pane('secondary').click({position:{x:20,y:20}}); await row(originalId).click(); await shows('secondary',originalId);
  stage='fork and retain sibling'; await send('secondary','/fork'); const firstFork=await nextBranch();
  await shows('secondary',firstFork); await shows('primary',originalId); await ready(firstFork); await ready(originalId);
  const bindings=await page.evaluate(async ws=>(await window.desktop.discover(ws)).sessions.map(({id,paneId})=>[id,paneId]),ws.id);
  const pairs=Object.fromEntries(bindings); assert.equal(pairs[firstFork],sourcePane); assert.notEqual(pairs[originalId],sourcePane);
  stage='manual switch while fork in flight'; await send('secondary','/fork'); await row(originalId).click(); await shows('secondary',originalId);
  const secondFork=await nextBranch();
  // Seeing a row through sidebar polling is not proof of a completed operation.
  // Wait until the original of this second fork has a distinct resumed pane.
  await page.waitForFunction(async ({ws,id,oldPane})=>{const current=(await window.desktop.discover(ws)).sessions.find(s=>s.id===id);return !!current?.paneId && current.paneId!==oldPane;},{ws:ws.id,id:firstFork,oldPane:sourcePane},{timeout:35000,polling:600});
  await page.waitForFunction(()=>!document.querySelector('.desk-pane[data-view="secondary"] textarea')?.disabled);
  await shows('secondary',originalId); await shows('primary',originalId);
  stage='choose earlier duplicate'; await row(secondFork).click(); await ready(secondFork); await send('secondary','/rewind');
  const picker=page.getByRole('dialog',{name:'选择回退位置'}); await picker.waitFor();
  const selected=picker.locator(`[data-rewind-uuid="${ids[1]}"]`);
  if (!(await selected.count())) await button(picker,'加载更早的消息').click();
  await selected.waitFor();
  assert.equal(await picker.locator('button').filter({hasText:'Repeated prompt'}).count(),2);
  await selected.click(); await button(pane('secondary'),'确认回退对话').click({timeout:45000});
  await page.waitForFunction(id=>window.__observed[id]?.turnControls?.restoredDraft==='Repeated prompt',secondFork);
  assert.equal(await box(pane('secondary')).inputValue(),'Repeated prompt');
  const active = await page.evaluate(id=>window.__observed[id].messages.filter(m=>m.rewindUuid).map(m=>m.text),secondFork);
  assert.deepEqual(active,['Prompt 0']); await shows('primary',originalId);
  console.log('Verified initiating split follows fork, original resumes separately, late response preserves manual selection, and paged duplicate rewinds to exactly the earlier prompt.');
} catch (e) {
  console.error('Failure during '+stage, await page?.locator('.error-banner, [role=alert], .error').allTextContents().catch(()=>[]));
  const output=path.resolve('test-results','branch-ui-'+Date.now()); await mkdir(output,{recursive:true});
  await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
  const dump=await page?.evaluate(()=>({text:document.body.innerText,snapshots:window.__observed})).catch(()=>undefined);
  await writeFile(path.join(output,'failure.json'),JSON.stringify(dump ?? {}));
  console.error(output); throw e;
} finally {await app?.close();try{tmux('kill-server');}catch{} await rm(root,{recursive:true,force:true});}
