// Renderer contract: real Electron/preload, replayed native captures and a
// recording answerQuestion IPC handler. Never sends answers to a live Claude.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from './fixtures/electron.mjs';
import { tsImport } from 'tsx/esm/api';

const { parseQuestionScreen } = await tsImport('../src/core/question-screen.ts', import.meta.url);
const { scenarios } = JSON.parse(await readFile(new URL('../tests/fixtures/native-contracts/question-2.1.326.json', import.meta.url), 'utf8'));
const profile = await mkdtemp(path.join(tmpdir(), 'lectern-question-ui-'));
const results = path.resolve('test-results', `question-ui-${Date.now()}`);
await mkdir(results, {recursive:true});
const env = {...process.env,LECTERN_LOCALE:'zh-CN',LECTERN_USER_DATA:profile,LECTERN_NODE_BINARY:process.execPath,LECTERN_LOG_DIR:path.join(profile,'diagnostics'),LECTERN_DIAGNOSTIC_CONTENT:'0'};
delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL;
let app;
try {
  app = await _electron.launch({args:['.','--demo'],env});
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const chat = page.getByRole('textbox',{name:'发送给 Claude 的消息',exact:true});
  await page.waitForFunction(() => document.querySelector('.session-settings')?.getAttribute('data-setting-initialization') === 'ready' && !document.querySelector('form.composer textarea')?.matches(':disabled, [aria-disabled="true"]'));
  const {base,jsonl} = await page.evaluate(async () => {
    const [w] = await window.desktop.listWorkspaces();
    const sid = document.querySelector('.session-row.active').dataset.sessionId;
    const base = await window.desktop.watchSession(w.id,sid);
    const jsonl = (await window.desktop.discover(w.id)).sessions.find(s=>s.id===sid).path;
    await window.desktop.unwatchSession();
    return {base,jsonl};
  });
  const original = await readFile(jsonl);
  await chat.fill('保留普通聊天草稿');
  await app.evaluate(({ipcMain,BrowserWindow},base) => {
    const f = globalThis.questionUI = {base,calls:[],step:0};
    f.send = snap => BrowserWindow.getAllWindows()[0].webContents.send('lectern:snapshot',f.snap = snap);
    ipcMain.removeHandler('lectern:answerQuestion');
    ipcMain.handle('lectern:answerQuestion',async(_e,ws,sid,pane,pid,token,action) => {
      if (ws!==base.workspaceId || sid!==base.sessionId || pane!==base.paneId || pid!==base.panePid || token!==f.snap.question?.token)
        throw new Error('Stale identity in renderer test');
      f.calls.push(action);
      if (f.hold) await new Promise(resolve => {f.release = resolve;});
      if (f.fail) throw new Error('Synthetic changed frame');
    });
  },base);
  const primary = page.locator('.desk-pane[data-view="primary"]');
  const card = primary.getByRole('region',{name:'原生问答',exact:true});
  const button = name => card.getByRole('button',{name,exact:true});
  const row = number => card.locator(`[data-question-number="${number}"]`);
  async function show(scenario,frame,options={}) {
    const viewport = scenarios[scenario].screens[frame];
    const screen = parseQuestionScreen(viewport); assert.ok(screen, `${scenario}.${frame} did not parse`);
    const token = await app.evaluate(({}, {screen,scenario,viewport,options}) => {
      const f = globalThis.questionUI;
      f.send({...f.base,status:'waiting',navigationStatus:'waiting',viewport,screen:viewport,
        question:{...screen,...options.question,interactionId:options.id || scenario,token:`t-${++f.step}`},...options.snapshot});
      return f.snap.question.token;
    },{screen,scenario,viewport,options});
    await primary.locator(`[data-question-token="${token}"]`).waitFor();
  }
  async function clear() { await app.evaluate(() => { const f=globalThis.questionUI;f.send(f.base); }); await card.waitFor({state:'detached'}); }
  let calls = 0;
  async function expectCall(action) {
    const actual = await app.evaluate(()=>globalThis.questionUI.calls);
    assert.equal(actual.length,++calls, 'one explicit click must dispatch exactly one action'); assert.deepEqual(actual.at(-1), action);
  }
  await show('single','start');
  assert.equal(await chat.count(),0); assert.equal(await page.locator('.waiting-banner').count(),0);
  assert.equal(await button('下一页').count(),0,'direct-submit questions do not advertise nonexistent review');
  await page.keyboard.press('Enter'); assert.equal(await app.evaluate(()=>globalThis.questionUI.calls.length),0);
  await row(2).evaluate(b=>{b.click();b.click();}); await expectCall({kind:'activate',number:2});
  assert.equal(await row(2).isDisabled(),true,'the successful old token stays locked');
  await clear(); assert.equal(await chat.inputValue(),'保留普通聊天草稿');

  await show('single','start',{id:'custom'}); await row(3).click(); await expectCall({kind:'focus',number:3});
  await show('other','focus',{id:'custom'});
  const other = card.getByRole('textbox',{name:'自定义回答',exact:true});
  assert.equal(await other.evaluate(el=>document.activeElement===el),true,'opening Other deliberately transfers keyboard focus to the verified native editor');
  await other.fill('柠檬\n水'); assert.equal(await button('写入原屏').isDisabled(),true);
  await other.fill('柠檬水');
  await other.dispatchEvent('compositionstart');
  await other.dispatchEvent('keydown',{key:'Enter',code:'Enter',keyCode:229,isComposing:true});
  await other.dispatchEvent('compositionend');
  assert.equal(await app.evaluate(()=>globalThis.questionUI.calls.length),calls,'IME confirmation is not an action');
  await other.press('Enter'); await expectCall({kind:'text',text:'柠檬水'});
  const nativeOther=parseQuestionScreen(scenarios.other.screens.text);
  await show('other','text',{id:'custom',question:{input:{...nativeOther.input,value:'柠檬水'}}});
  await button('采用自定义回答').click(); await expectCall({kind:'activate',number:3}); await clear();

  await show('preview','start'); await card.getByText('木桌',{exact:false}).waitFor();
  await button('预览「点心 区」').click(); await expectCall({kind:'focus',number:2});
  await show('preview','start'); await button('备注「点心 区」').click(); await expectCall({kind:'amend',number:2});
  await show('preview','edit');
  const notes=card.getByRole('textbox',{name:'选项备注',exact:true});
  await notes.fill('少糖 不加冰'); await button('写入原屏').click(); await expectCall({kind:'text',text:'少糖 不加冰'});
  await show('preview','text');
  await button('选用此项与备注').waitFor();
  await page.screenshot({path:path.join(results,'preview-notes.png')});
  await button('结束备注编辑').click(); await expectCall({kind:'cancel'});
  await show('preview','text'); await button('选用此项与备注').click(); await expectCall({kind:'activate',number:2}); await clear();

  await show('mixed','start'); await button('下一页').click(); await expectCall({kind:'next'});
  await show('mixed','incomplete'); await button('上一页').click(); await expectCall({kind:'previous'});
  await show('multi','start'); await row(2).click(); await expectCall({kind:'activate',number:2});
  await show('multi','custom'); await button('取消勾选自定义回答').click(); await expectCall({kind:'activate',number:3});
  await show('multi','submit'); await button('核对回答').click(); await expectCall({kind:'activate',number:5});
  await show('mixed','review'); assert.match(await card.innerText(),/Which drink should we serve\?[\s\S]+Tea/);
  await button('提交回答').click(); await expectCall({kind:'activate',number:1});
  await show('incompleteSubmit','partial'); await button('提交已答部分').click(); await expectCall({kind:'activate',number:1});
  await show('mixed','incomplete'); await button('不作答并提交').click(); await expectCall({kind:'activate',number:1});
  await show('mixed','incomplete');
  await button('取消问答').click(); await expectCall({kind:'activate',number:2});
  await show('single','start'); await button('讨论此题').click(); await expectCall({kind:'activate',number:4});
  await show('single','start'); await button('取消问答').click(); await expectCall({kind:'cancel'});

  await show('single','start'); await app.evaluate(()=>{globalThis.questionUI.fail=true;});
  await row(2).click(); await card.getByRole('alert').waitFor(); await expectCall({kind:'activate',number:2});
  await app.evaluate(()=>{globalThis.questionUI.fail=false;}); assert.equal(await row(2).isEnabled(),true);
  await row(2).press('Enter'); await expectCall({kind:'activate',number:2});

  // Terminal is an alternative editor, not a second active form; an unknown
  // delivery result blocks automated actions but must not strand manual recovery.
  await show('single','start',{snapshot:{questionUnconfirmed:true}}); await card.getByRole('alert').waitFor();
  assert.equal(await row(1).isDisabled(),true);
  await button('查看原屏').click(); await card.waitFor({state:'detached'});
  const take = primary.getByRole('button',{name:'接管终端',exact:true}); await take.waitFor(); assert.equal(await take.isEnabled(),true);
  await primary.getByRole('button',{name:'关闭终端原屏',exact:true}).click(); await card.waitFor();
  await show('single','start',{snapshot:{questionBusy:true}}); assert.equal(await row(2).isDisabled(),true);
  await button('查看原屏').click(); await take.waitFor(); assert.equal(await take.isDisabled(),true);
  await primary.getByRole('button',{name:'关闭终端原屏',exact:true}).click();
  await show('single','start'); await app.evaluate(() => {const f=globalThis.questionUI; f.send({...f.snap,terminalControl:{token:'manual-lease',paneId:f.base.paneId}});});
  await card.waitFor({state:'detached'}); await primary.getByText('此问答正由原生终端接管。').waitFor();

  // A short row split can scroll all the way to the final buttons without
  // enlarging either pane. Use a long display projection only for this layout check.
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(950,640));
  await primary.getByRole('button',{name:'并排打开对话'}).click();
  const long = {...parseQuestionScreen(scenarios.preview.screens.start),preview:'前端溢出验证\n'.repeat(150)+'x'.repeat(500)};
  await show('preview','start',{question:long});
  await primary.locator('.question-preview pre').waitFor();
  if ((await page.locator('.split-workspace.divided').getAttribute('data-direction'))!=='rows') await primary.getByRole('button',{name:'切换分屏方向'}).click();
  const bounds = await card.evaluate(el=>{
    const box=el.getBoundingClientRect(), pane=el.closest('.desk-pane').getBoundingClientRect();
    return {scroll:el.scrollHeight>el.clientHeight, contained:box.bottom<=pane.bottom+1 && box.top>=pane.top-1, width:el.scrollWidth<=el.clientWidth+1};
  }); assert.deepEqual(bounds,{scroll:true,contained:true,width:true});
  await button('取消问答').scrollIntoViewIfNeeded(); await page.screenshot({path:path.join(results,'scroll-split.png')});
  await page.locator('.desk-pane[data-view="secondary"]').getByRole('button',{name:'关闭此分屏'}).click();
  await show('other','focus'); await other.fill('不应跨题保留的草稿'); await clear();
  await show('other','focus'); assert.equal(await other.inputValue(),'');
  await app.evaluate(()=>{const f=globalThis.questionUI; f.hold=true; f.fail=true;});
  await button('取消问答').click(); await expectCall({kind:'cancel'});
  await page.getByRole('button',{name:/^新建对话/}).first().click();
  await page.waitForFunction(sid=>document.querySelector('.session-row.active')?.dataset.sessionId !== sid && !!document.querySelector('form.composer'),base.sessionId);
  await app.evaluate(()=>globalThis.questionUI.release());
  assert.equal(await card.count(),0); assert.equal(await page.getByText('Synthetic changed frame').count(),0);
  assert.deepEqual(await readFile(jsonl),original,'synthetic UI operations never write a human or tool JSONL row');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({scope:'Electron renderer + real captured forms + synthetic answer IPC',calls,results}));
} catch (error) {
  if (app) await (await app.firstWindow()).screenshot({path:path.join(results,'failure.png')}).catch(()=>{});
  throw error;
} finally { await app?.close(); await rm(profile,{recursive:true,force:true}); }
