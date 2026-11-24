import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extractPreview } from '../src/core/screen';
import { nativeTaskPanel } from '../src/core/native-task-screen';
import { taskListFrame, decodeTaskList } from '../src/backend/native-task-list';
import { REPLY } from './helpers/claude-screen';

// 2.1.326 中启用与收起 ctrl+t 的原屏结构，任务与会话内容为隔离夹具。
const chrome = ['  1/3 tasks done · 1 in progress', '  ✔ Inspect fixture', '  ◼ Test fixture', '  ◻ Release fixture',
  '                 ◉ xhigh · /effort','──────────────', '❯  ', '──────────────', '  ⏵⏵ auto mode on (shift+tab to cycle) · ctrl+t to hide tasks · ← for agents'];
test('only a current native task panel is extracted and its rows stay out of the streamed answer', () => {
  const lines = ['❯ 继续','⏺ 正在验证发布。', '', ...chrome];
  const panel = nativeTaskPanel(lines);
  assert.deepEqual(panel?.tasks?.map(t=>t.status),['completed','in_progress','pending']);
  assert.equal(extractPreview(lines.join('\n').replace('⏺ 正在', `${REPLY} 正在`),'继续').text, '正在验证发布。');
  assert.equal(nativeTaskPanel(lines.slice(0,-1)), undefined);
  assert.equal(nativeTaskPanel([...lines,'❯ another question','──────────────','❯','──────────────','? for shortcuts']),undefined);
  assert.equal(nativeTaskPanel(lines.map(l=>l.replace('1/3 tasks','1/5 tasks')))?.tasks, undefined);
  // 2.1.329 起页脚下方还列出后台任务（main 和各子代理），再多也不把下边框挤出页脚范围。
  for (const n of [1, 4, 12]) {
    const agents = ['', '  ⏺ main', ...Array.from({length:n}, (_, i) => `  ◯ general-purpose  第 ${i + 1} 个子代理  ${i + 2}s`)];
    assert.deepEqual(nativeTaskPanel([...lines, ...agents])?.tasks?.map(t=>t.status), ['completed','in_progress','pending'], `${n}`);
    assert.equal(nativeTaskPanel([...lines.slice(0,-1), ...agents]), undefined);
  }
});

test('collapsed native task files return only titles and status for the selected session', {skip:process.platform==='win32'}, async t=>{
  const config = await mkdtemp(path.join(os.tmpdir(),'lectern-task-list-'));
  t.after(()=>rm(config,{recursive:true,force:true}));
  const session = randomUUID(), dir = path.join(config,'tasks',session);
  await mkdir(dir,{recursive:true});
  for (const [id,subject] of [['12','下一项'],['2','核对进展']]) {
    await writeFile(path.join(dir,id+'.json'),JSON.stringify({id,subject,status:'pending',description:'exclude this field',metadata:{comment:'internal'}}));
  }
  const run = (marker='ctrl+t to show tasks')=>execFileSync('/bin/sh',['-c',taskListFrame(config,session)],{env:{PATH:process.env.PATH,lectern_visible:marker},encoding:'utf8'});
  const frame=run();
  assert.ok(!frame.includes('exclude') && !frame.includes('internal'));
  assert.deepEqual(decodeTaskList(frame)?.map(t=>t.title),['核对进展','下一项']);
  assert.equal(run('idle'),'');
  await symlink(path.join(dir,'2.json'),path.join(dir,'3.json'));
  assert.equal(run(),'');
});
