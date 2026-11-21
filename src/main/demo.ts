import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Backend } from '../backend';
import type { Workspace } from '../shared/types';
import { WorkspaceStore } from './store';
import { t } from '../shared/i18n';

export async function setupDemo(root: string, fixturePath = 'scripts/mock-claude.mjs') {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'lectern-demo-')));
  const cwd = path.join(directory, 'workspace');
  const config = path.join(directory, 'claude-fixture');
  const socket = `lectern-demo-${process.pid}`;
  await mkdir(cwd, { recursive: true });
  const store = new WorkspaceStore(path.join(directory, 'preferences'));
  const workspace: Workspace = { id: 'demo-local', name: t('demo.folder'), kind: 'local', cwd, claudeDir: config };
  await store.save(workspace);
  const id = randomUUID();
  const project = path.join(config, 'projects', cwd.replace(/[^a-zA-Z0-9-]/g, '-'));
  await mkdir(project, { recursive: true });
  const date = new Date().toISOString();
  const records = [
    { type: 'custom-title', customTitle: t('demo.title'), sessionId: id },
    { type: 'user', uuid: randomUUID(), sessionId: id, cwd, timestamp: date, message: { role: 'user', content: t('demo.question') } },
    { type: 'assistant', uuid: randomUUID(), sessionId: id, cwd, timestamp: date, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: t('demo.answer') }], stop_reason: 'end_turn' } },
  ];
  await writeFile(path.join(project, `${id}.jsonl`), records.map(r => JSON.stringify(r)).join('\n') + '\n');
  // Test hook: a folder on an SSH machine that cannot be reached (a documentation address),
  // with an empty ssh_config so the user's own configuration plays no part.
  const sshHost = process.env.LECTERN_DEMO_SSH_HOST, sshConfig = path.join(directory, 'ssh_config');
  if (sshHost) {
    await writeFile(sshConfig, '');
    await store.save({ id: 'demo-ssh', name: t('demo.sshFolder'), kind: 'ssh', host: sshHost, cwd: '~/project', historyScan: false });
  }
  const backend = new Backend({
    ...(sshHost && { sshConfigPath: sshConfig }),
    tmuxSocket: socket,
    claudeCommand: process.env.LECTERN_NODE_BINARY || 'node',
    claudeArgs: [path.join(root, fixturePath), '--fixture-config', config],
    // Read on every command, so a test can slow the machine down (as over SSH) or
    // fail one kind of command mid-run.
    rehearsal: tag => ({ delayMs: Number(process.env.LECTERN_DEMO_LATENCY_MS) || 0,
      error: tag && tag === process.env.LECTERN_DEMO_FAIL_TAG ? `Rehearsed failure: ${tag}` : undefined }),
  });
  await backend.resumeSession(workspace, id);
  return {
    store, backend,
    cleanup: async () => {
      backend.dispose();
      // Test hook (read when quitting): conversations left running stay in the private tmux
      // server, which the test inspects and then kills, together with this directory.
      if (process.env.LECTERN_DEMO_KEEP_TMUX === '1') return;
      await promisify(execFile)('tmux', ['-L', socket, 'kill-server']).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    },
  };
}
