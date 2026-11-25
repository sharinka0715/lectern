import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAX_TEXT_EDITS, TEXT_FADE_MS, alignShown, alignWork, graphemeEdge, planTextFades, visibleOffsets, visibleText, type Fading } from '../src/renderer/text-fade';

// What fades when the visible text went from `before` to `after` (both as rendered, whitespace and all).
const fresh = (before: string, after: string, fading: Fading[] = [], now = 1000) => {
  const next = visibleText(after);
  return planTextFades(visibleText(before), next, fading, now).filter(fade => fade.at === now).map(fade => next.slice(fade.from, fade.to));
};

test('text grown at the end: only the new characters fade, from now', () => {
  assert.deepEqual(fresh('这段回复正通过 tmux 抓屏显示。', '这段回复正通过 tmux 抓屏显示。模型请求、登录状态'), ['模型请求、登录状态']);
  assert.deepEqual(planTextFades('abc', 'abcdef', [], 500), [{ from: 3, to: 6, at: 500 }]);
  assert.deepEqual(fresh('', 'first words'), ['firstwords'], 'a reply with nothing shown before: all of it (a block fade covers it in the page)');
});

test('the same text again (a preview replaced by the saved reply, re-rendered) fades nothing', () => {
  const reply = '你好！这是运行在真实 tmux 中的离线模拟会话。\n\n中文与 emoji 🧭 都会完整保留。';
  assert.deepEqual(fresh(reply, reply), []);
  // The terminal wrapped the preview's lines and dropped a variation selector; the saved text has neither.
  assert.deepEqual(fresh('中文与 emoji ❤ 都会\n完整保留。', '中文与 emoji ❤\ufe0f 都会完整保留。'), []);
  assert.deepEqual(fresh('a  b\tc\u200b d', 'a b c d'), [], 'whitespace and invisible characters do not count');
});

test('Markdown parsed again into another structure: what was shown stays, only the new characters fade', () => {
  // `**bold` shown literally until its closing `**` arrives with more text.
  assert.deepEqual(fresh('管理。**落盘', '管理。落盘后，正文会在同一'), ['后，正文会在同一']);
  // A table forms: its header row was a paragraph of pipes.
  assert.deepEqual(fresh('结果：| 列 A | 列 B |', '结果：列 A列 B1值 1'), ['1值1']);
  // A paragraph becomes a list item (the marker is not text), a code fence closes.
  assert.deepEqual(fresh('步骤\n\n- 第一步', '步骤\n第一步\n第二步'), ['第二步']);
  assert.deepEqual(fresh('tmux capture-pane -p\n```', 'tmux capture-pane -p -J'), ['-J']);
  // A link: its target disappears once the closing parenthesis arrives. The text shown stays; letters
  // of the vanished address may stand in for the same letters of the new word (`h`, `e` of "here"),
  // which then show without a fade: a few letters too few, never one too many.
  const linked = fresh('see [the docs](https://exa', 'see the docs here').join('');
  assert.ok(linked.length >= 2 && 'here'.endsWith(linked), linked);
});

test('text rewritten in the middle or taken back: the new characters fade, the kept ones do not', () => {
  assert.deepEqual(fresh('hello world', 'hello brave world'), ['brave']);
  assert.deepEqual(fresh('abcdef', 'abc'), [], 'taken back: nothing new');
  assert.deepEqual(fresh('abcdef', 'abcxy'), ['xy'], 'taken back and written again');
  assert.deepEqual(fresh('第一句。第二句', '第一句。改写的第二句'), ['改写的']);
});

test('a fade still running goes on where its characters are now; one that ended or whose text went does not', () => {
  const running: Fading = { from: 3, to: 6, at: 900 }, over: Fading = { from: 0, to: 3, at: 1000 - TEXT_FADE_MS };
  // Text added after it: it goes on from its own start, the new text fades from now.
  assert.deepEqual(planTextFades('abcdef', 'abcdefgh', [over, running], 1000), [{ from: 3, to: 6, at: 900 }, { from: 6, to: 8, at: 1000 }]);
  // The CSS delay is written in whole milliseconds.
  assert.deepEqual(planTextFades('abcdef', 'abcdef', [over], 999.4), [over]);
  assert.deepEqual(planTextFades('abcdef', 'abcdef', [over], 999.8), []);
  // Markup removed before it moves it back; characters of it removed drop out.
  assert.deepEqual(planTextFades('**xyzw', 'xyzw!', [{ from: 2, to: 6, at: 950 }], 1000), [{ from: 0, to: 4, at: 950 }, { from: 4, to: 5, at: 1000 }]);
  assert.deepEqual(planTextFades('abcdef', 'abef', [{ from: 2, to: 6, at: 950 }], 1000), [{ from: 2, to: 4, at: 950 }]);
  // Neighbours that started together are one.
  assert.deepEqual(planTextFades('ab', 'abcd', [{ from: 1, to: 2, at: 1000 }], 1000), [{ from: 1, to: 4, at: 1000 }]);
});

test('Chinese, Japanese and emoji count by their own characters; a span never splits one', () => {
  assert.deepEqual(fresh('日本語のテキスト', '日本語のテキストが続きます'), ['が続きます']);
  assert.deepEqual(fresh('家族 👨\u200d👩', '家族 👨\u200d👩\u200d👧 🇨🇳'), ['👧🇨🇳'], 'the joiner is invisible: the new person and the flag are new');
  const family = '家族 👨\u200d👩\u200d👧 and é';
  for (const index of [4, 5, 6, 7, 8]) assert.equal(graphemeEdge(family, index, false), 3, `back from ${index} to the family's start`);
  for (const index of [4, 6, 8]) assert.equal(graphemeEdge(family, index, true), 11, `on from ${index} to its end`);
  assert.equal(graphemeEdge(family, 3, true), 3, 'already an edge');
  const combining = 'cafe\u0301!';
  assert.equal(graphemeEdge(combining, 4, true), 5, 'a letter and its accent stay together');
  assert.equal(graphemeEdge('🇨🇳🇯🇵', 2, false), 0, 'a flag is two regional indicators');
  assert.equal(graphemeEdge('🇨🇳🇯🇵', 4, false), 4);
});

test('visible characters and their offsets agree, whatever the text holds', () => {
  for (const text of ['', '  ', 'a b\n\tc', '中 文\u3000全角空格', 'emoji 🧭 ❤\ufe0f 👨\u200d👩\u200d👧', 'cafe\u0301 \u00ad soft hyphen', 'zero\u200bwidth\ufeffbom', '\u{1F1E8}\u{1F1F3}\u{E0067}tag']) {
    const visible = visibleText(text), offsets = visibleOffsets(text);
    assert.equal(offsets.length, visible.length, JSON.stringify(text));
    assert.equal(offsets.map(at => text[at]).join(''), visible, JSON.stringify(text));
  }
});

test('texts too different to tell apart show as they are', () => {
  const a = 'x'.repeat(2000), b = 'y'.repeat(2000);
  assert.equal(alignShown(a, b), undefined);
  assert.deepEqual(planTextFades(a, b, [{ from: 0, to: 10, at: 990 }], 1000), [], 'nothing fades, not even a fade that was running');
  assert.deepEqual(alignShown(a, 'y'.repeat(MAX_TEXT_EDITS / 2) + a), [{ from: 0, to: MAX_TEXT_EDITS / 2, length: 2000 }], 'fewer edits are worked out');
  // A long reply changing at its end costs only its tail: the common start is skipped before any diff
  // (counted, not timed: a busy machine takes longer either way).
  const long = '这一段文字足够长。'.repeat(20000), before = alignWork.units;
  assert.deepEqual(planTextFades(long, long + '新的', [], 1000), [{ from: long.length, to: long.length + 2, at: 1000 }]);
  assert.equal(alignWork.units, before, 'text added at the end: no diff at all');
  assert.deepEqual(fresh(long + '**落盘', long + '落盘后'), ['后']);
  assert.equal(alignWork.units - before, '**落盘'.length + '落盘后'.length, 'its Markdown changed at the end: only that tail is diffed');
});

test('the stylesheet fades text for as long as the code expects, only its opacity', () => {
  const css = readFileSync(new URL('../src/renderer/content-fade.css', import.meta.url), 'utf8');
  assert.match(css, new RegExp(`\\[data-text-fade\\] \\{ animation: lectern-text-in ${TEXT_FADE_MS}ms `));
  assert.match(css, /@keyframes lectern-text-in \{ from \{ opacity: 0; \} \}/);
});
