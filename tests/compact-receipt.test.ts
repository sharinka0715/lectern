import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('an automatic compaction comes after its prompt: the reply that follows ends the receipt (2.1.300, 2.1.321, 2.1.331)', () => {
  for (const version of ['2.1.300', '2.1.321', '2.1.331']) {
    const rows = readFileSync(new URL(`./fixtures/rewind-compact-${version}/auto.jsonl`, import.meta.url), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    const at = rows.findIndex(row => row.subtype === 'compact_boundary'), store = new SessionActivityStore(rows[at].sessionId);
    assert.equal(rows[at].compactMetadata.trigger, 'auto', version);
    assert.ok(rows.slice(at + 1).every(row => !(row.type === 'user' && row.origin?.kind === 'human')), `${version}: no prompt after it`);
    store.ingest(rows.slice(0, at + 2));
    assert.equal(store.currentCompact?.id, rows[at].uuid, `${version}: shown while the summary is the last thing`);
    store.ingest(rows.slice(at + 2));
    assert.equal(store.currentCompact, undefined, `${version}: its reply ends it`);
  }
  // A synthetic or API-error message is not a reply.
  const store = new SessionActivityStore(S);
  store.ingest([boundary('b1'), ...afterCompact,
    { type: 'assistant', uuid: 'syn', sessionId: S, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } },
    { type: 'assistant', uuid: 'err', sessionId: S, isApiErrorMessage: true, message: { role: 'assistant', model: 'claude', content: [{ type: 'text', text: 'API Error' }] } }]);
  assert.equal(store.currentCompact?.id, 'b1');
});

test('a manual compaction followed by replies to background task notifications, no prompt: the first reply ends it (2.1.332 shape)', () => {
  const store = new SessionActivityStore(S);
  const notice = (uuid: string) => user(uuid, '<task-notification>done</task-notification>', { origin: { kind: 'task-notification' }, promptSource: 'system' });
  const queuedNotice = { type: 'attachment', uuid: 'qn', sessionId: S, attachment: { type: 'queued_command', prompt: 'done', commandMode: 'task-notification', origin: { kind: 'task-notification' } } };
  store.ingest([boundary('b1'), ...afterCompact, notice('n1'), notice('n2'), queuedNotice]);
  assert.equal(store.currentCompact?.id, 'b1', 'notifications alone are not the conversation moving on');
  store.ingest([{ type: 'assistant', uuid: 'a1', sessionId: S, message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Both runs finished.' }] } }]);
  assert.equal(store.currentCompact, undefined);
});
