import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Backend, ReadResult } from '../src/backend';
import { performQuestionAction, QuestionInputUnconfirmed, type QuestionKey } from '../src/backend/native-question-actions';
import { TranscriptChangedNoKeys } from '../src/backend/native-settings';
import { Controller } from '../src/main/controller';
import type { WorkspaceStore } from '../src/main/store';
import type { SessionSnapshot } from '../src/shared/types';

const {single, other, chat} = JSON.parse(readFileSync(new URL('./fixtures/native-contracts/question-2.1.326.json', import.meta.url),'utf8')).scenarios;
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

/** A question on screen (Claude Code 2.1.330, a reply text above it) while the transcript has only
 * the prompt; `state` changes what the next read returns. */
async function earlyQuestionSession(native: {status?: 'waiting'|'idle'|'busy'; waitingFor?: string} = {status:'waiting', waitingFor:'input needed'}) {
  const fixture = (name: string) => readFileSync(new URL(`./fixtures/question-early/${name}.txt`, import.meta.url), 'utf8');
  const dialog = fixture('2.1.330-single'), multi = fixture('2.1.330-multi');
  const prompt = {type:'user', uuid:'u1', parentUuid:null, sessionId:session, message:{role:'user', content:'Ask me first'}};
  const state = {records:[prompt] as unknown[], screen:dialog, offset:400, native, hooks: undefined as ReadResult['dialogHooks']};
  const backend = {
    resetRead(){}, dispose(){}, readSession: async (): Promise<ReadResult> => {
      const jsonl = Buffer.from(state.records.map(record=>JSON.stringify(record)+'\n').join('')); state.records = [];
      return {session:{id:session,title:'Question',mapping:'exact',paneId:'%5',status:'waiting'},panePid:42, viewport:state.screen, screen:state.screen,
        nativeStatus:state.native.status, nativeWaitingFor:state.native.waitingFor, active:true, jsonl, reset:false, hasMore:false,
        transcriptPosition:{inode:'7', offset:state.offset}, dialogHooks:state.hooks};
    },
  } as unknown as Backend;
  const answered: unknown[][] = [];
  (backend as any).answerQuestion = async (...args: unknown[]) => { answered.push(args); };
  const controller = new Controller({get:()=>workspace} as unknown as WorkspaceStore, backend);
  const snapshots: SessionSnapshot[] = []; controller.on('snapshot', value => snapshots.push(value));
  const poll = async () => { const internals = controller as any; clearTimeout(internals.timer); await internals.poll(internals.watch); return snapshots.at(-1)!; };
  const questions = [{header:'Drink', question:'Which drink should we serve?', multiSelect:false, options:[{label:'Tea', description:'A warm infusion.'}, {label:'Juice', description:'A cold drink.'}]}];
  const call = {type:'assistant', uuid:'a1', parentUuid:'u1', sessionId:session, message:{id:'m1', role:'assistant', stop_reason:'tool_use',
    content:[{type:'text', text:'Let me ask before I start.'}, {type:'tool_use', id:'toolu_ask', name:'AskUserQuestion', input:{questions}}]}};
  const result = {type:'user', uuid:'r1', parentUuid:'a1', sessionId:session, toolUseResult:{questions, answers:{[questions[0].question]:'Juice'}},
    message:{role:'user', content:[{type:'tool_result', tool_use_id:'toolu_ask', content:'User has answered your questions: "Which drink should we serve?"="Juice".'}]}};
  await controller.watchSession(workspace.id, session);
  const composer = '──────────\n❯ \n──────────';
  return {controller, backend, state, answered, poll, call, result, dialog, multi, composer};
}

test('会话记录还没有这次调用时，Claude Code 在等回答的原屏问答就出卡；调用写入后同一张卡认领它，答完后迟到的画面不再出卡', async () => {
  const {controller, state, answered, poll, call, result, dialog, composer} = await earlyQuestionSession();
  try {
    const card = (await poll()).question!;
    assert.ok(card, 'the question is a card although the transcript has no call for it');
    assert.equal(card.toolUseId, undefined);
    assert.equal(card.question, 'Which drink should we serve?');
    assert.deepEqual(card.options.map(option => option.label), ['Tea', 'Juice', 'Type something.', 'Chat about this']);
    assert.equal((await poll()).question!.token, card.token, 'the same dialog keeps its token');
    // The transcript catches up: the same card (token and identity) now names its call, once.
    state.records = [call]; state.offset = 1300;
    const adopted = await poll();
    assert.deepEqual([adopted.question!.token, adopted.question!.interactionId, adopted.question!.toolUseId], [card.token, card.interactionId, 'toolu_ask']);
    assert.equal(adopted.messages.filter(message => message.tools.some(tool => tool.id === 'toolu_ask')).length, 1);
    await controller.answerQuestion(workspace.id, session, '%5', 42, card.token, {kind:'activate', number:2});
    assert.deepEqual(answered.map(args => [args[5], args[7]]), [[{kind:'activate', number:2}, {inode:'7', offset:1300}]], 'answered at the newer record');
    // Answered: the result arrives while a late frame still shows the dialog. Not a question again.
    state.records = [result]; state.offset = 1700;
    assert.equal((await poll()).question, undefined);
    const late = await poll();
    assert.equal(late.question, undefined, 'still the question that had its call');
    assert.equal(late.permission, undefined, 'nor any other card');
    // Once it has gone, a new question may again come before its call.
    state.screen = composer; await poll();
    state.screen = dialog;
    const next = (await poll()).question!;
    assert.ok(next && next.toolUseId === undefined);
    assert.notEqual(next.interactionId, card.interactionId);
  } finally { await controller.dispose(); }
});

test('用户报告的原屏（2.1.33x 经网关，问题有空行和列表，会话记录还没有调用）出卡，不再只有横幅', async () => {
  const reported = readFileSync(new URL('./fixtures/question-body-2.1.331/reported-120.txt', import.meta.url), 'utf8');
  const {controller, state, poll} = await earlyQuestionSession();
  try {
    state.screen = reported;
    const card = (await poll()).question!;
    assert.ok(card, 'a card while Claude Code waits for "input needed"');
    assert.equal(card.toolUseId, undefined);
    assert.match(card.question!, /影响。\n\n384 abs 30k[^\n]+job。\n\n- Job 名：demo-grad-eval-736rel-20k-736abs-20k（yaml：[^\n]+\n- 镜像：/u);
    assert.deepEqual(card.tabs, [{label:'H200 job', answered:false}]);
    assert.deepEqual(card.options.map(option => [option.number, option.kind]), [[1,'choice'],[2,'choice'],[3,'choice'],[4,'other'],[5,'chat']]);
    // Claude Code not waiting for an answer: the same screen is no card without a call.
    state.native = {status:'busy'};
    assert.equal((await poll()).question, undefined);
  } finally { await controller.dispose(); }
});

test('凭原屏出的问答卡照常作答（绑定读到的会话记录位置）；调用连同回执一起写入后，迟到的画面不再出卡', async () => {
  const {controller, state, answered, poll, call, result, multi, composer} = await earlyQuestionSession();
  try {
    state.screen = multi;
    const first = (await poll()).question!;
    assert.deepEqual(first.tabs.map(tab => tab.label), ['Drink', 'Snacks']);
    await controller.answerQuestion(workspace.id, session, '%5', 42, first.token, {kind:'activate', number:1});
    assert.equal((answered[0][4] as {question: string}).question, 'Which drink should we serve?', 'the driver checks the live screen against this question');
    assert.deepEqual(answered[0][7], {inode:'7', offset:400}, 'and refuses if the transcript moved meanwhile');
    await assert.rejects(controller.answerQuestion(workspace.id, session, '%5', 42, first.token, {kind:'cancel'}), /已更新/, 'a token answers once');
    // The next page of the same questions: a new token on the same card.
    state.screen = multi.replace('☐ Drink', '☒ Drink').replace('Which drink should we serve?', 'Which snacks should we pack?');
    const page = (await poll()).question!;
    assert.notEqual(page.token, first.token);
    assert.equal(page.interactionId, first.interactionId);
    // Claude Code 2.1.300–2.1.330 write a deferred call together with its result once answered; a
    // frame from before the answer is no card, and the answer shows under its call in the chat.
    state.records = [call, result]; state.offset = 2100;
    const late = await poll();
    assert.equal(late.question, undefined);
    assert.equal(late.permission, undefined);
    assert.ok(late.messages.some(message => message.tools.some(tool => tool.id === 'toolu_ask' && tool.result !== undefined)));
    state.screen = composer;
    assert.equal((await poll()).question, undefined);
  } finally { await controller.dispose(); }
});

test('2.1.300 先画多题问答框、约 170 ms 后才写调用：凭原屏的卡片在这期间被点，守卫拒绝后重读、认领调用，同一个回答再发一次', async () => {
  // cc-matrix question-multi on CI (2.1.300, 2.1.310): the click landed while the call was being
  // written; the refusal reissued the card with a new token and the answer was lost.
  const {controller, backend, state, answered, poll, call} = await earlyQuestionSession();
  const multi = readFileSync(new URL('./fixtures/question-early/2.1.300-multi.txt', import.meta.url), 'utf8');
  const snacks = {header:'Snacks', question:'Which snacks should we pack?', multiSelect:true, options:[{label:'Fruit', description:'Fresh fruit.'}, {label:'Bread', description:'Fresh bread.'}]};
  const both = {...call, message:{...call.message, content:[call.message.content[0], {...call.message.content[1],
    input:{questions:[...(call.message.content[1] as {input:{questions:unknown[]}}).input.questions, snacks]}}]}};
  const positions: unknown[] = [];
  let refuse = true;
  (backend as any).answerQuestion = async (...args: unknown[]) => {
    positions.push(args[7]);
    // Claude Code writes the call between the card's read and the keys: nothing is sent.
    if (refuse) { refuse = false; state.records = [both]; state.offset = 1300; throw new TranscriptChangedNoKeys(); }
    answered.push(args);
  };
  try {
    state.screen = multi;
    const card = (await poll()).question!;
    assert.deepEqual([card.toolUseId, card.tabs.map(tab => tab.label), card.question], [undefined, ['Drink', 'Snacks'], 'Which drink should we serve?']);
    await controller.answerQuestion(workspace.id, session, '%5', 42, card.token, {kind:'activate', number:1});
    assert.deepEqual(positions, [{inode:'7', offset:400}, {inode:'7', offset:1300}], 'refused at the old record, sent again at the new one');
    assert.deepEqual(answered.map(args => args[5]), [{kind:'activate', number:1}], 'the same answer, once');
    assert.equal((answered[0][4] as {question:string}).question, 'Which drink should we serve?', 'checked against the same screen');
    // The next page: the card now names the call.
    state.screen = multi.replace('☐ Drink', '☒ Drink').replace('Which drink should we serve?', 'Which snacks should we pack?');
    const page = (await poll()).question!;
    assert.deepEqual([page.toolUseId, page.interactionId, page.question], ['toolu_ask', card.interactionId, 'Which snacks should we pack?']);
    assert.notEqual(page.token, card.token);
  } finally { await controller.dispose(); }
});

test('被拒后重读仍是同一张卡（追加的只是请求、标题等记录）时同一个回答再发一次；问题已答完时不再发，照旧报「未发送」', async () => {
  const notice = {parentUuid:'u1', isSidechain:false, type:'system', subtype:'informational', level:'warning', uuid:'notice', sessionId:session, content:'A notice.'};
  const title = {type:'custom-title', customTitle:'示例问答', sessionId:session};
  // `appended` is what Claude Code writes between the card's read and the keys; `refusals` sends are refused.
  const refusedWith = async (owned: boolean, appended: (s: Awaited<ReturnType<typeof earlyQuestionSession>>) => unknown[], refusals = 1) => {
    const t = await earlyQuestionSession();
    try {
      if (owned) t.state.records = [t.call];
      const card = (await t.poll()).question!;
      assert.equal(card.toolUseId, owned ? 'toolu_ask' : undefined);
      const positions: unknown[] = [];
      (t.backend as any).answerQuestion = async (...args: unknown[]) => {
        positions.push((args[7] as {offset:number}).offset);
        if (positions.length > refusals) return;
        t.state.records = appended(t); t.state.offset += 120; throw new TranscriptChangedNoKeys();
      };
      const outcome = await t.controller.answerQuestion(workspace.id, session, '%5', 42, card.token, {kind:'activate', number:2}).then(() => 'sent', error => error);
      return {outcome, positions, after: (await t.poll()).question, card};
    } finally { await t.controller.dispose(); }
  };
  // Title records after the call, or request records under a card still without its call (the stream
  // ends late): the same card, sent again at the newer record.
  for (const [owned, records] of [[true, [title, notice]], [false, [notice]]] as const) {
    const {outcome, positions} = await refusedWith(owned, () => [...records]);
    assert.deepEqual([outcome, positions], ['sent', [400, 520]], `owned: ${owned}`);
  }
  // Refused twice: reported; nothing was sent, so the card keeps its token for another try.
  const twice = await refusedWith(false, () => [notice], 2);
  assert.ok(twice.outcome instanceof TranscriptChangedNoKeys);
  assert.deepEqual(twice.positions, [400, 520]);
  assert.deepEqual([twice.after?.token, twice.after?.interactionId], [twice.card.token, twice.card.interactionId]);
  // Answered in the terminal meanwhile (its result; or, deferred, the call with its result): never sent again.
  for (const [owned, records] of [[true, (t: Awaited<ReturnType<typeof earlyQuestionSession>>) => [t.result]],
    [false, (t: Awaited<ReturnType<typeof earlyQuestionSession>>) => [t.call, t.result]]] as const) {
    const answered = await refusedWith(owned, records);
    assert.ok(answered.outcome instanceof TranscriptChangedNoKeys, `owned: ${owned}`);
    assert.deepEqual(answered.positions, [400]);
    assert.equal(answered.after, undefined, 'a late frame of the answered question is no card');
  }
});

test('a hook question can resume at the verified focus after its call is appended between Down and Enter', async t => {
  for (const outcome of ['stable', 'still writing', 'focus changed', 'call answered', 'refused again']) await t.test(outcome, async () => {
    const { controller, backend, state, poll, call, result, dialog } = await earlyQuestionSession();
    const input = (call.message.content[1] as { input: { questions: unknown[] } }).input;
    state.hooks = { folder:true, started:{at:1,source:'startup'}, rejected:0, records:[
      {event:'PreToolUse', seq:1, at:1, toolName:'AskUserQuestion', toolUseId:'toolu_ask', input},
    ] };
    const reads: number[] = [], positions: number[] = [], sent: QuestionKey[] = [];
    let refused = false;
    const readSession = backend.readSession.bind(backend);
    backend.readSession = async (...args) => {
      const read = await readSession(...args);
      if (refused) {
        reads.push(read.transcriptPosition!.offset);
        if (reads.length === 1) {
          state.offset = 760;
          state.records = outcome === 'call answered' ? [call, result] : [call];
          if (outcome === 'focus changed') state.screen = dialog;
        } else if (outcome === 'still writing') state.offset += 120;
      }
      return read;
    };
    backend.answerQuestion = async (_workspace, _id, paneId, panePid, expected, action, _runtime, position, check, asked) => {
      positions.push(position!.offset);
      await performQuestionAction({
        frame: async () => ({paneId,panePid,viewport:state.screen,nativeStatus:'waiting',nativeWaitingFor:'input needed'}),
        pasteQuestion: async () => assert.fail('no paste expected'),
        questionKey: async key => {
          if (key === 'Enter' && !refused) {
            refused = true;
            state.offset = 520;
            state.records = [{...call, message:{...call.message, content:[call.message.content[0]]}}];
            throw new TranscriptChangedNoKeys();
          }
          if (key === 'Enter' && outcome === 'refused again') throw new TranscriptChangedNoKeys();
          sent.push(key);
          state.screen = key === 'Down' ? dialog.replace('❯ 1. Tea', '  1. Tea').replace('  2. Juice', '❯ 2. Juice') : chat.screens.composer;
        },
      }, paneId, panePid, expected, action, check, asked);
    };
    try {
      const card = (await poll()).question!;
      assert.equal(card.toolUseId, 'toolu_ask', 'the hook names the call before the transcript does');
      const click = controller.answerQuestion(workspace.id, session, '%5', 42, card.token, {kind:'activate', number:2});
      if (outcome === 'stable') await click;
      else await assert.rejects(click, TranscriptChangedNoKeys);
      const rebind = outcome === 'stable' || outcome === 'refused again';
      assert.deepEqual(positions, rebind ? [400, 760] : [400]);
      assert.deepEqual(sent, outcome === 'stable' ? ['Down', 'Enter'] : ['Down']);
      if (rebind) assert.deepEqual(reads.slice(0,3), [520, 760, 760], 'the reply and call can arrive in different reads');
      if (outcome === 'still writing') assert.deepEqual(reads.slice(0,3), [520, 760, 880]);
    } finally { await controller.dispose(); }
  });
});

test('Claude Code 没在等回答时，没有调用的问答样画面不出卡；代码块里的菜单也不出卡', async () => {
  for (const native of [{}, {status:'idle' as const}, {status:'busy' as const}, {status:'waiting' as const},
    {status:'waiting' as const, waitingFor:'permission prompt'}, {status:'waiting' as const, waitingFor:'dialog open'}]) {
    const {controller, poll} = await earlyQuestionSession(native);
    try {
      const snapshot = await poll();
      assert.equal(snapshot.question, undefined, JSON.stringify(native));
      assert.equal(snapshot.permission, undefined, 'never a generic card either');
    } finally { await controller.dispose(); }
  }
  // A reply that shows such a menu in a code block, even while Claude Code waits for an answer.
  const {controller, state, poll, dialog} = await earlyQuestionSession();
  try {
    const at = dialog.indexOf('────');
    state.screen = dialog.slice(0, at) + '● This is how the question looks:\n```\n' + dialog.slice(at);
    assert.equal((await poll()).question, undefined);
  } finally { await controller.dispose(); }
});

test('with the recording hooks: a question taller than the pane is a card of its call, read with its input; without SessionStart, none', async()=>{
  // The dialog's top is cut off (question-body-2.1.331/cut-off-40-rows): the screen alone has no card.
  const viewport = readFileSync(new URL('./fixtures/question-body-2.1.331/cut-off-40-rows.txt', import.meta.url),'utf8');
  const asked = {questions:[{question:'要提交这个 H200 job 吗？', header:'H200 job', options:[{label:'提交，含 736 abs 20k (Recommended)', description:'一'},
    {label:'提交，只测 736 rel 20k', description:'二'}, {label:'不提交，都在本机跑', description:'三'}]}]};
  const records = [{event:'SessionStart' as const, seq:1, at:1, source:'startup'},
    {event:'PreToolUse' as const, seq:2, at:2, toolName:'AskUserQuestion', toolUseId:'toolu_hook', input:asked}];
  let started = true;
  const answers: unknown[][] = [];
  const backend = {
    resetRead(){}, dispose(){}, readSession: async (): Promise<ReadResult> => ({session:{id:session,title:'Question',mapping:'exact',paneId:'%5'},panePid:42,
      viewport, screen:viewport, nativeStatus:'waiting', nativeWaitingFor:'input needed', active:true, jsonl:Buffer.alloc(0), reset:false, hasMore:false,
      dialogHooks:{folder:true, records, rejected:0, ...started && {started:{at:1, source:'startup'}}}}),
    answerQuestion:async(...args: unknown[])=>{answers.push(args);},
  } as unknown as Backend;
  const controller=new Controller({get:()=>workspace} as unknown as WorkspaceStore, backend);
  try {
    const s=await controller.watchSession(workspace.id,session);
    assert.equal(s.question?.toolUseId,'toolu_hook','the card names its call before the transcript has it');
    assert.equal(s.question?.question,'要提交这个 H200 job 吗？');
    assert.deepEqual(s.question?.options.slice(0,3).map(o=>o.description),['一','二','三']);
    assert.equal(s.dialogHooks?.state,'active');
    await controller.answerQuestion(workspace.id,session,'%5',42,s.question!.token,{kind:'activate',number:2});
    assert.deepEqual(answers[0].at(-1), [{question:'要提交这个 H200 job 吗？', header:'H200 job', multiSelect:false, options:asked.questions[0].options}],
      'the driver reads the frames with the same input');
    started = false;
    const next=(await once(controller,'snapshot'))[0] as SessionSnapshot;
    assert.equal(next.question,undefined,'no SessionStart: the screen alone, which cannot read it');
  } finally {await controller.dispose();}
});

test('with the recording hooks: a permission dialog shows the call\'s whole input, and reads by its bottom when its top is cut off', async()=>{
  const bash = readFileSync(new URL('./fixtures/permission-2.1.328/bash.txt', import.meta.url),'utf8');
  const input = {command:'echo hello > greeting.txt && ls', description:'Write a greeting file'};
  let viewport = bash;
  const records = [{event:'SessionStart' as const, seq:1, at:1, source:'startup'}, {event:'PermissionRequest' as const, seq:2, at:2, toolName:'Bash', input}];
  const calls: unknown[][] = [];
  const backend = {
    resetRead(){}, dispose(){}, readSession: async (): Promise<ReadResult> => ({session:{id:session,title:'Permission',mapping:'exact',paneId:'%5'},panePid:42,
      viewport, screen:viewport, nativeStatus:'waiting', nativeWaitingFor:'permission prompt', active:true, jsonl:Buffer.alloc(0), reset:false, hasMore:false,
      dialogHooks:{folder:true, records, rejected:0, started:{at:1, source:'startup'}}}),
    answerPermission:async(...args: unknown[])=>{calls.push(args);},
  } as unknown as Backend;
  const controller=new Controller({get:()=>workspace} as unknown as WorkspaceStore, backend);
  try {
    const s=await controller.watchSession(workspace.id,session);
    assert.equal(s.permission?.title,'Bash command');
    assert.deepEqual(s.permission?.call,{toolName:'Bash', input});
    assert.equal(s.permission?.toolUseId,undefined,'no call yet: Claude Code writes it later');
    viewport = bash.split('\n').slice(16).join('\n');
    const cut=(await once(controller,'snapshot'))[0] as SessionSnapshot;
    assert.equal(cut.permission?.title,'Bash');
    assert.deepEqual(cut.permission?.options.map(o=>o.number),[1,2,3]);
    await controller.answerPermission(workspace.id,session,'%5',42,cut.permission!.token,{kind:'choose',number:1});
    assert.deepEqual(calls[0].at(-1),{toolName:'Bash', input},'the driver reads the frames with the same call');
  } finally {await controller.dispose();}
});
