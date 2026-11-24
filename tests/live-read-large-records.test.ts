import { fixtureClaudeConfig } from './helpers/claude-config';
import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Backend, projectSlug } from '../src/backend/index';
import { MessageDisplay } from '../src/core/message-display';
import { pendingQuestionId } from '../src/main/session-question';
import type { Workspace } from '../src/shared/types';

// One live read returns at most 512 KiB (transcript-pages.ts, liveTranscriptScript).
const WINDOW = 512 * 1024;
const line = (record: Record<string, unknown>) => JSON.stringify(record) + '\n';

test('a record larger than one live read does not hold back the question after it', { skip: process.platform === 'win32' ? 'local POSIX reads' : false }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lectern-live-large-')));
  const sessionId = randomUUID(), cwd = join(root, 'work'), claudeDir = join(root, 'claude');
  const project = join(claudeDir, 'projects', projectSlug(cwd)), file = join(project, `${sessionId}.jsonl`);
  const base = { sessionId, cwd, isSidechain: false };
  const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  await mkdir(cwd, { recursive: true }); await mkdir(project, { recursive: true });
  await writeFile(file, line({ ...base, type: 'user', uuid: 'u1', parentUuid: null, timestamp: at(0), promptSource: 'typed', message: { role: 'user', content: 'Read the log, then ask me.' } })
    + line({ ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: at(1), message: { id: 'm1', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_read', name: 'Bash', input: { command: 'cat big.log' } }] } }));
  const workspace: Workspace = { id: 'large', name: 'Large records', kind: 'local', cwd };
  fixtureClaudeConfig(claudeDir);
  const backend = new Backend({ tmuxSocket: `lectern-live-large-${randomUUID().slice(0, 8)}` });
  const display = new MessageDisplay(sessionId);
  const read = async () => {
    const result = await backend.readSession(workspace, sessionId, false, [], true);
    display.ingestJsonl(result.jsonl, result.reset, result.reset ? !!result.olderCursor : undefined);
    return result;
  };
  try {
    await read();
    // A tool result longer than a whole read (wide characters too), then the reply and its question.
    const big = '日志行 '.repeat(Math.ceil(2.5 * WINDOW / 10));
    const result = line({ ...base, type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: at(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: big }] } });
    assert.ok(Buffer.byteLength(result) > 2 * WINDOW);
    await appendFile(file, result + line({ ...base, type: 'assistant', uuid: 'a2', parentUuid: 'u2', timestamp: at(3), message: { id: 'm2', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: 'One question.' }] } })
      + line({ ...base, type: 'assistant', uuid: 'a3', parentUuid: 'a2', timestamp: at(4), message: { id: 'm2', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_ask', name: 'AskUserQuestion', input: { questions: [] } }] } }));
    // Each read moves a full window on; the record is joined across reads, never re-sent.
    const reads = [];
    while (!pendingQuestionId(display.getMessages()) && reads.length < 10) reads.push(await read());
    assert.equal(pendingQuestionId(display.getMessages()), 'toolu_ask');
    assert.ok(reads.length <= Math.ceil(Buffer.byteLength(result) / WINDOW) + 1, `took ${reads.length} reads`);
    assert.ok(reads.every(r => !r.reset && r.jsonl.length <= WINDOW));
    assert.deepEqual(reads.map(r => r.hasMore), reads.map((_, i) => i < reads.length - 1));
    const messages = display.getMessages();
    assert.equal(messages.at(-1)?.tools.find(tool => tool.id === 'toolu_read')?.result?.length, big.length);
  } finally {
    await backend.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
