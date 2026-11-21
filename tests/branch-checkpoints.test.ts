import test from 'node:test';
import assert from 'node:assert/strict';
import { forkCapability, forkReceipt, hasForkLineage } from '../src/backend/native-fork';
import { checkpointPosition, performTurnAction, type TurnDriver } from '../src/backend/native-turn-controls';
import { readRewind } from '../src/core/turn-controls';

const border = '──────────────────────────────';
const draft = (rows: string[], command: string) => [...rows, border, '❯ '+command, border,'  ? for shortcuts'].join('\n');
test('only an adjacent focused native completion proves which slash command changes identity', () => {
  const branch = '  ❯ /fork                  Fork the current conversation at this point';
  const background = '  ❯ /fork                  Copy this conversation into a new background session and keep working here';
  assert.equal(forkCapability(draft([branch],'/fork'),'/fork'),'branch');
  assert.equal(forkCapability(draft([branch,'',background],'/fork'),'/fork'),'background');
  assert.equal(forkCapability(draft([branch,'regular prose'], '/fork'),'/fork'),undefined);
  assert.equal(forkCapability(draft([branch], '/branch'),'/branch'),undefined);
  assert.equal(forkCapability(draft([branch, background], '/fork'),'/fork'),undefined);
  assert.equal(forkCapability(draft([background.replace('Copy this', 'Do not copy this')],'/fork'),'/fork'),undefined);
});
test('fork proof ties the command receipt and copied row to both UUIDs', () => {
  const view = '❯ /branch\n  ⎿  Branched session. You\'re now in the new one (new). Back to the original: /resume\n    old, or claude -r old in a new terminal.';
  assert.equal(forkReceipt(view,'old','new'),true);
  assert.equal(forkReceipt(view,'other','new'),false);
  const original = '00000000-0000-4000-8000-000000000001';
  const proof = {type:'user',sessionId:'new',uuid:'m1',forkedFrom:{sessionId:original,messageUuid:'m1'}};
  const parse = (row: object) => hasForkLineage(Buffer.from(JSON.stringify(row)+'\n'),original,'new');
  assert.equal(parse(proof),true);
  for(const patch of [{isSidechain:true},{type:'progress'},{sessionId:'old'},{uuid:'different'}]) assert.equal(parse({...proof,...patch}),false);
});
const prompts=['first','repeat','repeat','last'];
const page = (before:number, labels:string[], after:number, focus:number) => [border, '   Rewind', '', '   Restore the code and/or conversation to the point before…','',
  ...(before ? ['     ↑ '+before+' more']:[]), ...labels.flatMap((label,i) => [(i===focus?'   ❯ ':'     ')+label,...(label==='(current)'?[]:['     No code changes']),'']),
  ...(after ? ['     ↓ '+after+' more','']:[]),'   Enter to continue · Esc to cancel',''].join('\n');
const confirmation = [border,'   Rewind','','   Restore to the point before you sent this message:','','   │ repeat','   │ (2h ago)','','   The conversation goes back to before this message.','','   ❯ 1. Restore code and conversation','     2. Restore conversation','     3. Restore code','     4. Never mind'].join('\n');
test('native overflow counters include current, and ordinals distinguish identical prompts even across pages', () => {
  const m=readRewind(page(1,['repeat','repeat','last'],1,1))!;
  assert.equal(m.before,1); assert.equal(m.after,1); assert.equal(checkpointPosition(m,{index:2,prompts}),2);
  assert.throws(()=>checkpointPosition(m,{index:2,prompts:['repeat','repeat','last']}),/对齐/);
  assert.throws(()=>checkpointPosition(m,{index:2,prompts:['first','different','repeat','last']}),/对齐/);
});
test('external move to the identical neighbouring confirmation never confirms any restore option',async()=>{
  let view=confirmation;
  const keys:string[]=[];
  const driver:TurnDriver={frame:async()=>({viewport:view,paneId:'%1',panePid:7}),pasteForTurn:async()=>assert.fail(),
    keyForTurn:async key=>{keys.push(key);view=page(1,['repeat','repeat','last'],1,0);}};
  await assert.rejects(performTurnAction(driver,'%1',7,{kind:'restore',signature:readRewind(confirmation)!.signature}, {index:2,prompts}),/对齐/);
  assert.deepEqual(keys,['cancel']);
});
