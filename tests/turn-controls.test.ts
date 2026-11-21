import test from 'node:test';
import assert from 'node:assert/strict';
import { canInterruptTurn, readRewind, turnComposer } from '../src/core/turn-controls';
import { performTurnAction, type TurnDriver } from '../src/backend/native-turn-controls';
import { MessageDisplay } from '../src/core/message-display';
import { parseNativeKeybindings } from '../src/backend/native-keybindings';
const ruler = '────────────────────────';
const editor = (text = '',working = false) => [ruler,'❯ '+text,ruler,working ? '  ⏸ manual mode on · esc to interrupt' : '  ⏸ manual mode on',''].join('\n');
const page = (focused: number, indent: number) => [ruler,' '.repeat(indent)+'Rewind','',' '.repeat(indent)+'Restore the code and/or conversation to the point before…','',
  ...['First message','Second message','(current)'].flatMap((m,i)=>[' '.repeat(indent)+(i===focused?'❯ ':'  ')+m,...(i<2?[' '.repeat(indent+2)+'No code changes']:[]),'']),
  ' '.repeat(indent)+'Enter to continue · Esc to cancel',''].join('\n');
const confirm = (focused: number) => [ruler,'   Rewind','','   Restore to the point before you sent this message:','','   │ Second message','   │ (3m ago)','',
  '   The conversation goes back to before this message.','   The code will be unchanged.','',
  ...['Restore code and conversation','Restore conversation','Restore code','Summarize from here','Summarize up to here','Never mind'].map((s,i)=>(i===focused?'   ❯ ':'     ')+(i+1)+'. '+s),''].join('\n');

test('native rewind parser uses the real menu gutter and rejects old transcript menus under the editor', () => {
  for (const indent of [2,3]) assert.equal(readRewind(page(2,indent))?.focused,2);
  assert.equal(readRewind(page(2,3)+editor()),undefined);
  assert.equal(readRewind(confirm(1))?.message,'Second message');
  assert.equal(readRewind(confirm(1)+'\nDo you want to proceed?\n❯ 1. Yes'),undefined);
});
test('Ctrl+X prefix and action remaps prevent queue/steer input',() => {
  const permits = (bindings: Record<string,unknown>) => parseNativeKeybindings(JSON.stringify({bindings:[{context:'Chat',bindings}]}))!;
  assert.ok(permits({})('ctrl+x ctrl+s',['Chat']));
  assert.equal(permits({'ctrl+x':'some:action'})('ctrl+x ctrl+s',['Chat']),false);
  assert.equal(permits({'ctrl+x enter':null})('ctrl+x enter',['Chat']),false);
  assert.equal(permits({'ctrl+x ctrl+s':'chat:queueSubmit'})('ctrl+x ctrl+s',['Chat']),false);
});
test('steer verifies the exact pasted draft and stops when a permission dialog replaces the editor', async () => {
  let viewport = editor('',true), nativeStatus='busy';
  const keys: string[] = [];
  const driver: TurnDriver = {
    frame: async () => ({paneId:'%9',panePid:21,viewport,nativeStatus}),
    pasteForTurn: async () => { viewport = 'Do you want to proceed?\n❯ 1. Yes';nativeStatus='waiting'; },
    keyForTurn: async key => { keys.push(key); },
  };
  await assert.rejects(performTurnAction(driver,'%9',22,{kind:'stop'}),/终端已变化/);
  await assert.rejects(performTurnAction(driver,'%9',21,{kind:'steer',text:'a correction'}),/尚未确认/);
  assert.deepEqual(keys,[]);
});
test('stop follows native activity independently of the empty queue editor and its footer', async () => {
  const spinner = '✻ Thinking… (esc to interrupt)\n';
  for (const [viewport, nativeStatus] of [
    [spinner + editor(), undefined], [editor('未发送的草稿'), 'busy'], ['正在执行工具', 'busy'], [editor('', true), undefined],
  ] as const) {
    const keys: string[] = [];
    const driver: TurnDriver = {
      frame: async () => ({ paneId: '%9', panePid: 21, viewport: keys.length ? editor() : viewport, nativeStatus: keys.length ? 'idle' : nativeStatus }),
      keyForTurn: async key => { keys.push(key); }, pasteForTurn: async () => assert.fail('中断不应粘贴文本'),
    };
    assert.equal(canInterruptTurn(viewport, nativeStatus), true);
    await performTurnAction(driver, '%9', 21, { kind: 'stop' });
    assert.deepEqual(keys, ['stop']);
  }
  for (const [viewport, nativeStatus] of [
    [editor(), 'idle'], [editor('', true), 'waiting'], [spinner + editor(), 'shell'],
    ['Permission required\n❯ 1. Yes', 'busy'], [confirm(1), 'busy'], ['Select model\nEnter to confirm · Esc to cancel', 'busy'],
    ['● 这段文字提到了 esc to interrupt\n' + editor(), undefined],
    // After the reply, waiting for background subagents (Claude Code 2.1.328 stays busy).
    ['✻ Waiting for 1 background agent to finish\n' + editor(), 'busy'],
  ] as const) {
    assert.equal(canInterruptTurn(viewport, nativeStatus), false);
    const driver: TurnDriver = { frame: async () => ({ paneId: '%9', panePid: 21, viewport, nativeStatus }),
      keyForTurn: async () => assert.fail('不应向空闲会话或待确认菜单发送 Escape'), pasteForTurn: async () => assert.fail() };
    await assert.rejects(performTurnAction(driver, '%9', 21, { kind: 'stop' }), /已变化/);
  }
});

test('restore navigates past code restoration and accepts only the explicit conversation choice',async () => {
  let view = confirm(0);
  const keys: string[]=[];
  const driver:TurnDriver={
    frame:async()=>({paneId:'%9',panePid:21,viewport:view}),
    keyForTurn:async key=>{keys.push(key);view=key==='down'?confirm(1):editor('Second message');},
    pasteForTurn:async()=>assert.fail('no paste expected'),
  };
  await assert.rejects(performTurnAction(driver,'%9',21,{kind:'restore',signature:readRewind(confirm(2))!.signature}),/已变化/);
  await assert.rejects(performTurnAction(driver,'%9',21,{kind:'unknown',signature:readRewind(view)!.signature,index:0} as never),/已变化/);
  const result=await performTurnAction(driver,'%9',21,{kind:'restore',signature:readRewind(view)!.signature});
  assert.deepEqual(keys,['down','accept']);
  assert.equal(result?.restoredDraft,'Second message');
});
test('queued messages at a tool boundary project in order, distinguish duplicate inputs and survive replay',() => {
  const display=new MessageDisplay('S');
  const row=(data:object)=>JSON.stringify({sessionId:'S',...data})+'\n';
  const prompt=(id:string,parent:string|null,text:string)=>row({type:'user',uuid:id,parentUuid:parent,message:{content:text}});
  const enqueue=(text:string)=>row({type:'queue-operation',operation:'enqueue',content:text});
  const absorbed=(id:string,parent:string,text:string)=>row({type:'attachment',uuid:id,parentUuid:parent,attachment:{type:'queued_command',prompt:text,humanTurn:true,commandMode:'prompt',origin:{kind:'human'}}});
  display.ingestJsonl(prompt('a',null,'old')+enqueue('alpha')+enqueue('alpha'));
  assert.deepEqual(display.nativeQueue(['old','alpha','alpha']),['alpha','alpha']);
  display.ingestJsonl(absorbed('b','a','alpha')+absorbed('c','b','alpha'));
  const messages=()=>display.getMessages().filter(x=>x.role==='user').map(x=>x.text);
  assert.deepEqual(messages(),['old','alpha','alpha']);
  const menu=readRewind(page(2,3))!;
  menu.rows=[{label:'old'},{label:'alpha'},{label:'alpha'},{label:'(current)'}];
  assert.equal(display.checkpointUuid(menu,2),'c');
  display.confirmNativeRewind('alpha','c');
  assert.deepEqual(messages(),['old','alpha']);
  display.ingestJsonl(prompt('d','b','replacement'));
  assert.deepEqual(messages(),['old','alpha','replacement']);
});
test('working input requires a boxed composer and its interrupt footer; an earlier example is inert',()=> {
  assert.equal(turnComposer(editor('',true))?.running,true);
  assert.equal(turnComposer(editor('',true)+'\nPermission required\n❯ 1. Yes')?.running,undefined);
  assert.equal(turnComposer('esc to interrupt\n'+editor(''))?.running,false);
});
