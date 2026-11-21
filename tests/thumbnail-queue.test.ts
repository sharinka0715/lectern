import assert from 'node:assert/strict';
import test from 'node:test';
import { createThumbnailQueue } from '../src/renderer/thumbnail-queue';

test('文字绘制后最多同时取两张缩略图，已滚走或已卸载的等待项不发请求', async () => {
  const frames: (() => void)[] = [], started: number[] = [], finish: (() => void)[] = [];
  const queue = createThumbnailQueue(drain => frames.push(drain));
  function add(id: number) { return queue(() => new Promise<void>(done => { started.push(id); finish.push(done); })); }
  add(1); add(2); const offscreen = add(3); add(4); const unmounted = add(5);
  assert.deepEqual(started, []);
  assert.equal(frames.length, 1);
  frames.shift()!();
  assert.deepEqual(started, [1, 2]);
  offscreen(); unmounted(); finish.shift()!(); await Promise.resolve();
  assert.deepEqual(started, [1, 2]);
  frames.shift()!();
  assert.deepEqual(started, [1, 2, 4]);
  finish.forEach(done => done()); await Promise.resolve();
  assert.equal(frames.length, 0);
});
