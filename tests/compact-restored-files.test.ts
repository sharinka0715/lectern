import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageDisplay } from '../src/core/message-display';

// Claude Code 2.1.328: after a compaction it re-reads the files it read most
// recently and records each as a `file` attachment right after the boundary,
// the summary and (for /compact) the command echo. They are not files the user
// attached to the prompt before the compaction.
const row = (data: object) => JSON.stringify({ sessionId: 'S', ...data }) + '\n';
const user = (uuid: string, parent: string | null, content: unknown, extra: object = {}) =>
  row({ type: 'user', uuid, parentUuid: parent, ...extra, message: { role: 'user', content } });
const reply = (uuid: string, parent: string, text: string, stop = 'end_turn') =>
  row({ type: 'assistant', uuid, parentUuid: parent, message: { id: `msg_${uuid}`, role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }] } });
const file = (uuid: string, parent: string, filename: string) =>
  row({ type: 'attachment', uuid, parentUuid: parent, attachment: { type: 'file', filename, displayPath: filename,
    content: { type: 'text', file: { filePath: filename, content: 'x', numLines: 1, startLine: 1, totalLines: 1 } } } });
const boundary = (uuid: string, logicalParent: string) =>
  row({ type: 'system', subtype: 'compact_boundary', uuid, parentUuid: null, logicalParentUuid: logicalParent, content: 'Conversation compacted',
    compactMetadata: { trigger: 'manual', preTokens: 900000 } });
const summary = (uuid: string, parent: string) =>
  user(uuid, parent, 'This session is being continued from a previous conversation that ran out of context.', { isCompactSummary: true, isVisibleInTranscriptOnly: true });

const beforeCompact =
  user('u1', null, '看看 @notes.md') + file('f1', 'u1', '/work/notes.md') + reply('a1', 'f1', '看完了。');
const manualCompact =
  boundary('b', 'a1') + summary('s', 'b')
  + user('cav', 's', '<local-command-caveat>The command below was run directly in Claude Code.</local-command-caveat>', { isMeta: true })
  + user('cmd', 'cav', '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>')
  + user('out', 'cmd', '<local-command-stdout>\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m</local-command-stdout>')
  + file('r1', 'out', '/tmp/task.output') + file('r2', 'r1', '/work/src/app.ts');
const afterCompact =
  user('u2', 'r2', '继续，看看 @todo.md') + file('f2', 'u2', '/work/todo.md') + reply('a2', 'f2', '好的。');

const attached = (display: MessageDisplay) => display.getMessages()
  .filter(message => message.role === 'user').map(message => [message.text, (message.attachments ?? []).map(ref => ref.path)]);

test('files Claude Code re-reads after /compact are not attached to the last prompt before it', () => {
  // Plain replay, and the controller's first page that also shows compacted turns.
  for (const paged of [undefined, false, true]) {
    const display = new MessageDisplay('S');
    display.ingestJsonl(beforeCompact + manualCompact + afterCompact, paged !== undefined, paged);
    assert.deepEqual(attached(display), [
      ['看看 @notes.md', ['/work/notes.md']],
      ['继续，看看 @todo.md', ['/work/todo.md']],
    ], String(paged));
    assert.ok(!display.getMessages().some(message => message.attachments?.some(ref => /task\.output|app\.ts/.test(ref.path ?? ''))));
  }
});

test('the restored files stay hidden when the compaction arrives in a later poll', () => {
  const display = new MessageDisplay('S');
  display.ingestJsonl(beforeCompact);
  assert.deepEqual(attached(display), [['看看 @notes.md', ['/work/notes.md']]]);
  display.ingestJsonl(manualCompact);
  assert.deepEqual(attached(display), [['看看 @notes.md', ['/work/notes.md']]]);
  display.ingestJsonl(afterCompact);
  assert.deepEqual(attached(display), [
    ['看看 @notes.md', ['/work/notes.md']],
    ['继续，看看 @todo.md', ['/work/todo.md']],
  ]);
});

test('an automatic compaction in the middle of a reply restores files without attaching them to the prompt', () => {
  const display = new MessageDisplay('S');
  display.ingestJsonl(
    user('u1', null, '重构一下')
    + row({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { id: 'msg_a1', role: 'assistant', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/work/src/app.ts' } }] } })
    + user('t1', 'a1', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' }])
    + boundary('b', 't1') + summary('s', 'b')
    + file('r1', 's', '/work/src/app.ts')
    + reply('a2', 'r1', '重构完成。'));
  assert.deepEqual(attached(display), [['重构一下', []]]);
  assert.match(display.getMessages().at(-1)!.text, /重构完成。/);
});

test('a /compact echo without a preceding boundary in file order still starts the restored files', () => {
  // A fork can store the boundary earlier in the file than the command echo.
  const display = new MessageDisplay('S');
  display.ingestJsonl(beforeCompact
    + user('cmd', 'a1', '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>')
    + user('out', 'cmd', '<local-command-stdout>Compacted </local-command-stdout>')
    + file('r1', 'out', '/work/src/app.ts')
    + user('u2', 'r1', '下一步') + reply('a2', 'u2', '好。'));
  assert.deepEqual(attached(display), [['看看 @notes.md', ['/work/notes.md']], ['下一步', []]]);
});
