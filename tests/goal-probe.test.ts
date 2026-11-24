import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Backend, projectSlug } from '../src/backend';
import { MessageDisplay } from '../src/core/message-display';
import type { Workspace } from '../src/shared/types';

// A goal set long before the first page (the last 128 KiB): the backend reads its last record once,
// on the target, from the bytes before that page (TranscriptPages.lastGoalStatus).
const posix = { skip: process.platform === 'win32' ? 'Local POSIX fixture; Windows runs no local commands' : false };

test('the last goal record before the first page: exact shape, this session, quoted copies ignored', posix, async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'lectern-goal-probe-')));
  const workspace: Workspace = { id: 'probe', name: 'Goal', kind: 'local', cwd, claudeDir: join(cwd, 'config') };
  const dir = join(workspace.claudeDir!, 'projects', projectSlug(cwd));
  await mkdir(dir, { recursive: true });
  const sessionId = randomUUID(), file = join(dir, sessionId + '.jsonl');
  const backend = new Backend({ tmuxSocket: 'probe-' + sessionId, claudeCommand: 'false' });
  t.after(async () => { await backend.dispose(); await rm(cwd, { recursive: true, force: true }); });
  let n = 0;
  const record = (fields: Record<string, unknown>) => JSON.stringify({ parentUuid: null, isSidechain: false, uuid: `r${++n}`, sessionId, cwd, timestamp: new Date(Date.UTC(2026, 10, 24, 0, n)).toISOString(), ...fields }) + '\n';
  const goal = (fields: Record<string, unknown>, extra: Record<string, unknown> = {}) => record({ type: 'attachment', attachment: { type: 'goal_status', ...fields }, ...extra });
  const turns = (count: number) => Array.from({ length: count }, (_, i) => record({ type: 'user', message: { role: 'user', content: `question ${i}` } })
    + record({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '答'.repeat(400) + i }], stop_reason: 'end_turn' } })).join('');
  await writeFile(file, goal({ met: false, sentinel: true, condition: 'Old goal' }) + turns(10)
    + goal({ met: false, sentinel: true, condition: 'Ship the release' })
    // A copy of a goal record quoted in a message, a subagent's and another session's: none counts.
    + record({ type: 'user', message: { role: 'user', content: '{"attachment":{"type":"goal_status","met":true,"condition":"Ship the release"}}' } })
    + goal({ met: true, condition: 'Ship the release', reason: 'subagent' }, { isSidechain: true })
    + goal({ met: true, condition: 'Ship the release', reason: 'elsewhere' }, { sessionId: randomUUID() })
    + turns(200));
  const first = await backend.readSession(workspace, sessionId, false, [], true);
  assert.ok(first.olderCursor, 'the first page does not reach the goal');
  assert.ok(!first.jsonl.toString('utf8').includes('goal_status'));
  const probed = await backend.readGoalBefore(workspace, sessionId, first.olderCursor!);
  assert.deepEqual(probed?.attachment, { type: 'goal_status', met: false, sentinel: true, condition: 'Ship the release' });
  // Ended before the page: the probe reports the end (an ended goal is no current goal there).
  await writeFile(file, goal({ met: false, sentinel: true, condition: 'Ship the release' }) + goal({ met: true, sentinel: true, condition: 'Ship the release' }) + turns(200));
  const reread = await backend.readSession(workspace, sessionId, false, [], true);
  assert.equal(reread.reset, true);
  assert.deepEqual((await backend.readGoalBefore(workspace, sessionId, reread.olderCursor!))?.attachment, { type: 'goal_status', met: true, sentinel: true, condition: 'Ship the release' });
  // No goal before the page at all.
  await writeFile(file, turns(220));
  const none = await backend.readSession(workspace, sessionId, false, [], true);
  assert.equal(await backend.readGoalBefore(workspace, sessionId, none.olderCursor!), undefined);
});

test("matrix F1: the first page of a /goal turn begins at the command, past its set record; the turn still shows its setting", posix, async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'lectern-goal-page-')));
  const workspace: Workspace = { id: 'page', name: 'Goal', kind: 'local', cwd, claudeDir: join(cwd, 'config') };
  const dir = join(workspace.claudeDir!, 'projects', projectSlug(cwd));
  await mkdir(dir, { recursive: true });
  // Claude Code 2.1.331's own records of one /goal turn; the prompt snapshots and API dumps Lectern never
  // shows are stubs that keep their original size, so the bytes lie as they did (about 133 KB in all).
  const rows = readFileSync(new URL('./fixtures/goal-2.1.331/sized-session.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
  const sessionId = rows.find(row => typeof row.sessionId === 'string')!.sessionId as string, file = join(dir, sessionId + '.jsonl');
  const lines = rows.map(row => {
    const { _bytes, ...record } = row;
    if (typeof record.cwd === 'string') record.cwd = cwd;
    const text = JSON.stringify(record);
    return typeof _bytes === 'number' && _bytes > text.length + 20 ? JSON.stringify({ ...record, filler: 'x'.repeat(_bytes - text.length - 12) }) : text;
  });
  // The temporary folder's path (in every record's cwd) and the dropped usage change the length: size the
  // biggest snapshot's filler so that the first page (the last 128 KiB) starts inside the set record, as
  // it did in the matrix, whatever the platform's temporary paths (macOS: /var/folders/…).
  const bytes = (list: string[]) => list.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
  const set = lines.findIndex(line => line.includes('"sentinel":true')), biggest = lines.reduce((a, line, i) => line.length > lines[a].length ? i : a, 0);
  const filler = /"filler":"(x*)"/u.exec(lines[biggest])![1].length;
  const size = filler + bytes(lines.slice(0, set)) + 128 * 1024 + 40 - bytes(lines);
  assert.ok(size > 0, `the snapshot's filler (${filler} bytes) absorbs the paths' length`);
  lines[biggest] = lines[biggest].replace(/"filler":"x*"/u, `"filler":"${'x'.repeat(size)}"`);
  await writeFile(file, lines.join('\n') + '\n');
  const backend = new Backend({ tmuxSocket: 'page-' + sessionId, claudeCommand: 'false' });
  t.after(async () => { await backend.dispose(); await rm(cwd, { recursive: true, force: true }); });
  const first = await backend.readSession(workspace, sessionId, false, [], true);
  const page = first.jsonl.toString('utf8');
  assert.ok(first.olderCursor, 'the file is longer than the first page');
  assert.ok(page.includes('<command-name>/goal</command-name>') && !page.includes('"sentinel":true'), 'the page begins at the command, without its set record');
  const display = new MessageDisplay(sessionId);
  display.ingestJsonl(first.jsonl, true, true);
  const kinds = display.getMessages().flatMap(message => message.taskNotifications ?? []).map(notice => notice.goal?.kind);
  assert.deepEqual(kinds, ['set', 'not-met', 'met']);
  assert.deepEqual([display.goal?.source, display.goal?.current?.status], ['transcript', 'met']);
});
