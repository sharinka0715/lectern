import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPreview } from '../src/core/screen';
import { MessageDisplay } from '../src/core/message-display';

// A reply streaming a fenced code block: until the closing fence is drawn, the
// spinner, input box and footer below it must not become part of the preview.
const rule = '─'.repeat(80);
const frame = (code: string[], busy: boolean, titled = false) => [
  '❯ 写个脚本', '',
  '⏺ 好的：', '',
  '  ```bash', '  for f in *.log; do', '    gzip "$f"', ...code, '',
  ...(busy ? ['✻ Thinking… (12s · ↓ 230 tokens · esc to interrupt)', ''] : []),
  titled ? `${'─'.repeat(60)} 训练 ──` : rule, '❯ ', rule, '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt'].join('\n');

test('an unterminated code block stops at the native input box, without the spinner', () => {
  for (const [label, screen] of [
    ['body still streaming', frame([], true)],
    ['closing fence half drawn', frame(['  done', '  ``'], true)],
    ['session-titled input box', frame(['  done'], true, true)],
    ['no spinner line', frame(['  done'], false)],
  ] as const) {
    const { text } = extractPreview(screen, '写个脚本', '', screen);
    assert.doesNotMatch(text, /Thinking|auto mode|❯|─{8}/u, label);
    assert.match(text, /^好的：\n\n```bash\nfor f in \*\.log; do\n  gzip "\$f"/u, label);
  }
});

test('a complete code block and code containing rules or quotes are unchanged', () => {
  const closed = frame(['  done', '  ```'], false);
  assert.equal(extractPreview(closed, '写个脚本', '', closed).text, '好的：\n\n```bash\nfor f in *.log; do\n  gzip "$f"\ndone\n```');
  // A box-drawing rule inside code is kept unless the ❯ prompt row follows it.
  const inside = frame(['  # ' + '─'.repeat(20), '  ' + '─'.repeat(30), '  > not a prompt', '  ```'], false);
  assert.match(extractPreview(inside, '写个脚本', '', inside).text, /─{30}\n> not a prompt\n```$/u);
});

test('a streamed code-block frame cannot keep a finished reply in preview', () => {
  // The JSONL reply arrives after a poll caught the open code block.
  const display = new MessageDisplay('S');
  const row = (data: object) => JSON.stringify({ sessionId: 'S', ...data }) + '\n';
  display.ingestJsonl(row({ type: 'user', uuid: 'u', parentUuid: null, message: { role: 'user', content: '写个脚本' } }));
  display.ingestScreen(frame([], true), frame([], true));
  const reply = '好的：\n\n```bash\nfor f in *.log; do\n  gzip "$f"\ndone\n```';
  display.ingestJsonl(row({ type: 'assistant', uuid: 'a', parentUuid: 'u', message: { id: 'm', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: reply }] } }));
  const idle = frame(['  done', '  ```'], false);
  display.ingestScreen(idle, idle);
  const last = display.getMessages().at(-1)!;
  assert.equal(last.text, reply);
  assert.doesNotMatch(last.text, /Thinking|❯|─{8}/u);
});
