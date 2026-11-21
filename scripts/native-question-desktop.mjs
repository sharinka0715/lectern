// 真实 Electron → preload → Controller → tmux → Claude Code，只有模型响应来自本机测试服务。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { _electron } from 'playwright';
import { createQuestionProbe } from './native-question-probe.mjs';

const fixture = await createQuestionProbe();
const { root, env, cwd, config } = fixture;
const run = promisify(execFile);
const tmux = (...args) => run('tmux', ['-f', '/dev/null', ...args], {env, cwd});
const session = randomUUID();
const workspace = {id:'question-fixture', name:'问答验证', kind:'local', cwd, claudeDir:config};
const basic = {header:'饮品', question:'午餐时喝什么？', multiSelect:false, options:[
  {label:'茶', description:'热饮'}, {label:'果汁', description:'冷饮'},
]};
const multi = {header:'点心', question:'要准备哪些点心？', multiSelect:true, options:[
  {label:'点心 A', description:'甜味'}, {label:'点心 B', description:'咸味'},
]};
const preview = {...basic, options:basic.options.map(o => ({...o, preview:`菜单\n  ${o.label}`}))};
const profile = path.join(root, 'profile');
const transcript = path.join(config, 'projects', cwd.replace(/[^a-zA-Z0-9]/g,'-'), session+'.jsonl');
let app, page, paneId, stage;
async function receipt(id) {
  for (let attempt=0; attempt<100; attempt++) {
    const lines = (await readFile(transcript,'utf8')).split('\n');
    let result;
    for (const line of lines.slice(0,-1)) {
      const row=JSON.parse(line);
      const content=row.message?.content;
      if (!Array.isArray(content)) continue;
      const block=content.find(b=>b.type==='tool_result' && b.tool_use_id===id);
      if (block) {
        result = {block, detail:row.toolUseResult};
        if (row.toolUseResult==='User rejected tool use') return result;
      }
      // 等上一题的后续回复落盘，避免其模型请求误领下一题。
      if (result && row.type==='assistant' && content.some(b=>b.type==='text' && b.text==='Question probe follow-up.')) return result;
    }
    await delay(100);
  }
  throw new Error(`等待工具回执超时 ${id}`);
}
try {
  stage='在隔离目录启动原生会话';
  await mkdir(profile);
  await writeFile(path.join(profile,'workspaces.json'),JSON.stringify([workspace]));
  const first = fixture.queueQuestion([basic], undefined, '先选一种午餐饮品。');
  const launched = await tmux('new-session','-d','-P','-F','#{pane_id}','-x','120','-y','42','-s','lectern-question-test','-c',cwd,
    'claude','--strict-mcp-config','--permission-mode','default','--model','claude-opus-5-5','--session-id',session,'请让我选择饮品。');
  paneId=launched.stdout.trim();
  const executablePath = process.argv[2];
  app=await _electron.launch({args:executablePath?[]:['.'], ...(executablePath && {executablePath:path.resolve(executablePath)}),
    env:{...env,LECTERN_LOCALE:'zh-CN',LECTERN_USER_DATA:profile,LECTERN_DIAGNOSTIC_CONTENT:'0',LECTERN_LOG_DIR:path.join(root,'diagnostics')}});
  page=await app.firstWindow(); page.setDefaultTimeout(20000);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1280,900));
  await page.locator(`.session-row[data-session-id="${session}"]`).click();
  const card=page.getByRole('region',{name:'原生问答'});
  const button=name=>card.getByRole('button',{name,exact:true});
  const row=(number)=>card.locator(`button[data-question-number="${number}"]`);
  const next=async (label, questions) => {
    stage=label;
    const id=fixture.queueQuestion(questions);
    await card.waitFor({state:'hidden'});
    const composer=page.getByRole('textbox',{name:'发送给 Claude 的消息'});
    await composer.fill(label);
    await page.getByRole('button',{name:'发送消息',exact:true}).click();
    await card.waitFor();
    return id;
  };
  stage='在问答卡输入自定义回答';
  await card.waitFor();
  await row(3).click();
  await card.getByRole('textbox',{name:'自定义回答'}).fill('温水 加柠檬');
  await button('写入原屏').click();
  await button('采用自定义回答').click();
  const custom=await receipt(first); assert.equal(custom.detail.answers[basic.question], '温水 加柠檬');
  assert.ok(!custom.block.is_error);
  const annotated=await next('给有预览的选项加备注',[preview]);
  await button('备注「果汁」').click();
  await card.getByRole('textbox',{name:'选项备注'}).fill('少冰 不加糖');
  await button('写入原屏').click();
  await button('选用此项与备注').click();
  const note=await receipt(annotated);
  assert.ok(!note.block.is_error);
  assert.equal(note.detail.answers[preview.question], '果汁');
  assert.deepEqual(note.detail.annotations[preview.question], {preview:preview.options[1].preview, notes:'少冰 不加糖'});
  const multiple=await next('回答两道题并核对选项',[basic,multi]);
  await row(1).click();
  await card.getByText(multi.question,{exact:true}).waitFor();
  await row(1).click(); await row(2).click();
  await button('下一页').click();
  await button('提交回答').waitFor();
  await button('上一页').click();
  await card.getByText(multi.question,{exact:true}).waitFor();
  await button('上一页').click();
  await card.getByText(basic.question,{exact:true}).waitFor();
  await row(2).click();
  await card.getByText(multi.question,{exact:true}).waitFor();
  await button('下一页').click();
  await button('提交回答').click();
  const answers=await receipt(multiple); assert.ok(!answers.block.is_error);
  assert.deepEqual(answers.detail.answers, {[basic.question]:'果汁', [multi.question]:'点心 A, 点心 B'});
  const partial=await next('提交部分回答',[basic,multi]);
  await row(2).click();
  await card.getByText(multi.question,{exact:true}).waitFor();
  await button('下一页').click();
  await button('提交已答部分').click();
  assert.deepEqual((await receipt(partial)).detail.answers, {[basic.question]:'果汁'});
  const skipped=await next('跳过全部题目并提交',[multi,basic]);
  await button('继续').click();
  await card.getByText(basic.question,{exact:true}).waitFor();
  await button('下一页').click();
  await button('不作答并提交').click();
  assert.deepEqual((await receipt(skipped)).detail.answers, {});
  const discuss=await next('先讨论这些选项',[basic]);
  await row(4).click();
  const clarify=await receipt(discuss); assert.equal(clarify.block.is_error,true);
  assert.match(clarify.block.content,/clarif|discuss|chat about/i);
  const cancel=await next('取消本次提问',[basic]);
  await button('取消问答').click();
  const rejected=await receipt(cancel); assert.equal(rejected.block.is_error,true); assert.match(rejected.block.content,/STOP|reject/i);
  await card.waitFor({state:'hidden'});
  await page.reload();
  await page.locator(`[data-tool-id="${cancel}"]`).waitFor();
  assert.equal(await card.count(),0);
  console.log('PASS: 原生回执确认带前言的中文自定义回答、预览备注、返回改答、多选、部分与空白提交、转为讨论、取消与重开历史。');
} catch (error) {
  console.error(stage, await page?.locator('[role=alert]').allTextContents().catch(()=>[]));
  const logs=path.join(root,'diagnostics');
  for (const file of await readdir(logs).catch(()=>[])) {
    if (!/^events\.\d+\.jsonl$/.test(file)) continue;
    const lines=(await readFile(path.join(logs,file),'utf8')).split('\n');
    for (const line of lines.filter(l=>l.includes('"ipc.answerQuestion.error"')).slice(-2)) console.error(JSON.parse(line).data?.error);
  }
  if (paneId) console.error((await tmux('capture-pane','-p','-J','-t',paneId).catch(()=>({stdout:''}))).stdout);
  if (page) console.error(await page.getByRole('region',{name:'原生问答'}).allTextContents().catch(()=>[]));
  throw error;
} finally {
  await app?.close();
  if (paneId) await tmux('kill-server').catch(()=>{});
  await fixture.close();
}
