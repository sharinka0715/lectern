import assert from 'node:assert/strict';
import test from 'node:test';
import { externalLinkUrl, routeExternalLinks } from '../src/main/external-links';

type OpenHandler = (details: { url: string }) => { action: string };
type NavigateListener = (event: { preventDefault(): void }, url: string) => void;

// A stand-in for the window's WebContents: records the handlers the app installs.
function fakeContents(pageUrl: string) {
  let openHandler: OpenHandler | undefined;
  let navigate: NavigateListener | undefined;
  const contents = {
    getURL: () => pageUrl,
    setWindowOpenHandler: (handler: OpenHandler) => { openHandler = handler; },
    on: (event: string, listener: NavigateListener) => { if (event === 'will-navigate') navigate = listener; return contents; },
  };
  const opened: string[] = [];
  routeExternalLinks(contents as unknown as Parameters<typeof routeExternalLinks>[0], url => opened.push(url));
  return {
    opened,
    openWindow: (url: string) => openHandler!({ url }),
    navigate(url: string) { let prevented = false; navigate!({ preventDefault: () => { prevented = true; } }, url); return prevented; },
  };
}

test('only http(s) links are handed to the system browser', () => {
  assert.equal(externalLinkUrl('https://github.com/settings/personal-access-tokens/new'), 'https://github.com/settings/personal-access-tokens/new');
  assert.equal(externalLinkUrl('http://example.com/a b?q=1#x'), 'http://example.com/a%20b?q=1#x');
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'mailto:dev@example.com', 'lectern://x', 'not a url', ''])
    assert.equal(externalLinkUrl(url), undefined, url);
});

test('a target=_blank link opens in the browser and never opens a window', () => {
  const page = fakeContents('file:///app/dist/renderer/index.html');
  assert.deepEqual(page.openWindow('https://example.com/docs'), { action: 'deny' });
  assert.deepEqual(page.openWindow('file:///etc/hosts'), { action: 'deny' });
  assert.deepEqual(page.opened, ['https://example.com/docs']);
});

test('a plain link click keeps the window on the app and opens the browser', () => {
  const page = fakeContents('file:///app/dist/renderer/index.html');
  assert.equal(page.navigate('https://example.com/plain'), true);
  assert.equal(page.navigate('file:///etc/hosts'), true);
  assert.deepEqual(page.opened, ['https://example.com/plain']);
});

test('navigating within the dev server page is blocked without opening a browser', () => {
  const page = fakeContents('http://localhost:5173/index.html');
  assert.equal(page.navigate('http://localhost:5173/other'), true);
  assert.equal(page.navigate('https://example.com/'), true);
  assert.deepEqual(page.opened, ['https://example.com/']);
});
