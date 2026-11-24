import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageDisplay, JsonlDecoder } from '../src/core/message-display';
import { alignPreview, classifySessionScreen, extractPreview, stripTerminalEscapes } from '../src/core/screen';
import { DONE, REPLY, said } from './helpers/claude-screen';

const sessionId = 'session-fixture';
function user(uuid: string, text: string) {
  return { type: 'user', sessionId, uuid, message: { role: 'user', content: [{ type: 'text', text }] } };
}
function assistant(uuid: string, text: string, stop: string | null = 'end_turn') {
  return { type: 'assistant', sessionId, uuid, message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stop } };
}
function jsonl(...records: unknown[]) { return records.map(record => JSON.stringify(record)).join('\n') + '\n'; }
function screen(prompt: string, text: string, busy = true) {
  return `Claude Code\n\n❯ ${prompt}\n\n${said(text)}\n\n${busy ? '✻ Thinking… (esc to interrupt)\n' : ''}────────────────────────\n❯ \n────────────────────────\n  ? for shortcuts\n`;
}

test('JSONL decoder preserves Chinese and emoji when every byte arrives separately', () => {
  const decoder = new JsonlDecoder();
  const original = user('unicode', '你好，世界 🧭\n第二行');
  const bytes = Buffer.from(jsonl(original));
  const parsed = [];
  for (const byte of bytes) parsed.push(...decoder.push(Buffer.from([byte])));
  assert.deepEqual(parsed, [original]);
});

test('JSONL decoder buffers trailing partial lines, skips bad rows and recovers after overlarge rows', () => {
  const decoder = new JsonlDecoder(30);
  assert.deepEqual(decoder.push('{"a":'), []);
  assert.deepEqual(decoder.push('1}\n{broken}\n{"b":2}'), [{ a: 1 }]);
  assert.deepEqual(decoder.push('\n'), [{ b: 2 }]);
  assert.equal(decoder.invalidLines, 1);
  assert.deepEqual(decoder.push('x'.repeat(40)), []);
  assert.deepEqual(decoder.push('rest\n{"ok":true}\n'), [{ ok: true }]);
  assert.equal(decoder.oversizedLines, 1);
});

test('preview updates in one assistant bubble, final JSONL replaces it in place byte for byte', () => {
  const display = new MessageDisplay(sessionId);
  display.optimisticUser('你好');
  const initialId = display.getMessages().at(-1)!.id;
  display.ingestScreen(screen('你好', '你好！第一段'));
  assert.equal(display.getMessages().at(-1)!.text, '你好！第一段');
  display.ingestJsonl(jsonl(user('u1', '你好')));
  display.ingestScreen(screen('你好', '你好！第一段\n\n第二段 🧭', false));
  assert.equal(display.getMessages().length, 2);
  assert.equal(display.getMessages().at(-1)!.source, 'preview');
  assert.equal(display.status, 'working'); // TUI is ahead of disk.
  const final = '你好！**第一段**\n\n第二段 🧭\n\n```ts\nconst ok = true;\n```';
  const bytes = Buffer.from(jsonl(assistant('a1', final)));
  display.ingestJsonl(bytes.subarray(0, bytes.length - 4));
  assert.equal(display.getMessages().at(-1)!.source, 'preview');
  display.ingestJsonl(bytes.subarray(bytes.length - 4));
  const result = display.getMessages().at(-1)!;
  assert.equal(result.id, initialId);
  assert.equal(result.source, 'jsonl');
  assert.equal(result.status, 'complete');
  assert.equal(result.text, final);
  display.ingestScreen(screen('你好', 'stale incomplete output'));
  assert.equal(display.getMessages().at(-1)!.text, final);
});

test('canonical partial reply keeps aligned screen suffix until final record arrives', () => {
  const display = new MessageDisplay(sessionId);
  display.ingestJsonl(jsonl(user('u1', 'Explain the plan')));
  display.ingestScreen(screen('Explain the plan', 'First paragraph.\n\nSecond paragraph in progress'));
  display.ingestJsonl(jsonl(assistant('a1', 'First paragraph.', null)));
  const id = display.getMessages().at(-1)!.id;
  assert.equal(display.getMessages().at(-1)!.text, 'First paragraph.\n\nSecond paragraph in progress');
  display.ingestJsonl(jsonl(assistant('a2', 'Second paragraph in progress, now done.')));
  assert.equal(display.getMessages().at(-1)!.id, id);
  assert.equal(display.getMessages().at(-1)!.text, 'First paragraph.\n\nSecond paragraph in progress, now done.');
  assert.equal(display.getMessages().filter(m => m.role === 'assistant').length, 1);
});

test('tool calls and tool results belong to the same human turn, not extra user bubbles', () => {
  const display = new MessageDisplay(sessionId);
  display.ingestJsonl(jsonl(user('u1', 'Inspect this file'), {
    type: 'assistant', uuid: 'a1', sessionId,
    message: { content: [{ type: 'text', text: 'I will inspect it.' }, { type: 'tool_use', id: 'tool1', name: 'Read', input: { file_path: '/tmp/hello.ts' } }], stop_reason: 'tool_use' },
  }, {
    type: 'user', uuid: 'r1', sessionId,
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool1', content: [{ type: 'text', text: 'export const hello = 1;' }] }] },
  }, assistant('a2', 'It exports a constant.')));
  const messages = display.getMessages();
  assert.equal(messages.length, 2);
  assert.equal(messages[1].text, 'I will inspect it.\n\nIt exports a constant.');
  assert.deepEqual(messages[1].tools[0], {
    id: 'tool1', name: 'Read', input: '{\n  "file_path": "/tmp/hello.ts"\n}',
    result: 'export const hello = 1;', isError: false, textOffset: 'I will inspect it.'.length,
  });
});

test('replaying repeated UUIDs is idempotent; intentional repeated user text is retained', () => {
  const display = new MessageDisplay(sessionId);
  const history = jsonl(user('u1', 'Again'), assistant('a1', 'Hello'));
  display.ingestJsonl(history);
  const original = display.getMessages();
  display.ingestJsonl(history);
  assert.deepEqual(display.getMessages(), original);
  display.optimisticUser('Again');
  display.ingestJsonl(jsonl(user('u2', 'Again'), assistant('a2', 'Hello again')));
  assert.equal(display.getMessages().length, 4);
  assert.equal(display.getMessages()[2].source, 'jsonl');
  assert.notEqual(display.getMessages()[1].id, display.getMessages()[3].id);
});

test('record revision with the same UUID replaces its canonical text instead of duplicating it', () => {
  const display = new MessageDisplay(sessionId);
  display.ingestJsonl(jsonl(user('u1', 'Hello'), assistant('a1', 'Partial', null)));
  const id = display.getMessages()[1].id;
  display.ingestJsonl(jsonl(assistant('a1', 'Partial, now complete.')));
  assert.equal(display.getMessages()[1].text, 'Partial, now complete.');
  assert.equal(display.getMessages()[1].id, id);
});

test('file truncation/replacement rebuilds deterministically without phantom old messages', () => {
  const display = new MessageDisplay(sessionId);
  const first = jsonl(user('u1', 'One'), assistant('a1', 'Answer one'));
  display.ingestJsonl(first);
  const id = display.getMessages()[1].id;
  display.ingestJsonl(jsonl(user('u2', 'Two'), assistant('a2', 'Answer two')));
  display.ingestJsonl(first, true);
  assert.equal(display.getMessages().length, 2);
  assert.equal(display.getMessages()[1].id, id);
  assert.equal(display.getMessages()[1].text, 'Answer one');
});

test('a delayed previous answer cannot populate the next optimistic reply', () => {
  const display = new MessageDisplay(sessionId);
  display.ingestJsonl(jsonl(user('u1', 'First')));
  display.optimisticUser('Second');
  display.ingestJsonl(jsonl(assistant('a1', 'First answer')));
  const messages = display.getMessages();
  assert.equal(messages[1].text, 'First answer');
  assert.equal(messages[3].text, '');
  display.ingestJsonl(jsonl(user('u2', 'Second'), assistant('a2', 'Second answer')));
  assert.equal(display.getMessages()[3].text, 'Second answer');
});

test('screen extractor removes ANSI and TUI chrome while retaining paragraphs and code indentation', () => {
  const raw = '\x1b[32m❯ Explain\x1b[0m\n\n' + REPLY + ' One paragraph.\n\n  Another paragraph.\n\n  ```js\n    nested();\n  ```\n\n✻ Thinking… (esc to interrupt)\n─────────\n❯ \n  ? for shortcuts';
  assert.equal(extractPreview(raw, 'Explain').text, 'One paragraph.\n\nAnother paragraph.\n\n```js\n  nested();\n```');
  assert.equal(stripTerminalEscapes('\x1b]0;title\x07hello\x1b[1m world\x1b[0m'), 'hello world');
});

test('screens without the current prompt need known text overlap; stale previous turns are rejected', () => {
  assert.equal(extractPreview(screen('Old prompt', 'Old answer'), 'New prompt').text, '');
  const partial = REPLY + ' A sufficiently long existing paragraph.\n\n  New paragraph.\n─────────\n❯ ';
  const preview = extractPreview(partial, 'Scrolled away', 'A sufficiently long existing paragraph.');
  assert.equal(preview.anchored, false);
  assert.equal(preview.text, 'A sufficiently long existing paragraph.\n\nNew paragraph.');
  assert.equal(alignPreview('Prefix.\n\nA sufficiently long existing paragraph.', preview.text), 'Prefix.\n\nA sufficiently long existing paragraph.\n\nNew paragraph.');
});

test('an unanswered user turn cannot absorb a later local-command response or unrelated reply', () => {
  const display = new MessageDisplay(sessionId);
  display.ingestJsonl(jsonl(user('u1', 'Unanswered prompt')));
  const idle = '────────────\n❯ \n────────────';
  const local = `❯ Unanswered prompt\n\n❯ /unsupported\n⏺ Unknown command: /unsupported.\n${idle}`;
  assert.equal(extractPreview(local, 'Unanswered prompt').text, '');
  display.ingestScreen(local, idle);
  assert.equal(display.getMessages().at(-1)!.text, '');
  assert.equal(display.status, 'idle');
  assert.equal(extractPreview(`❯ Unanswered prompt\n❯ Later question\n⏺ Later answer\n${idle}`, 'Unanswered prompt').text, '');
  assert.equal(extractPreview(`❯ Unanswered prompt\n${idle}\n${REPLY} Actual answer`, 'Unanswered prompt').text, 'Actual answer');
});

test('screen tool output and permission menu do not become assistant prose', () => {
  const raw = `❯ Inspect\n${REPLY} I will inspect the file.\n\n${DONE} Bash(cat file)\n  ⎿ this is command output\n    more command output\n${REPLY} Here is the result.\n─────────\nDo you want to proceed?\n❯ 1. Yes`;
  const preview = extractPreview(raw, 'Inspect');
  assert.equal(preview.status, 'waiting');
  assert.equal(preview.text, 'I will inspect the file.\n\nHere is the result.');
});

test('unrelated session, sidechain, meta and local command records cannot pollute the chat', () => {
  const display = new MessageDisplay(sessionId);
  display.ingestJsonl(jsonl(
    { ...user('wrong', 'Wrong session'), sessionId: 'some-other-session' },
    { ...user('side', 'Subagent'), isSidechain: true },
    { ...user('meta', 'Meta'), isMeta: true },
    user('command', '<local-command-caveat>Ignore</local-command-caveat>'),
    user('u1', 'Visible'),
    { type: 'assistant', uuid: 'thinking', message: { content: [{ type: 'thinking', thinking: 'Hidden reasoning' }] } },
    assistant('a1', 'Visible reply'),
  ));
  assert.equal(display.getMessages().length, 2);
  assert.equal(display.getMessages()[1].text, 'Visible reply');
});

test('system turn duration finalizes authoritative text without an assistant stop reason', () => {
  const display = new MessageDisplay(sessionId);
  display.ingestJsonl(jsonl(user('u1', 'Hi')));
  display.ingestScreen(screen('Hi', 'Approximate screen rendering'));
  display.ingestJsonl(jsonl(assistant('a1', '**Canonical** rendering', null), { type: 'system', subtype: 'turn_duration', durationMs: 1000 }));
  assert.equal(display.getMessages()[1].text, '**Canonical** rendering');
  assert.equal(display.getMessages()[1].source, 'jsonl');
  assert.equal(display.getMessages()[1].status, 'complete');
});

test('malformed complete records are surfaced as a notice; partial records are not errors', () => {
  const display = new MessageDisplay(sessionId);
  display.ingestJsonl('{broken');
  assert.equal(display.notice, undefined);
  display.ingestJsonl('\n');
  assert.match(display.notice!, /1/);
  display.ingestJsonl(jsonl(user('u1', 'Still works'), assistant('a1', 'Yes')));
  assert.equal(display.getMessages()[1].text, 'Yes');
});

test('missing transcript then first file creation preserves pending bubble identity and preview', () => {
  const display = new MessageDisplay(sessionId);
  display.optimisticUser('你好');
  display.ingestScreen(screen('你好', '正在回复'));
  const ids = display.getMessages().map(message => message.id);
  display.ingestJsonl(Buffer.alloc(0), true);
  assert.deepEqual(display.getMessages().map(message => message.id), ids);
  assert.equal(display.getMessages()[1].text, '正在回复');
  display.ingestJsonl(jsonl(user('u1', '你好')), true);
  assert.deepEqual(display.getMessages().map(message => message.id), ids);
  display.ingestJsonl(jsonl(assistant('a1', '正在回复，现在已完成。')));
  assert.equal(display.getMessages()[1].id, ids[1]);
});

test('optimistic promotion and canonical replay keep identical turn timestamps across resume and file reset', () => {
  for (const userTime of ['2026-11-17T16:30:53.883Z', undefined]) {
    const live = new MessageDisplay(sessionId);
    const initial = jsonl({ ...user('earlier-user', 'Earlier'), timestamp: '2026-11-17T16:25:34.881Z' },
      { ...assistant('earlier-answer', 'Earlier answer'), timestamp: '2026-11-17T16:25:39.000Z' });
    const nextUser = jsonl({ ...user('later-user', 'Next question'), timestamp: userTime });
    const nextAssistant = jsonl({ ...assistant('later-answer', 'Next answer'), timestamp: '2026-11-17T16:30:58.432Z' });
    live.ingestJsonl(initial);
    live.optimisticUser('Next question');
    live.ingestScreen(screen('Next question', 'Next answer'));
    const assistantId = live.getMessages().at(-1)!.id;
    live.ingestJsonl(nextUser);
    live.ingestJsonl(nextAssistant);
    const completed = live.getMessages();
    assert.equal(completed.at(-1)!.id, assistantId);
    assert.equal(completed.at(-1)!.timestamp, userTime ?? '2026-11-17T16:30:58.432Z');
    const reopened = new MessageDisplay(sessionId);
    reopened.ingestJsonl(initial + nextUser + nextAssistant);
    assert.deepEqual(reopened.getMessages(), completed, 'Every message field, including timestamps, survives canonical resume');
    live.ingestJsonl(initial + nextUser + nextAssistant, true);
    assert.deepEqual(live.getMessages(), completed, 'File replay uses the same timestamp rule');
  }
});

test('reset replay keeps pending turns after all canonical history chunks without ID collision', () => {
  const display = new MessageDisplay(sessionId);
  display.ingestJsonl(jsonl(user('u1', 'Old'), assistant('a1', 'Old reply')));
  display.optimisticUser('New');
  const pendingId = display.getMessages()[3].id;
  display.ingestJsonl(jsonl(user('u1', 'Old')), true);
  display.ingestJsonl(jsonl(assistant('a1', 'Old reply')));
  display.ingestJsonl(jsonl(user('u2', 'New'), assistant('a2', 'New reply')));
  assert.deepEqual(display.getMessages().map(message => message.text), ['Old', 'Old reply', 'New', 'New reply']);
  assert.equal(display.getMessages()[3].id, pendingId);
  display.ingestJsonl(jsonl(user('u3', 'Third'), assistant('a3', 'Third reply')));
  assert.equal(new Set(display.getMessages().map(message => message.id)).size, 6);
});

test('null stop reason settles on an idle screen only when canonical text covers the preview', () => {
  const display = new MessageDisplay(sessionId);
  display.ingestJsonl(jsonl(user('u1', 'Hi')));
  display.ingestScreen(screen('Hi', 'Some answer.\n\nMore text.', false));
  display.ingestJsonl(jsonl(assistant('a1', 'Some answer.', null)));
  display.ingestScreen(screen('Hi', 'Some answer.\n\nMore text.', false));
  assert.equal(display.status, 'working');
  display.ingestJsonl(jsonl(assistant('a2', '**More text.**', null)));
  display.ingestScreen(screen('Hi', 'Some answer.\n\nMore text.', false));
  assert.equal(display.status, 'idle');
  assert.equal(display.getMessages()[1].status, 'complete');
  assert.equal(display.getMessages()[1].source, 'jsonl');
  assert.equal(display.getMessages()[1].text, 'Some answer.\n\n**More text.**');
});

test('short transient screen repaint does not erase an observed suffix', () => {
  const display = new MessageDisplay(sessionId);
  display.optimisticUser('Hi');
  display.ingestScreen(screen('Hi', 'Long reply with a second paragraph.'));
  display.ingestScreen(screen('Hi', 'Long reply'));
  assert.equal(display.getMessages()[1].text, 'Long reply with a second paragraph.');
});

test('explicit interrupt ends streaming while retaining unsaved preview until canonical arrives', () => {
  const display = new MessageDisplay(sessionId);
  display.optimisticUser('Hi');
  display.ingestScreen(screen('Hi', 'Partial reply'));
  display.markInterrupted();
  assert.equal(display.status, 'idle');
  assert.equal(display.getMessages()[1].status, 'complete');
  assert.equal(display.getMessages()[1].text, 'Partial reply');
  assert.equal(display.getMessages()[1].source, 'preview');
  assert.match(display.notice!, /中断/);
  display.ingestJsonl(jsonl(user('u1', 'Hi'), assistant('a1', 'Partial reply')));
  assert.equal(display.getMessages()[1].source, 'jsonl');
  assert.equal(display.notice, undefined);
});

test('optimistic user matching permits outer trim but never conflates different internal whitespace', () => {
  const display = new MessageDisplay(sessionId);
  display.optimisticUser('  const greeting = "hello world";\n');
  const initialId = display.getMessages()[0].id;
  display.ingestJsonl(jsonl(user('u1', 'const greeting = "hello world";')));
  assert.equal(display.getMessages()[0].id, initialId);
  assert.equal(display.getMessages()[0].source, 'jsonl');
  display.optimisticUser('hello world');
  display.ingestJsonl(jsonl(user('u2', 'helloworld')));
  assert.equal(display.getMessages().filter(message => message.role === 'user').length, 3);
  assert.equal(display.getMessages().find(message => message.text === 'hello world')!.source, 'pending');
});

test('tmux padding beneath the TUI does not hide an idle prompt', () => {
  const display = new MessageDisplay(sessionId);
  display.ingestJsonl(jsonl(user('u1', 'Hi'), assistant('a1', 'Hello')));
  display.ingestScreen(screen('Hi', 'Hello', false) + '\n'.repeat(35));
  assert.equal(display.status, 'idle');
  assert.equal(extractPreview(screen('Hi', 'Hello', false) + '\n'.repeat(35), 'Hi').status, 'idle');
});

test('long scrollback overlap preserves its prefix and appends only the new suffix', () => {
  const prefix = 'earlier paragraph. '.repeat(5000);
  const overlap = 'an existing shared ending. '.repeat(1000);
  const preview = overlap + '\n\nnew ending 🧭';
  assert.equal(alignPreview(prefix + overlap, preview), prefix + overlap + '\n\nnew ending 🧭');
});

test('preview alignment never duplicates closing Markdown markers at a canonical boundary', () => {
  assert.equal(alignPreview('**First paragraph.**', '**First paragraph.**\n\nSecond paragraph.'), '**First paragraph.**\n\nSecond paragraph.');
});

test('unknown welcome layout permits input while an actual pending turn remains working', () => {
  const display = new MessageDisplay(sessionId);
  display.ingestScreen('Claude Code new welcome layout\nType a message below\n');
  assert.equal(display.status, 'idle');
  display.optimisticUser('Hello');
  display.ingestScreen('Claude Code new welcome layout\nType a message below\n');
  assert.equal(display.status, 'working');
});

test('native Claude security-note continuation footer is a waiting TUI prompt', () => {
  const display = new MessageDisplay(sessionId);
  display.ingestScreen('Welcome to Claude Code v2.1.326\n\nSecurity notes:\nReview these notes.\n\nPress Enter to continue…\n' + '\n'.repeat(20));
  assert.equal(display.status, 'waiting');
  assert.equal(extractPreview('❯ Explain\n⏺ In prose, Press Enter to continue means accepting a notice.\n──────────\n❯ ', 'Explain').status, 'idle');
});

test('native first-run theme chooser is waiting rather than an ordinary chat prompt', () => {
  const display = new MessageDisplay(sessionId);
  display.ingestScreen('Welcome to Claude Code v2.1.326\n\nChoose the text style that looks best with your terminal\nTo change this later, run /theme\n\n❯ ✔ Auto (match terminal)\n  Dark mode\n  Light mode\n\n' + '\n'.repeat(25));
  assert.equal(display.status, 'waiting');
  assert.equal(extractPreview('❯ Explain setup\n⏺ Choose the text style that looks best with your terminal\n──────────\n❯ ', 'Explain setup').status, 'idle');
  assert.equal(extractPreview('Choose the text style that looks best with your terminal\nChoose your favorite option.\n──────────\n❯ ', '').status, 'idle', 'The header alone is not enough to infer a live selector');
});

test('sidebar classification requires explicit idle, busy or waiting evidence and keeps unknown layouts neutral', () => {
  assert.equal(classifySessionScreen('').status, 'unknown');
  assert.equal(classifySessionScreen('Claude Code new welcome layout\nType something here').status, 'unknown');
  assert.equal(classifySessionScreen('────────────\n❯ \n────────────\n' + '\n'.repeat(20)).status, 'idle');
  assert.equal(classifySessionScreen('✻ Thinking… (esc to interrupt)\n────────────\n❯ ').status, 'working');
  assert.equal(classifySessionScreen('❯ Explain\n⏺ The terminal instruction is esc to interrupt.\n────────────\n❯ ').status, 'idle');
  assert.equal(extractPreview('Unrecognized welcome layout', '').status, 'idle', 'Unknown sidebar state must not change the chat compatibility fallback');
});

test('the native unnumbered trust selector is waiting without requiring a numbered Yes option', () => {
  const screen = 'Accessing workspace:\n /path/to/project\n\nQuick safety check: Is this a project you created or one you trust?\n\n❯ Yes, I trust this folder\n  No, exit\n\nEnter to confirm · Esc to cancel\n';
  assert.equal(classifySessionScreen(screen).status, 'waiting');
  const display = new MessageDisplay(sessionId);
  display.ingestScreen(screen);
  assert.equal(display.status, 'waiting');
  assert.deepEqual(display.getMessages(), []);
});

test('the real native trust dialog stays waiting when No, exit is selected', () => {
  const captured = '\n────────────────────────────────────────\n Accessing workspace:\n\n /example/project\n\n Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source\n project, or work from your team). If not, take a moment to review what\'s in this folder first.\n\n Claude Code\'ll be able to read, edit, and execute files here.\n\n Security guide\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n' + '\n'.repeat(22);
  assert.equal(classifySessionScreen(captured).status, 'waiting');
  const display = new MessageDisplay(sessionId);
  display.ingestScreen(captured);
  assert.equal(display.status, 'waiting');
  assert.equal(classifySessionScreen('❯ No, exit\n────────────\n❯ ').status, 'idle', 'A user message alone does not identify the trust selector');
});

test('a boxed native Try placeholder is idle but unboxed quoted text is not readiness evidence', () => {
  assert.equal(classifySessionScreen('Welcome to Claude Code\n────────────────────\n❯ Try "fix typecheck errors"\n────────────────────\n  ? for shortcuts\n').status, 'idle');
  assert.equal(classifySessionScreen('Welcome to Claude Code\n❯ Try "fix typecheck errors"\n').status, 'unknown');
  assert.equal(classifySessionScreen('❯ Explain\n⏺ An example prompt is Try "fix typecheck errors".').status, 'unknown');
});

test('only explicit current native API or login errors turn a session red', () => {
  assert.equal(classifySessionScreen('❯ Hello\n\n⎿ API Error: 401 Authentication failed\n────────────\n❯ ').status, 'error');
  assert.equal(classifySessionScreen('Not logged in · Please run /login\n────────────\n❯ ').status, 'error');
  assert.equal(classifySessionScreen('Invalid API key · Please run /login\n────────────\n❯ ').status, 'error');
  assert.equal(classifySessionScreen('API Error: 503 Service unavailable\n✻ Retrying… (esc to interrupt)\n────────────\n❯ ').status, 'working', 'An explicit active retry remains busy');
  assert.equal(classifySessionScreen('Error: a tool command failed\n────────────\n❯ ').status, 'idle');
  assert.equal(classifySessionScreen('❯ Old\nAPI Error: 500 Old failure\n❯ Retry\n⏺ Recovered successfully.\n────────────\n❯ ').status, 'idle');
});

test('native bullet API error plus exact boxed retry placeholder is an error without matching ordinary prose', () => {
  const retry = '────────────────────\n❯\u00a0Once fixed, resend your message\n────────────────────\n  ⏵⏵ auto mode on (shift+tab to cycle)\n';
  const failure = '❯ Connectivity check\n\n⏺ API Error: 400 Unsupported model\n  (request details omitted)\n';
  assert.equal(classifySessionScreen(failure + retry).status, 'error');
  const display = new MessageDisplay(sessionId);
  display.ingestScreen(failure + retry);
  assert.equal(display.status, 'error');
  assert.equal(classifySessionScreen(failure + '────────────\n❯ \n────────────').status, 'idle');
  assert.equal(classifySessionScreen('❯ Explain\n⏺ API Error: 400 is an example.\n────────────\n❯ ').status, 'idle');
  assert.equal(classifySessionScreen('❯ Explain\n⏺ Example:\n```text\nAPI Error: 400 Example\n' + retry + '```').status, 'unknown');
  assert.equal(classifySessionScreen('❯ Explain\n⏺ Here is a draft example.\n' + retry).status, 'unknown');
  assert.equal(classifySessionScreen(failure + '❯ New request\n' + retry).status, 'unknown');
  assert.equal(classifySessionScreen(failure + '✻ Retrying… (esc to interrupt)\n' + retry).status, 'working');
  assert.equal(classifySessionScreen(failure + '────────────\nDo you want to proceed?\n' + retry).status, 'waiting');
});

test('assistant explanations, fenced examples and tool output do not become native error evidence', () => {
  for (const body of [
    '⏺ API Error: 401 is an example.',
    '⏺ Here is an example:\n  API Error: 401 Unauthorized',
    '⏺ Example:\n  ```text\n  API Error: 500 Server error\n  ```',
    '⏺ Bash(cat error.log)\n  ⎿ API Error: 503 from a test server',
    '⏺ A long explanation:\n' + '  continuation\n'.repeat(70) + '  API Error: 401 in an example',
  ]) assert.equal(classifySessionScreen(`❯ Explain\n${body}\n────────────\n❯ `).status, 'idle');
});

test('an explicit native error takes precedence over a pending reply while preserving its provisional text', () => {
  const display = new MessageDisplay(sessionId);
  display.optimisticUser('Hi');
  display.ingestScreen(screen('Hi', 'Partial response'));
  const id = display.getMessages()[1].id;
  display.ingestScreen('❯ Hi\n⎿ API Error: 429 Rate limited\n────────────\n❯ ');
  assert.equal(display.status, 'error');
  const message = display.getMessages()[1];
  assert.equal(message.id, id);
  assert.equal(message.text, 'Partial response');
  assert.equal(message.source, 'preview');
  assert.equal(message.status, 'complete');
});

test('exact viewport status cannot inherit an old spinner or error from captured scrollback', () => {
  const oldScreen = screen('Hi', 'Already complete.', true);
  const viewport = 'Future terminal layout without known status markers\n' + '\n'.repeat(39);
  assert.equal(extractPreview(oldScreen + viewport, 'Hi', '', viewport).status, 'idle', 'Chat preserves unknown→idle fallback using only the current viewport');
  assert.equal(classifySessionScreen(viewport).status, 'unknown');
  const display = new MessageDisplay(sessionId);
  display.ingestJsonl(jsonl(user('u1', 'Hi'), assistant('a1', 'Already complete.')));
  display.ingestScreen(oldScreen + viewport, viewport);
  assert.equal(display.status, 'idle');
  display.ingestScreen('❯ Hi\n⎿ API Error: 401 Old failure\n' + viewport, viewport);
  assert.equal(display.status, 'idle');
  assert.equal(display.getMessages()[1].text, 'Already complete.');
});

test('viewport-only status still uses full scrollback to anchor and preserve preview text', () => {
  const full = screen('Explain this', 'First paragraph.\n\nSecond paragraph.', true);
  const viewport = 'Second paragraph.\n\n✻ Thinking… (esc to interrupt)\n──────────\n❯ \n──────────\n';
  const preview = extractPreview(full, 'Explain this', '', viewport);
  assert.equal(preview.anchored, true);
  assert.equal(preview.text, 'First paragraph.\n\nSecond paragraph.');
  assert.equal(preview.status, 'working');
  assert.equal(extractPreview(full, 'Explain this').status, 'working', 'Older captures without a separate viewport retain their behavior');
});
