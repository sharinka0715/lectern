import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageDisplay } from '../src/core/message-display';

const prompt = (uuid: string, text: string, parentUuid: string | null = null) => ({type:'user', sessionId:'s', uuid, parentUuid, message:{content:text}});
const use = (id: string, name: string, input: object, parentUuid: string) => ({type:'assistant', sessionId:'s', uuid:id, parentUuid,
  message:{content:[{type:'tool_use', id, name, input}]}});
const receipt = (id: string, content: string, is_error = false) => ({type:'user', sessionId:'s', uuid:id+'-r', parentUuid:id,
  message:{content:[{type:'tool_result', tool_use_id:id, content, is_error}]}});
const lines = (...records: object[]) => records.map(record => JSON.stringify(record)+'\n').join('');

test('confirmed task changes preserve duplicate subjects and roll back with their branch', () => {
  const view = new MessageDisplay('s');
  view.ingestJsonl(lines(prompt('u','start'), use('c1','TaskCreate',{subject:'校验'},'u'), receipt('c1','Task #1 created successfully: 校验'),
    use('c2','TaskCreate',{subject:'校验'},'c1-r'), receipt('c2','Task #2 created successfully: 校验'),
    use('change','TaskUpdate',{taskId:'2',status:'in_progress'},'c2-r'),receipt('change','Updated task #2 status')));
  assert.deepEqual(view.tasks.list.map(t=>[t.id,t.status]),[['1','pending'],['2','in_progress']]);
  view.ingestJsonl(lines(use('fail','TaskUpdate',{taskId:'1',status:'completed'},'change-r'),receipt('fail','Updated task #1 status',true),
    use('miss','TaskUpdate',{taskId:'2',status:'completed'},'fail-r'),receipt('miss','Task #2 not found'),
    prompt('u2','remove','miss-r'),use('del','TaskUpdate',{taskId:'2',status:'deleted'},'u2'),receipt('del','Updated task #2 status')));
  assert.deepEqual(view.tasks.list.map(t=>t.id),['1']);
  view.confirmNativeRewind('remove','u2');
  assert.deepEqual(view.tasks.list.map(t=>t.status),['pending','in_progress']);
});

test('paging reconstructs missing calls and ignores user-authored task text and other sessions', () => {
  const view = new MessageDisplay('s');
  const older=lines(prompt('u','start'),use('c','TodoWrite',{todos:[{content:'检查',status:'in_progress'}]},'u'));
  view.ingestJsonl(lines(receipt('c','Todos have been modified successfully.'),prompt('u2','#1 [completed] 手工输入','c-r')),
    true,true);
  assert.deepEqual(view.tasks.list,[]);
  view.prependJsonl(older,false);
  view.ingestJsonl(lines({...use('side','TaskList',{},'u2'),isSidechain:true},receipt('side','#3 [completed] side'),
    {...prompt('other','elsewhere'), sessionId:'another'}));
  assert.deepEqual(view.tasks.list,[{id:'1',title:'检查',status:'in_progress'}]);
});

test('task reminders and native compact metadata restore authoritative snapshots', () => {
  const view = new MessageDisplay('s');
  const row = {type:'attachment',uuid:'remind',sessionId:'s',parentUuid:'u',attachment:{type:'task_reminder',content:[{id:'6',subject:'发布',status:'pending'}]}};
  view.ingestJsonl(lines(prompt('u','start'),row));
  assert.equal(view.tasks.list[0].title,'发布');
  const compact={type:'system',subtype:'compact_boundary',sessionId:'s',uuid:'compact',logicalParentUuid:'remind',compactMetadata:{
    preCompactTaskList:{highestId:6,tasks:[{id:'6',subject:'发布',status:'completed'}]},preservedMessages:{uuids:[],allUuids:[]}}};
  view.ingestJsonl(lines(compact));
  assert.deepEqual(view.tasks.list,[{id:'6',title:'发布',status:'completed'}]);
});

test('desktop plan replacements and incremental steps appear below the current conversation', () => {
  const view = new MessageDisplay('s');
  const plan='mcp__ccd_turn__update_plan';
  view.ingestJsonl(lines(prompt('u','start'),use('p',plan,{items:[{content:'核对输入框',status:'in_progress'},{content:'桌面验证',status:'pending'}]},'u'),
    receipt('p','Plan shown.'),use('a',plan,{advance:true},'p-r'),receipt('a','Plan updated.')));
  assert.deepEqual(view.tasks.list.map(t=>t.status),['completed','in_progress']);
  view.ingestJsonl(lines(use('wrap','mcp__ccd_turn__wrap_up',{},'a-r'),receipt('wrap','done')));
  assert.ok(view.tasks.list.every(t=>t.status==='completed'));
  view.ingestJsonl(lines(use('list','TaskList',{},'wrap-r'),receipt('list','No tasks found')));
  assert.deepEqual(view.tasks.list,[]);
});
