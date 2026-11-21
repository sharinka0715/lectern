import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultChatLayout, loadDesktopState } from '../src/renderer/desktop-state';

const read = (json: string | null) => loadDesktopState({ getItem: () => json });
const layout = ({ chatLineHeight, composerLineHeight, toolSummaryFontSize, conversationWidth }: typeof defaultChatLayout) =>
  ({ chatLineHeight, composerLineHeight, toolSummaryFontSize, conversationWidth });

test('new or unreadable desktop storage uses the compact chat defaults', () => {
  for (const raw of [null, 'null', 'not json']) assert.deepEqual(layout(read(raw)), defaultChatLayout);
  assert.deepEqual(layout(loadDesktopState({ getItem: () => { throw new Error('Unavailable'); } })), defaultChatLayout);
});

test('missing layout settings take their defaults without changing other preferences', () => {
  const previous = { theme: 'dark', split: true, fontSize: 16, composerMaxLines: 14, replyDetail: 'individual' };
  const state = read(JSON.stringify(previous));
  assert.deepEqual(layout(state), defaultChatLayout);
  assert.equal(state.fontSize, previous.fontSize);
  assert.equal(state.theme, previous.theme);
  assert.equal(state.replyDetail, previous.replyDetail);
  assert.equal(state.composerMaxLines, previous.composerMaxLines);
  assert.equal(state.split, previous.split);
});

test('历史读取大小沿用有效设置，缺省和无效值使用 3 MiB', () => {
  for (const raw of [null, '{}', '{"historyPageMiB":0}', '{"historyPageMiB":500}', '{"historyPageMiB":"5"}']) {
    assert.equal(read(raw).historyPageMiB, 3);
  }
  for (const size of [0.125, 1.5, 5, 32]) assert.equal(read(JSON.stringify({ historyPageMiB: size })).historyPageMiB, size);
});

test('cache and quota visibility persist independently and default to shown', () => {
  assert.equal(read('{}').showCacheTtl, true);
  assert.equal(read('{}').showSubscriptionQuota, true);
  const onlyCache = read('{"showSubscriptionQuota":false}');
  assert.equal(onlyCache.showCacheTtl, true);
  assert.equal(onlyCache.showSubscriptionQuota, false);
  const onlyQuota = read('{"showCacheTtl":false}');
  assert.equal(onlyQuota.showCacheTtl, false);
  assert.equal(onlyQuota.showSubscriptionQuota, true);
});

test('saved layout choices are independent, bounded and aligned with the sliders', () => {
  const custom = { chatLineHeight: 160, composerLineHeight: 125, toolSummaryFontSize: 17, conversationWidth: 1060 };
  assert.deepEqual(layout(read(JSON.stringify(custom))), custom);
  const raw = '{"chatLineHeight":1e999,"composerLineHeight":153,"toolSummaryFontSize":-1,"conversationWidth":5000}';
  assert.deepEqual(layout(read(raw)), { chatLineHeight: defaultChatLayout.chatLineHeight, composerLineHeight: 155, toolSummaryFontSize: 11, conversationWidth: 1200 });
  const partial = { chatLineHeight: '160', composerLineHeight: 170, conversationWidth: null };
  assert.deepEqual(layout(read(JSON.stringify(partial))), { ...defaultChatLayout, composerLineHeight: 170 });
});

test('the message box grows to ten lines by default; the choice is bounded to whole lines', () => {
  assert.equal(read('{}').composerMaxLines, 10);
  for (const [saved, expected] of [[4, 4], [12.4, 12], [1, 3], [99, 30], ['20', 10]] as const)
    assert.equal(read(JSON.stringify({ composerMaxLines: saved })).composerMaxLines, expected, String(saved));
});

test('the text column defaults to 1000 px; a saved width stays', () => {
  assert.equal(defaultChatLayout.conversationWidth, 1000);
  assert.equal(read('{"conversationWidth":800}').conversationWidth, 800);
  assert.equal(read('{"conversationWidth":720}').conversationWidth, 800, 'the narrowest column is 800 px');
  assert.equal(read('{"conversationWidth":1100}').conversationWidth, 1100);
});

test('the chat line height defaults to 130%; a saved height stays', () => {
  assert.equal(defaultChatLayout.chatLineHeight, 130);
  assert.equal(read('{"chatLineHeight":145}').chatLineHeight, 145);
  assert.equal(read('{"chatLineHeight":160}').chatLineHeight, 160);
});
