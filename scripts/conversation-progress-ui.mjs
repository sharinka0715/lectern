// 通过隔离的 demo JSONL 和真实 tmux 原屏，检查工作台的活动、清单和进度。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron, resizeWindow } from './fixtures/electron.mjs';

const profile = await mkdtemp(path.join(tmpdir(), 'lectern-conversation-ui-'));
const results = path.resolve('test-results');
await mkdir(results, {recursive:true});
const env = {...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA:profile, LECTERN_NODE_BINARY:process.execPath, LECTERN_LOG_DIR:path.join(profile, 'diagnostics'), LECTERN_DIAGNOSTIC_CONTENT:'0'};
delete env.ELECTRON_RUN_AS_NODE;
delete env.LECTERN_DEV_URL;
const exe = process.argv[2];
let app;
try {
  app = await _electron.launch({env, args:exe ? ['--demo'] : ['.', '--demo'], ...(exe && {executablePath:path.resolve(exe)})});
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(18000);
  await resizeWindow(app, page, 1270, 910);
  await page.locator('.session-row.active[data-session-live="true"]').waitFor();
  const { workspace, session } = await page.evaluate(async () => {
    const [workspace] = await window.desktop.listWorkspaces();
    return {workspace, session: (await window.desktop.discover(workspace.id)).sessions[0]};
  });
  assert.equal(workspace.id, 'demo-local');
  const row = (type, content, extra = {}) => ({uuid:randomUUID(), sessionId:session.id, cwd:workspace.cwd, timestamp:new Date().toISOString(), type,
    message:{role:type, content, ...(type === 'assistant' && {id:randomUUID()})}, ...extra});
  const tool = (id, name, input) => ({type:'tool_use', id, name, input});
  const result = (id, content, is_error=false) => row('user', [{type:'tool_result', tool_use_id:id, content, is_error}]);
  const steps = [{id:'1',subject:'核对安装包的版本号',status:'completed'},{id:'2',subject:'补上版本校验并运行测试',status:'in_progress'},
    {id:'3',subject:'验证各平台的安装包',status:'pending'}];
  const records = [
    row('user','检查发布脚本，补上安装包的版本校验。'),
    row('assistant',[{type:'text',text:'我会先检查发布脚本怎样读取版本号，再补一个能发现旧包的测试。'},
      tool('read','Read',{file_path:'release.ts'}),tool('cmd','Bash',{command:'npm test',description:'运行版本回归'}),
      tool('edit','Edit',{file_path:'release.ts',old_string:'return build();',new_string:'verifyVersion(pkg);\nreturn build(pkg);'}),
      tool('agent','Agent',{description:'检查归档中的版本信息',prompt:'核对归档文件中的版本信息。'}),
      tool('message','SendMessage',{to:'打包验证',message:'请核对归档中的版本号。'})]),
    result('read','已读取 release.ts'), result('cmd','旧版归档未被拒绝',true),
    {...result('edit','已更新 release.ts'),toolUseResult:{structuredPatch:[{oldStart:10,oldLines:1,newStart:10,newLines:2,
      lines:['-return build();','+verifyVersion(pkg);','+return build(pkg);']}]}},result('agent','已检查归档'),result('message','已投递'),
    {...row('user','归档清单已包含版本号。'), isMeta:true, origin:{kind:'peer',senderTaskId:'pack',name:'打包验证',msg_id:'received',body:'归档清单已包含版本号。'}},
    row('assistant',[{type:'text',text:'旧归档可以复现问题。构建入口已增加版本检查，接下来验证三个平台的产物。'}]),
    {type:'attachment',uuid:randomUUID(),sessionId:session.id,attachment:{type:'task_reminder',content:steps}},
  ];
  await appendFile(session.path,records.map(record => JSON.stringify(record)+'\n').join(''));
  const tasks = page.getByRole('list',{name:'当前对话任务清单'});
  await tasks.waitFor();
  assert.deepEqual(await tasks.locator('li').allTextContents(),steps.map(task=>task.subject));
  assert.deepEqual(await tasks.locator('li').evaluateAll(nodes=>nodes.map(n=>n.dataset.taskStatus)),steps.map(task=>task.status));
  const group = page.locator('.tool-group').filter({has:page.locator('[data-tool-id="cmd"]')});
  const summary = group.locator(':scope > summary');
  assert.match(await summary.innerText(),/失败/);
  assert.match(await summary.innerText(),/\+2/);
  assert.match(await summary.innerText(),/[−-]1/);
  const state = path.join(workspace.claudeDir,'screen-state');
  const progress = page.locator('.turn-progress');
  await writeFile(state, 'progress');
  await progress.filter({hasText:/15/}).waitFor();
  assert.ok((await progress.boundingBox()).y < (await page.locator('form.composer').boundingBox()).y);
  await writeFile(state, 'compacting');
  await progress.filter({hasText:/842/}).waitFor();
  assert.match(await progress.innerText(), /压缩|Compact/i);
  await summary.click();
  const scroll = page.locator('.conversation-scroll');
  await scroll.evaluate(el => {el.scrollTop = el.scrollHeight;});
  await page.screenshot({path:path.join(results,'conversation-018.png')});
  await summary.click();
  await writeFile(state, 'ready');
  await page.waitForFunction(()=>!document.querySelector('.turn-progress')?.textContent.includes('842'));
  // Claude Code 2.1.329+ lists background work below the footer; the pill still reads the row above the input box.
  await writeFile(state, 'compacting agents');
  await progress.filter({hasText:/842/}).waitFor();
  assert.match(await progress.innerText(), /压缩|Compact/i);
  await writeFile(state, 'progress agents');
  await progress.filter({hasText:/15 tokens/}).waitFor();
  assert.doesNotMatch(await progress.innerText(), /141\.6k|3m 8s|压缩|Compact/i);
  await writeFile(state, 'ready');
  await page.waitForFunction(()=>!document.querySelector('.turn-progress')?.textContent.includes('15 tokens'));
  // 2.1.330 lists at most five subagents, timers ticking, then "↓ 2 more" (mock: agents:7).
  await writeFile(state, 'progress agents:7');
  await progress.filter({hasText:/15 tokens/}).waitFor();
  assert.doesNotMatch(await progress.innerText(), /more|子代理/);
  await writeFile(state, 'ready');
  await page.waitForFunction(()=>!document.querySelector('.turn-progress')?.textContent.includes('15 tokens'));
  await page.reload();
  await tasks.waitFor();
  assert.deepEqual(await tasks.locator('li').allTextContents(),steps.map(task=>task.subject));
  assert.equal(await page.locator('.tool-group[open]').count(),0);
  assert.deepEqual(errors, []);
  console.log('PASS: transcript activity, failed call and applied line counts, task states, progress/compact tokens (also with background tasks listed below the input box, "↓ N more" too), reload.');
} finally {
  await app?.close();
  await rm(profile,{recursive:true,force:true});
}
