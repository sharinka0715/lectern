import test from 'node:test';
import assert from 'node:assert/strict';
import { sameDraft } from '../src/backend/native-turn-controls';
import { turnComposer } from '../src/core/turn-controls';

// Claude Code 2.1.328 in a 120-column pane, a reply streaming, a long draft typed.
const frame = (draft: string[]) => [
  '❯ first prompt', '⏺ word0 word1 word2', '✻ Boondoggling… (2s · ↓ 8 tokens)', '',
  '─'.repeat(120), ...draft, '─'.repeat(120), '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← for agents', ''].join('\n');

test('a soft-wrapped draft is recognized as the pasted text (queue / steer used to stall here)', () => {
  const long = 'Please also double check the error handling in the reconnect path and the timeout values used by the poller, then summarize the risks briefly.';
  const wrapped = turnComposer(frame(['❯ Please also double check the error handling in the reconnect path and the timeout values used by the poller, then',
    '  summarize the risks briefly.']))!;
  assert.equal(wrapped.running, true);
  assert.notEqual(wrapped.text, long, 'the editor shows two rows');
  assert.equal(sameDraft(wrapped.text, long), true);
  const cjk = '另外请检查一下重连路径里的错误处理和轮询使用的超时时间，然后简要总结一下可能存在的风险，以及需要我确认的地方，谢谢。';
  assert.equal(sameDraft(turnComposer(frame(['❯ 另外请检查一下重连路径里的错误处理和轮询使用的超时时间，然后简要总结一下可能存在的风险，以及需要我',
    '  确认的地方，谢谢。']))!.text, cjk), true);
  assert.equal(sameDraft(turnComposer(frame(['❯ first line', '  second line', '  third line']))!.text, 'first line\nsecond line\nthird line'), true);
});

test('a different or extra draft is still not mistaken for the pasted text', () => {
  assert.equal(sameDraft('summarize the risks', 'summarize the risks briefly'), false);
  assert.equal(sameDraft('summarize the risks briefly x', 'summarize the risks briefly'), false);
  assert.equal(sameDraft('', 'text'), false);
});

import { performTurnAction } from '../src/backend/native-turn-controls';
const refused = () => new Error('原生设置画面或输入框已变化，未发送按键，请重新读取');
function streamingDriver(onKey: (key: string, count: number) => void) {
  let draft = '';
  const keys: string[] = [];
  return { keys, driver: {
    frame: async () => ({ paneId: '%1', panePid: 42, nativeStatus: 'busy', viewport: frame([`❯ ${draft}`]) }),
    pasteForTurn: async (text: string) => { draft = text; },
    keyForTurn: async (key: string) => { keys.push(key); onKey(key, keys.length); if (key === 'queue') draft = ''; },
  } };
}

test('a key refused by the dispatch guard while a reply streams is pressed again at most twice', async () => {
  const ok = streamingDriver((_key, count) => { if (count < 3) throw refused(); });
  await performTurnAction(ok.driver as any, '%1', 42, { kind: 'queue', text: '补充说明' } as any);
  assert.deepEqual(ok.keys, ['queue', 'queue', 'queue']);
  const always = streamingDriver(() => { throw refused(); });
  await assert.rejects(performTurnAction(always.driver as any, '%1', 42, { kind: 'queue', text: '补充说明' } as any), /未发送按键/);
  assert.deepEqual(always.keys, ['queue', 'queue', 'queue']);
  const other = streamingDriver(() => { throw new Error('SSH connection lost'); });
  await assert.rejects(performTurnAction(other.driver as any, '%1', 42, { kind: 'queue', text: '补充说明' } as any), /SSH/);
  assert.deepEqual(other.keys, ['queue'], 'an outcome that may have been sent is never retried');
});
