import assert from 'node:assert/strict';
import test from 'node:test';
import { guardScreenshots, RETRIES } from '../scripts/fixtures/electron.mjs';

const NO_FRAME = 'page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot\nCall log:\n  - taking page screenshot';

/** A page and locator whose screenshots fail with the given errors first (classes are fresh per test:
 * the guard patches prototypes once). */
function fakes(failures: (string | undefined)[]) {
  const calls: unknown[][] = [], frames: string[] = [];
  const attempt = (args: unknown[], who: string) => {
    calls.push([who, ...args]);
    const failure = failures.shift();
    if (failure) return Promise.reject(new Error(failure));
    return Promise.resolve(Buffer.from(`png from ${who}`));
  };
  class FakeLocator {
    constructor(private readonly owner: FakePage) {}
    page() { return this.owner; }
    screenshot(...args: unknown[]) { return attempt(args, 'locator'); }
  }
  class FakePage {
    locator() { return new FakeLocator(this); }
    evaluate() { frames.push('frame'); return Promise.resolve(); }
    screenshot(...args: unknown[]) { return attempt(args, 'page'); }
  }
  const page = guardScreenshots(new FakePage());
  return { page, calls, frames };
}

test('a screenshot that meets "Unable to capture screenshot" waits for frames and is taken again', async t => {
  const logged = t.mock.method(console, 'error', () => {});
  const { page, calls, frames } = fakes([NO_FRAME, NO_FRAME]);
  const options = { path: '/tmp/x.png' };
  assert.equal(String(await page.screenshot(options)), 'png from page');
  assert.deepEqual(calls, [['page', options], ['page', options], ['page', options]], 'the same arguments every time');
  assert.equal(frames.length, 2, 'waits for the page to draw before each retry');
  assert.equal(logged.mock.callCount(), 2);
  assert.match(String(logged.mock.calls[0].arguments[0]), /^\[screenshot\] .*Unable to capture screenshot; retry 1\/3/);
});

test('a screenshot that works the first time is taken once, without waiting', async t => {
  const logged = t.mock.method(console, 'error', () => {});
  const { page, calls, frames } = fakes([]);
  await page.screenshot();
  assert.equal(calls.length, 1);
  assert.equal(frames.length, 0);
  assert.equal(logged.mock.callCount(), 0);
});

test('it gives up after RETRIES retries and throws the last error', async t => {
  t.mock.method(console, 'error', () => {});
  const { page, calls } = fakes(Array(RETRIES + 1).fill(NO_FRAME));
  await assert.rejects(page.screenshot(), /Unable to capture screenshot/);
  assert.equal(calls.length, RETRIES + 1);
});

test('other errors are not retried', async t => {
  const logged = t.mock.method(console, 'error', () => {});
  const { page, calls } = fakes(['page.screenshot: Timeout 20000ms exceeded.']);
  await assert.rejects(page.screenshot(), /Timeout 20000ms exceeded/);
  assert.equal(calls.length, 1);
  assert.equal(logged.mock.callCount(), 0);
});

test('locator screenshots are guarded too and wait on their page', async t => {
  t.mock.method(console, 'error', () => {});
  const { page, calls, frames } = fakes([NO_FRAME]);
  assert.equal(String(await page.locator().screenshot({ path: '/tmp/y.png' })), 'png from locator');
  assert.deepEqual(calls.map(call => call[0]), ['locator', 'locator']);
  assert.equal(frames.length, 1);
});
