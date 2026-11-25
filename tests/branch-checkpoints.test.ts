import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

const nativeFrame = (name: string) => readFileSync(new URL(`./fixtures/rewind-model-switch-2.1.330/${name}.ansi`, import.meta.url), 'utf8');
const batchPage = (focus: number, labels = prompts) => page(0, [...labels, '(current)'], 0, focus);
function batchDriver(pairs: number[][], retries: number[][] = [], entries = prompts) {
  let viewport = nativeFrame('idle');
  const calls: (string | [string, number])[] = [];
  const frame = () => ({ paneId: '%1', panePid: 7, viewport });
  const observe = (pair: number[]) => {
    viewport = pair[1] === -1 ? batchPage(2, ['first', 'wrong', 'repeat', 'last']) : batchPage(pair[1], entries);
    return { ...frame(), earlierViewport: batchPage(pair[0], entries) };
  };
  const driver: TurnDriver = {
    frame: async () => frame(),
    pasteForTurn: async () => { viewport = nativeFrame('rewind-typed'); return frame(); },
    keyForTurn: async key => {
      calls.push(key);
      if (key === 'submit') viewport = batchPage(entries.length, entries);
      if (key === 'accept') {
        assert.equal(readRewind(viewport)?.focused, 2, 'confirm the second identical label');
        viewport = confirmation;
      }
      if (key === 'close') viewport = nativeFrame('idle');
      return frame();
    },
    rewindBatch: {
      move: async (key, count) => { calls.push([key, count]); return observe(pairs.shift()!); },
      observe: async () => { calls.push('observe'); return observe(retries.shift()!); },
    },
  };
  return { calls, run: () => performTurnAction(driver, '%1', 7, { kind: 'rewindTo', uuid: 'repeat-2' }, { index: 2, prompts: entries }) };
}

test('waits for the last buffered key before choosing a duplicate by ordinal', async () => {
  const { calls, run } = batchDriver([[4,3]], [[3,2], [2,2]]);
  await run();
  assert.deepEqual(calls, ['submit', ['up',2], 'observe', 'observe', 'accept']);
});

test('a stable short move is corrected; a stable overshoot reverses direction', async () => {
  const short = batchDriver([[3,3], [2,2]], [[3,3]]);
  await short.run();
  assert.deepEqual(short.calls, ['submit', ['up',2], 'observe', ['up',1], 'accept']);
  const overshot = batchDriver([[1,1], [2,2]], [[1,1]]);
  await overshot.run();
  assert.deepEqual(overshot.calls, ['submit', ['up',2], 'observe', ['down',1], 'accept']);
});

test('a brief pause at a partial landing does not make the next batch overshoot', async () => {
  const { calls, run } = batchDriver([[3,3]], [[3,2], [2,2]]);
  await run();
  assert.deepEqual(calls, ['submit', ['up',2], 'observe', 'observe', 'accept']);
});

test('a changed list aborts before another batch or Enter', async () => {
  const { calls, run } = batchDriver([[3,-1]]);
  await assert.rejects(run(), /对齐/);
  assert.deepEqual(calls, ['submit', ['up',2], 'close']);
});

test('no progress after the bounded corrections closes the menu', async () => {
  const slots = () => [[4,4], [4,4], [4,4], [4,4]];
  const { calls, run } = batchDriver(slots(), slots());
  await assert.rejects(run(), /对齐/);
  assert.deepEqual(calls, ['submit', ['up',2], 'observe', ['up',2], 'observe', ['up',2], 'observe', ['up',2], 'observe', 'close']);
});

test('long moves are capped at 50 keys and verify each intermediate page', async () => {
  const entries = [...prompts, ...Array.from({length: 101}, (_, i) => 'Fixture prompt ' + i)];
  const { calls, run } = batchDriver([[55,55], [5,5], [2,2]], [], entries);
  await run();
  assert.deepEqual(calls, ['submit', ['up',50], ['up',50], ['up',3], 'accept']);
});

test('restore batches the move to Restore conversation and verifies the exact confirmation layout', async () => {
  let viewport = confirmation;
  const calls: unknown[] = [];
  const frame = () => ({ paneId: '%1', panePid: 7, viewport });
  const driver: TurnDriver = {
    frame: async () => frame(),
    pasteForTurn: async () => assert.fail(),
    keyForTurn: async key => {
      calls.push(key);
      viewport = draft([], 'repeat');
      return frame();
    },
    rewindBatch: {
      move: async (key, count) => {
        calls.push([key, count]);
        viewport = confirmation.replace('❯ 1.', '  1.').replace('  2.', '❯ 2.');
        return { ...frame(), earlierViewport: viewport };
      },
      observe: async () => assert.fail(),
    },
  };
  const result = await performTurnAction(driver, '%1', 7, { kind: 'restore', signature: readRewind(confirmation)!.signature });
  assert.deepEqual(calls, [['down',1], 'accept']);
  assert.equal(result?.restoredDraft, 'repeat');
});
