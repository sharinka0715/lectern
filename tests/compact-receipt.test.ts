import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionActivityStore } from '../src/core/session-activity';

// Claude Code 2.1.328 after a manual /compact: boundary, summary, caveat,
// command echo, its output and re-read files, then (maybe) the next prompt.
const S = 'S';
const boundary = (uuid: string) => ({ type: 'system', subtype: 'compact_boundary', uuid, parentUuid: null, sessionId: S, timestamp: '2026-11-20T02:25:00Z',
  compactMetadata: { trigger: 'manual', preTokens: 893086, postTokens: 17519, durationMs: 41000 } });
const user = (uuid: string, content: unknown, extra: object = {}) => ({ type: 'user', uuid, sessionId: S, ...extra, message: { role: 'user', content } });
const afterCompact = [
  user('summary', 'This session is being continued from a previous conversation.', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
  user('caveat', '<local-command-caveat>The command below was run directly in Claude Code.</local-command-caveat>', { isMeta: true }),
  user('command', '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>'),
  user('stdout', '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>'),
  { type: 'attachment', uuid: 'file', sessionId: S, attachment: { type: 'file', filename: '/w/a.ts', content: {} } },
];
const prompt = (uuid: string) => user(uuid, '我已经搞定了', { promptSource: 'typed', origin: { kind: 'human' } });

test('the compaction receipt is shown until the next prompt, like the TUI line it mirrors', () => {
  const store = new SessionActivityStore(S);
  const current = () => store.currentCompact?.id;
  store.ingest([boundary('b1'), ...afterCompact]);
  assert.equal(current(), 'b1', 'its own command echo, output and re-read files do not end it');
  store.ingest([prompt('p1')]);
  assert.equal(current(), undefined);
  assert.equal(store.lastCompact?.id, 'b1', 'the record itself is kept for progress matching');
  // Re-reading the same boundary does not bring it back; a new compaction does.
  store.ingest([boundary('b1')]);
  assert.equal(current(), undefined);
  store.ingest([boundary('b2')]);
  assert.equal(current(), 'b2');
});

test('a queued prompt also ends it; other sessions and tool results do not', () => {
  const store = new SessionActivityStore(S);
  store.ingest([boundary('b1'), user('r', [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }]), { ...prompt('other'), sessionId: 'other' }]);
  assert.equal(store.currentCompact?.id, 'b1');
  store.ingest([{ type: 'attachment', uuid: 'q', sessionId: S, attachment: { type: 'queued_command', prompt: '继续', humanTurn: true, commandMode: 'prompt', origin: { kind: 'human' } } }]);
  assert.equal(store.currentCompact, undefined);
});
