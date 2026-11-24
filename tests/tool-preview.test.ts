import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extractPreview, matchText, classifySessionScreen } from '../src/core/screen';
import { MessageDisplay } from '../src/core/message-display';
import { CALL, CALL_BLINK, REPLY, said } from './helpers/claude-screen';

interface NativeFixture {
  name: string;
  source: { screenSha256: string; viewportSha256: string };
  userText: string;
  knownAnswer: string;
  expectedText: string;
  screen: string;
  viewport: string;
}
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/tools/native-grouped-headings.json', import.meta.url), 'utf8')) as NativeFixture[];
// Hashes cover the checked-in frames, after replacing the test workspace path.
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const footer = '\n────────────────────\n❯ \n────────────────────\n';

test('real native grouped tool headings and edit diffs stay out of assistant previews', () => {
  for (const fixture of fixtures) {
    assert.equal(hash(fixture.screen), fixture.source.screenSha256);
    assert.equal(hash(fixture.viewport), fixture.source.viewportSha256);
    // Captured without colours: nothing on them is confirmed as the reply (reply-rows.ts), so the
    // preview stays empty rather than guessing; the coloured samples are tests/fixtures/preview-*.
    const preview = extractPreview(fixture.screen, fixture.userText, fixture.knownAnswer, fixture.viewport);
    assert.equal(preview.text, '', fixture.name);
    assert.doesNotMatch(preview.text, /(?:^|\n)\s*(?:Running \d+ shell commands?|Ran \d+ shell commands?|Reading test_stats\.py|Update\((?:test_)?stats\.py\))/);
    assert.doesNotMatch(preview.text, /\d+\s*\+\s*(?:self\.assertEqual|summarize|def test_)/);
  }
});

test('the look of a row, not its words, tells reply prose from a tool row', () => {
  for (const prose of ['Running 1 shell command…', 'Ran 1 shell command · 1 failed', 'Reading test_stats.py', 'Update(stats.py)', 'Bash(ls)']) {
    const screen = `❯ Explain\n\n${REPLY} ${prose}\n\n  This is an explanation, followed by ordinary prose.\n✻ Thinking…\n${footer}`;
    assert.equal(extractPreview(screen, 'Explain').text, `${prose}\n\nThis is an explanation, followed by ordinary prose.`);
    // The same words as a running call (both frames of its blinking bullet) are no reply.
    for (const bullet of [CALL, CALL_BLINK])
      assert.equal(extractPreview(`❯ Explain\n${said('Before.')}\n\n${bullet} ${prose}\n  \x1b[2m⎿  $ ls\x1b[0m\n✻ Thinking…\n${footer}`, 'Explain').text, 'Before.');
  }
  // A dim ⎿ row under the reply is Claude Code's own and ends it.
  assert.equal(extractPreview(`❯ Explain\n${REPLY} Reading test_stats.py\n  \x1b[2m⎿ another_file.py\x1b[0m\n  not the reply\n${footer}`, 'Explain').text, 'Reading test_stats.py');
});

test('literal grouped tool examples inside a code fence remain intact', () => {
  const example = '```text\nRunning 1 shell command…\n⎿ $ python3 example.py\nReading stats.py\n⎿ stats.py\nUpdate(stats.py)\n⎿ Added 2 lines, removed 1 line\n```';
  const screen = `❯ Explain\n${said(`Here is a literal terminal example:\n\n${example}`)}\n${footer}`;
  assert.equal(extractPreview(screen, 'Explain').text, `Here is a literal terminal example:\n\n${example}`);
});

test('real native continuation notice keeps tools pending until the terminal confirmation finishes', () => {
  const fixture = fixtures.find(fixture => fixture.name === 'native-tools-2916-notice')!;
  assert.equal(classifySessionScreen(fixture.viewport).status, 'waiting');
  const display = new MessageDisplay('notice');
  display.ingestJsonl([
    { type: 'user', sessionId: 'notice', uuid: 'u', message: { content: fixture.userText } },
    { type: 'assistant', sessionId: 'notice', uuid: 'a', message: { content: [
      { type: 'text', text: fixture.expectedText },
      { type: 'tool_use', id: 'pending-bash', name: 'Bash', input: { command: 'python3 example.py' } },
    ], stop_reason: 'tool_use' } },
  ].map(record => JSON.stringify(record)).join('\n') + '\n');
  display.ingestScreen(fixture.screen, fixture.viewport);
  assert.equal(display.status, 'waiting'); // Renderer disables its ordinary composer for this status.
  const pending = display.getMessages().at(-1)!;
  assert.equal(pending.status, 'streaming');
  assert.equal(pending.tools[0].result, undefined);
  assert.equal(matchText(pending.text), matchText(fixture.expectedText));
  display.ingestJsonl([
    { type: 'user', sessionId: 'notice', uuid: 'r', message: { content: [{ type: 'tool_result', tool_use_id: 'pending-bash', content: 'Done' }] } },
    { type: 'assistant', sessionId: 'notice', uuid: 'final', message: { content: '程序和测试均已完成。', stop_reason: 'end_turn' } },
  ].map(record => JSON.stringify(record)).join('\n') + '\n');
  display.ingestScreen(`● 程序和测试均已完成。${footer}`);
  assert.equal(display.status, 'idle');
  assert.equal(display.getMessages().at(-1)!.id, pending.id);
  assert.equal(display.getMessages().at(-1)!.tools[0].result, 'Done');
  assert.equal(display.getMessages().at(-1)!.status, 'complete');
  assert.equal(classifySessionScreen(`● A quoted footer:\n  Enter to continue · Esc to cancel${footer}`).status, 'idle');
  assert.equal(classifySessionScreen(`● Example:\n\`\`\`text\nEnter to continue · Esc to cancel\n\`\`\`${footer}`).status, 'idle');
});

test('inline calls keep their native positions across preview, out-of-order results, and history replay', () => {
  const display = new MessageDisplay('inline');
  const line = (row: object) => JSON.stringify(row) + '\n';
  const text = (text: string) => ({ type: 'text', text });
  const call = (id: string) => ({ type: 'tool_use', id, name: 'Read', input: {} });
  const result = (id: string) => line({ type: 'user', uuid: `result-${id}`, message: {
    content: [{ type: 'tool_result', tool_use_id: id, content: `output ${id}` }] } });
  const intro = '先看 🧭';
  const start = line({ type: 'user', uuid: 'question', message: { content: '检查' } }) +
    line({ type: 'assistant', uuid: 'first', message: { content: [call('a'), text(intro), call('b'), call('c')] } });
  display.ingestJsonl(start);
  display.ingestScreen(`❯ 检查\n${said(intro)}\n${said('已找到文件')}\n✻ Thinking…\n${footer}`);
  const preview = display.getMessages()[1];
  assert.equal(preview.source, 'preview');
  assert.match(preview.text.slice(intro.length), /已找到文件/);
  assert.deepEqual(preview.tools.map(tool => tool.textOffset), [0, intro.length, intro.length]);
  const results = result('c') + result('a') + result('b');
  const final = line({ type: 'assistant', uuid: 'final', message: { content: [call('d'), text('已找到文件'), call('e'), text('完成')], stop_reason: 'end_turn' } });
  display.ingestJsonl(results + final);
  const reply = display.getMessages()[1];
  assert.equal(reply.id, preview.id);
  assert.equal(reply.text, `${intro}\n\n已找到文件\n\n完成`);
  assert.deepEqual(reply.tools.map(tool => [tool.id, reply.text.slice(0, tool.textOffset ?? undefined), tool.result]), [
    ['a', '', 'output a'], ['b', intro, 'output b'], ['c', intro, 'output c'],
    ['d', intro, undefined], ['e', `${intro}\n\n已找到文件`, undefined],
  ]);
  const history = new MessageDisplay('inline');
  history.ingestJsonl(start + results + final, true);
  assert.deepEqual(history.getMessages()[1], reply);
});

test('grouped tool output cannot become a native API error or replace canonical tools and text', () => {
  const screen = `❯ Make a change\n● I will update the file.\n\n● Update(stats.py)\n  ⎿ Added 1 line, removed 1 line\n  API Error: 500 appears in a code fixture\n\n● Reading stats.py\n  ⎿ stats.py\n  API Error: 500 is literal file content\n${footer}`;
  assert.equal(classifySessionScreen(screen).status, 'idle');
  const display = new MessageDisplay('tools');
  const rows = [
    { type: 'user', sessionId: 'tools', uuid: 'u', message: { content: 'Make a change' } },
    { type: 'assistant', sessionId: 'tools', uuid: 'a', message: { content: [
      { type: 'text', text: 'I will update the file.' },
      { type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: 'stats.py', old_string: 'before', new_string: 'after' } },
    ], stop_reason: 'tool_use' } },
  ];
  display.ingestJsonl(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const id = display.getMessages().at(-1)!.id;
  display.ingestScreen(screen, screen);
  assert.equal(display.getMessages().at(-1)!.text, 'I will update the file.');
  display.ingestJsonl(JSON.stringify({ type: 'user', sessionId: 'tools', uuid: 'r', message: { content: [{ type: 'tool_result', tool_use_id: 'edit', content: 'File updated', is_error: false }] } }) + '\n');
  display.ingestJsonl(JSON.stringify({ type: 'assistant', sessionId: 'tools', uuid: 'final', message: { content: [{ type: 'text', text: 'Done. Update(stats.py) is also a valid phrase in this explanation.' }], stop_reason: 'end_turn' } }) + '\n');
  const answer = display.getMessages().at(-1)!;
  assert.equal(answer.id, id);
  assert.equal(answer.source, 'jsonl');
  assert.equal(answer.text, 'I will update the file.\n\nDone. Update(stats.py) is also a valid phrase in this explanation.');
  assert.deepEqual(answer.tools, [{ id: 'edit', name: 'Edit', input: '{\n  "file_path": "stats.py",\n  "old_string": "before",\n  "new_string": "after"\n}', result: 'File updated', isError: false, textOffset: 'I will update the file.'.length }]);
});
