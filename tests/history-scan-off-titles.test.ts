import { fixtureClaudeConfig } from './helpers/claude-config';
import { isolateTmux } from './helpers/private-tmux';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Backend, quoteShell, runCommand } from '../src/backend';
import type { Workspace } from '../src/shared/types';

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

// A folder added without a history scan lists only its running panes. Their titles still
// come from their own transcripts: the first prompt, then a /rename.
test('a folder without a history scan titles its running conversations from their transcripts only', { skip: process.platform === 'win32', timeout: 60_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lectern-scan-off-')));
  const config = join(root, 'config'), cwd = join(root, 'work');
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, 'notes.md'), '# Notes\n');
  const workspace: Workspace = { id: 'scan-off-' + randomUUID().slice(0, 6), name: 'Work', kind: 'local', cwd, historyScan: false };
  fixtureClaudeConfig(config);
  const socket = 'scan-off-' + randomUUID().slice(0, 8);
  const privateServer = isolateTmux(socket);
  const backend = new Backend({ tmuxSocket: socket, claudeCommand: process.execPath,
    claudeArgs: [resolve('scripts/mock-claude.mjs'), '--fixture-config', config, '--alias-models'] });
  try {
    try { await runCommand(workspace, 'command -v tmux'); } catch { t.skip('tmux unavailable'); return; }
    const capture = async (pane: string) => (await runCommand(workspace, ['tmux', ...privateServer.args('capture-pane', '-p', '-t', pane)].map(quoteShell).join(' '))).stdout.toString();
    const until = async <T>(read: () => Promise<T>, ok: (value: T) => boolean, label: string) => {
      let value = await read();
      for (let i = 0; i < 200 && !ok(value); i++) { await pause(50); value = await read(); }
      assert.ok(ok(value), `never: ${label} (${JSON.stringify(value)})`);
      return value;
    };
    const session = await backend.createSession(workspace), paneId = session.paneId!;
    await until(() => capture(paneId), screen => screen.includes('shortcuts'), 'ready');
    const title = async () => (await backend.discover(workspace)).sessions.find(item => item.id === session.id)?.title;
    await backend.sendMessage(workspace, session.id, 'Summarise the annotation versions');
    await until(title, value => value === 'Summarise the annotation versions', 'the first prompt titles it');
    await until(() => capture(paneId), screen => !/esc to interrupt/u.test(screen) && screen.includes('shortcuts'), 'idle');
    await backend.sendMessage(workspace, session.id, '/rename Annotation overview');
    await until(title, value => value === 'Annotation overview', 'a rename titles it');
    // Old history in the same folder stays unlisted until the user asks for a scan.
    const project = (await backend.discover(workspace)).sessions.find(item => item.id === session.id)!.path!.replace(/\/[^/]+$/, '');
    const old = randomUUID();
    await writeFile(join(project, `${old}.jsonl`), JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: old, cwd, timestamp: new Date().toISOString(), message: { role: 'user', content: 'An old conversation' } }) + '\n');
    const listed = (await backend.discover(workspace)).sessions.map(item => item.id);
    assert.deepEqual(listed, [session.id]);
    // "Scan all conversations" saves the folder without the flag, while the open conversation keeps
    // reading with the folder it was opened with: neither is an edit (WorkspaceChangedError, lost caches).
    const { historyScan: _, ...scanned } = workspace;
    let invalidations = 0;
    const invalidate = backend.invalidateWorkspace.bind(backend);
    backend.invalidateWorkspace = id => { invalidations++; invalidate(id); };
    for (let i = 0; i < 3; i++) await Promise.all([backend.readSession(workspace, session.id), backend.discover(scanned)]);
    assert.equal(invalidations, 0);
    assert.deepEqual((await backend.discover(scanned)).sessions.map(item => item.id).sort(), [session.id, old].sort());
    // A new chat's @ list in the same folder meanwhile: invalidating the folder cancelled it and dropped its file index.
    for (let i = 0; i < 3; i++) {
      const [files] = await Promise.all([backend.completions.query(scanned, 'primary', `mention-${i}`, { kind: 'mention', prefix: 'no' }), backend.readSession(workspace, session.id)]);
      assert.deepEqual(files.map(item => item.value), ['notes.md']);
    }
  } finally {
    await backend.dispose();
    privateServer.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
