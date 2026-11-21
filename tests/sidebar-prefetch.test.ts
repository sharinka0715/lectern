import test from 'node:test';
import assert from 'node:assert/strict';
import { HoverPrefetch } from '../src/renderer/sidebar-prefetch';

const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('resting on a row prefetches it once; sweeping past rows prefetches nothing', async () => {
  const calls: string[] = [];
  let clock = 0;
  const hover = new HoverPrefetch((w, s) => calls.push(`${w}/${s}`), 30, 1000, () => clock);
  for (const id of ['a', 'b', 'c']) { hover.point('w', id); await settle(5); }
  hover.leave();
  await settle(60);
  assert.deepEqual(calls, [], 'a quick sweep reads nothing');
  hover.point('w', 'd');
  await settle(60);
  assert.deepEqual(calls, ['w/d']);
  hover.point('w', 'd');
  await settle(60);
  assert.deepEqual(calls, ['w/d'], 'not again right away');
  clock += 1500;
  hover.point('w', 'd');
  await settle(60);
  assert.deepEqual(calls, ['w/d', 'w/d'], 'again after the repeat interval');
  hover.point('w', 'e'); hover.point('other', 'e');
  await settle(60);
  assert.deepEqual(calls.slice(2), ['other/e'], 'moving to another row cancels the previous one');
});
