import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Backend, ReadResult } from '../src/backend';
import { QuestionInputUnconfirmed } from '../src/backend/native-question-actions';
import { Controller } from '../src/main/controller';
import type { WorkspaceStore } from '../src/main/store';
import type { SessionSnapshot } from '../src/shared/types';

const {single, other} = JSON.parse(readFileSync(new URL('./fixtures/native-contracts/question-2.1.326.json', import.meta.url),'utf8')).scenarios;
const frames = {start: single.screens.start as string, focus: other.screens.focus as string};
const session = 'session-q';
const workspace = {id:'local', kind:'local', cwd:'/tmp'};
function setup(hasTool=true) {
  let pending = hasTool, viewport: string = frames.start, active = true, calls=0, ownerPid=42;
  let answer: () => Promise<void> = async () => {};
  const record = {type:'assistant', uuid:'assistant', sessionId:session, message:{id:'message-q', role:'assistant',
    content:[{type:'tool_use', id:'question-q', name:'AskUserQuestion', input:{questions:[{header:'Drink',question:'Which drink should we serve?'}]}}]}};
  const backend = {
    resetRead(){}, dispose(){}, readSession: async (): Promise<ReadResult> => {
      const jsonl = pending ? Buffer.from(JSON.stringify(record)+'\n') : Buffer.alloc(0);
      pending = false;
      return {session:{id:session,title:'Question',mapping:'exact',paneId:active?'%5':undefined},panePid:ownerPid,
        viewport, screen:frames.start, nativeStatus:'waiting', active, jsonl, reset:false, hasMore:false};
    },
    answerQuestion:async()=>{calls++; await answer();},
  } as unknown as Backend;
  const controller=new Controller({get:()=>workspace} as unknown as WorkspaceStore, backend);
  const click=(s:SessionSnapshot) => controller.answerQuestion(workspace.id,session,'%5',s.panePid!,s.question!.token,{kind:'activate',number:1});
  const next=async()=> (await once(controller,'snapshot'))[0] as SessionSnapshot;
  return {controller,click,next,open:()=>controller.watchSession(workspace.id,session),calls:()=>calls,
    setAnswer:(fn:()=>Promise<void>)=>{answer=fn;}, show:(view:string)=>{viewport=view;}, changePid:()=>{ownerPid++;}, offline:()=>{active=false;}};
}

test('问答卡同时需要未完成的当前调用和新鲜原屏，翻历史或引用菜单不会激活', async()=>{
  const historical=setup(false);
  try { assert.equal((await historical.open()).question,undefined); } finally {await historical.controller.dispose();}
  const t=setup();
  try {
    t.show('普通编辑框');
    assert.equal((await t.open()).question,undefined,'滚屏里有旧菜单也不能触发');
    t.show(frames.start);
    const live=await t.next();assert.ok(live.question);
    t.offline();assert.equal((await t.next()).question,undefined);
    await assert.rejects(t.click(live),/已更新/);
    assert.equal(t.calls(),0);
  } finally {await t.controller.dispose();}
});

test('同一问题两次点击互斥，切换 pane 后旧点击不能落在新进程', async()=>{
  const t=setup();
  try {
    const s=await t.open(); assert.ok(s.question);
    await assert.rejects(t.controller.sendMessage(workspace.id,session,'普通消息'),/提问卡/);
    let finish!:()=>void;
    t.setAnswer(()=>new Promise<void>(resolve=>{finish=resolve;}));
    const sending=t.click(s);
    assert.equal(t.controller.currentSnapshot?.questionBusy,true);
    await assert.rejects(t.click(s),/已更新/);
    await assert.rejects(t.controller.setTerminalControl(workspace.id,session,true),/执行/);
    t.show(frames.focus); finish(); await sending;
    const updated=await t.next();assert.ok(updated.question); assert.notEqual(updated.question.token,s.question.token);
    assert.equal(updated.question.interactionId,s.question.interactionId);
    await assert.rejects(t.click(s),/已更新/);
    t.changePid(); const changed=await t.next(); assert.notEqual(changed.question?.interactionId,updated.question.interactionId);
    await assert.rejects(t.click(updated),/已更新/); assert.equal(t.calls(),1);
  } finally {await t.controller.dispose();}
});

test('输入送达后未能核实后继，同一原屏不会重新开放提交', async()=>{
  const t=setup();
  try {
    const s=await t.open();
    t.setAnswer(async()=>{throw new QuestionInputUnconfirmed(new Error('回执超时'));});
    await assert.rejects(t.click(s));
    const unchanged=await t.next(); assert.equal(unchanged.questionUnconfirmed,true); assert.equal(unchanged.questionBusy,false);
    await assert.rejects(t.click(s),/已更新/);
    t.show(frames.focus); const next=await t.next(); assert.ok(next.question && !next.questionUnconfirmed);
    assert.notEqual(next.question.token,s.question?.token);
  } finally {await t.controller.dispose();}
});

test('同一道题追加说明后令牌不变、回答带新位置；换焦点、换题才换令牌', async()=>{
  // Claude Code may append notices (system/informational) while a question is on screen; the card
  // follows the newer record instead of refusing the click. Any change of the screen is a new card.
  const {multi} = JSON.parse(readFileSync(new URL('./fixtures/native-contracts/question-2.1.326.json', import.meta.url),'utf8')).scenarios;
  const record = {type:'assistant', uuid:'assistant', sessionId:session, message:{id:'message-q', role:'assistant',
    content:[{type:'tool_use', id:'question-m', name:'AskUserQuestion', input:{questions:[{header:'Drink',question:'Which drink should we serve?'}]}}]}};
  const notice = {parentUuid:'assistant', isSidechain:false, type:'system', subtype:'informational', level:'warning', uuid:'notice', sessionId:session, content:'A notice.'};
  let viewport: string = multi.screens.start, offset = 900, jsonl = Buffer.from(JSON.stringify(record)+'\n');
  const positions: unknown[] = [];
  const backend = {
    resetRead(){}, dispose(){}, readSession: async (): Promise<ReadResult> => {
      const chunk = jsonl; jsonl = Buffer.alloc(0);
      return {session:{id:session,title:'Question',mapping:'exact',paneId:'%5'},panePid:42, viewport, screen:viewport, nativeStatus:'waiting', active:true,
        jsonl:chunk, reset:false, hasMore:false, transcriptPosition:{inode:'7', offset}};
    },
    answerQuestion:async(...args:unknown[])=>{positions.push(args[7]);},
  } as unknown as Backend;
  const controller=new Controller({get:()=>workspace} as unknown as WorkspaceStore, backend);
  const next=async()=> (await once(controller,'snapshot'))[0] as SessionSnapshot;
  const appendNotice=()=>{ jsonl = Buffer.from(JSON.stringify({...notice, uuid:`notice-${offset}`})+'\n'); offset += 120; };
  try {
    const first=(await controller.watchSession(workspace.id,session)).question!; assert.ok(first);
    appendNotice();
    const same=(await next()).question!; assert.equal(same.token,first.token,'a notice keeps the card');
    viewport=multi.screens.other;
    const focus=(await next()).question!; assert.notEqual(focus.token,first.token,'another focus is another card');
    assert.equal(focus.interactionId,first.interactionId);
    viewport=multi.screens.afterEnter;
    const second=(await next()).question!; assert.notEqual(second.token,focus.token,'the next question is another card');
    appendNotice();
    assert.equal((await next()).question!.token,second.token);
    await controller.answerQuestion(workspace.id,session,'%5',42,second.token,{kind:'activate',number:1});
    assert.deepEqual(positions,[{inode:'7', offset}],'answered at the record the backend has read');
  } finally {await controller.dispose();}
});
