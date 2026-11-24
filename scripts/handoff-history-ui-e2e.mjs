// Isolated, native-format source -> middle -> tip. No SSH or Claude process.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from './fixtures/electron.mjs';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lectern-handoff-ui-')));
const cwd = path.join(root, 'work'), profile = path.join(root, 'profile'), config = path.join(root, 'config');
const project = path.join(config, 'projects', cwd.replace(/[^a-z0-9-]/gi, '-'));
const [old, middle, tip, tool] = Array.from({length:4}, () => randomUUID());
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const line = row => JSON.stringify(row) + '\n';
let app;
try {
  await Promise.all([cwd, profile, project].map(p => mkdir(p, {recursive:true})));
  await writeFile(path.join(profile,'workspaces.json'), JSON.stringify([{id:'sample', name:'交接测试', cwd, kind:'local'}]));
  let parent = null;
  const msg = (sessionId, type, content) => {
    const uuid = randomUUID();
    const s = line({type, cwd, sessionId, uuid, parentUuid:parent, message:{role:type, content, ...(type === 'assistant' && {id:uuid, stop_reason:'end_turn'})}});
    parent = uuid;
    return s;
  };
  const boundary = () => {
    const uuid = randomUUID(), logicalParentUuid = parent;
    return sessionId => { parent = uuid; return line({cwd, type:'system', subtype:'compact_boundary', sessionId, uuid, parentUuid:null, logicalParentUuid}); };
  };
  const link = (sessionId, continuedInSessionId) => line({type:'continued-in', sessionId, continuedInSessionId});
  let a = msg(old,'user','首段起点') + msg(old,'assistant','首段答案');
  const cut1 = boundary();
  a += cut1(old);
  const checkpoint = parent;
  a += msg(old,'user','原稿切走前未获回复的问题');
  a += line({type:'last-prompt', sessionId:old, explicit:true, leafUuid:checkpoint});
  parent = checkpoint;
  a += msg(old,'user','仅保存在第一段') + msg(old,'assistant','第一段交接前回复') + link(old,middle);
  let b = cut1(middle);
  for (let i = 0; i < 55; i++) b += msg(middle,'user',`中段问题 ${i}`) + msg(middle,'assistant',[{type:'thinking',thinking:'x'.repeat(4200)}, {type:'text',text:`中段回答 ${i}`}]);
  const cut2 = boundary();
  b += cut2(middle) + msg(middle,'user','仅保存在第二段') + msg(middle,'assistant',[{type:'tool_use',id:tool,name:'Read',input:{file_path:'sample.txt'}}])
    + msg(middle,'user',[{type:'tool_result',tool_use_id:tool,content:'独有的工具结果'}]) + msg(middle,'assistant',[{type:'text',text:'第二段交接前回复'},
      {type:'image', title:'旧段图片', source:{type:'base64',media_type:'image/png',data:png}}]) + link(middle,tip);
  const c = cut2(tip) + msg(tip,'user','当前聊天提问') + msg(tip,'assistant','当前聊天回复');
  await Promise.all([[old,a],[middle,b],[tip,c]].map(([id,data])=>writeFile(path.join(project,id+'.jsonl'),data)));
  const env = {...process.env,LECTERN_LOCALE:'zh-CN',LECTERN_USER_DATA:profile,CLAUDE_CONFIG_DIR:config,TMUX_TMPDIR:root,LECTERN_LOG_DIR:path.join(root,'logs')};
  delete env.TMUX; delete env.LECTERN_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
  const exe = process.argv[2];
  app = await _electron.launch({args:exe ? [] : ['.'], ...(exe && {executablePath:path.resolve(exe)}),env});
  const page = await app.firstWindow(); page.setDefaultTimeout(12000);
  await page.locator(`.session-row[data-session-id="${tip}"]`).click();
  await page.getByText('当前聊天回复',{exact:true}).waitFor();
  const entry = page.getByRole('button',{name:'交接前记录',exact:true});
  await entry.click();
  const dialog = page.getByRole('dialog',{name:'交接前记录',exact:true});
  const choose = dialog.getByRole('combobox',{name:'原始记录'});
  assert.equal(await choose.inputValue(),middle);
  assert.equal(await choose.locator('option').count(),2);
  await dialog.getByText('第二段交接前回复',{exact:true}).waitFor();
  assert.equal(await dialog.getByRole('textbox').count(),0);
  assert.equal(await dialog.getByRole('button',{name:/发送消息|续接|回退到这里/}).count(),0);
  await dialog.locator(`[data-tool-id="${tool}"] > summary`).click();
  await dialog.getByText('独有的工具结果',{exact:true}).waitFor();
  const image = dialog.getByRole('button',{name:'放大 旧段图片'});
  await image.scrollIntoViewIfNeeded(); await image.locator('img').waitFor();
  await image.click({button:'right'});
  await dialog.getByRole('menuitem',{name:'下载原图'}).waitFor();
  await page.keyboard.press('Escape');
  await dialog.getByRole('menu').waitFor({state:'hidden'});
  await image.click();
  const enlarged = page.getByRole('dialog',{name:'图片预览 · 旧段图片'});
  const pixels = await enlarged.getByRole('img',{name:'旧段图片',exact:true}).evaluate(async img => {await img.decode(); return img.naturalWidth;});
  assert.equal(pixels,1); await enlarged.getByRole('button',{name:'关闭图片预览'}).click();
  assert.equal(await dialog.getByText('中段问题 0',{exact:true}).count(),0);
  await dialog.getByRole('button',{name:'加载更早的消息'}).click();
  await dialog.getByText('中段问题 0',{exact:true}).waitFor();
  assert.equal(await dialog.getByText('仅保存在第二段',{exact:true}).count(),1);
  await choose.selectOption(old);
  await dialog.getByText('第一段交接前回复',{exact:true}).waitFor();
  assert.equal(await dialog.getByText('仅保存在第二段',{exact:true}).count(),0);
  const abandoned = dialog.getByText('原稿切走前未获回复的问题',{exact:true});
  assert.equal(await abandoned.count(),0);
  await dialog.getByRole('button',{name:/查看其他路径的记录/}).click();
  await abandoned.waitFor();
  assert.equal(await dialog.getByText('第一段交接前回复',{exact:true}).count(),0);
  await dialog.getByRole('button',{name:'返回该段对话'}).click();
  await dialog.getByText('第一段交接前回复',{exact:true}).waitFor();
  // Release a delayed IPC reply after another source has already rendered.
  // The earlier checks above used the real history/attachment handlers.
  await app.evaluate(({ipcMain}, middle) => {
    ipcMain.removeHandler('lectern:readHandoffHistory');
    ipcMain.handle('lectern:readHandoffHistory', async (_event, _ws, _tip, source) => {
      if (source === middle) await new Promise(resolve => { globalThis.finishOldRead = resolve; });
      return {messages:[{id:'delayed-'+source, role:'user', source:'jsonl', status:'complete', tools:[],
        text:source === middle ? '已切走的读请求' : '选中的段'}]};
    });
  },middle);
  await choose.selectOption(middle);
  await app.evaluate(async () => {
    for (let i=0; !globalThis.finishOldRead && i<100; i++) await new Promise(r=>setTimeout(r,10));
    if (!globalThis.finishOldRead) throw Error('未触发源段读取');
  });
  await choose.selectOption(old);
  await dialog.getByText('选中的段',{exact:true}).waitFor();
  await app.evaluate(() => { globalThis.finishOldRead(); });
  await page.evaluate(() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert.equal(await dialog.getByText('已切走的读请求',{exact:true}).count(),0);
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'hidden'});
  await page.getByText('当前聊天回复',{exact:true}).waitFor();
  assert.equal(await page.getByText('选中的段',{exact:true}).count(),0);
  console.log('通过：只读查看两段原始交接记录，恢复独有的提问、工具和图片，向上分页后切源并返回当前聊天。');
} finally { await app?.close(); await rm(root,{recursive:true,force:true}); }
