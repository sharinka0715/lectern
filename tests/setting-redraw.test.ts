import { fixtureClaudeConfig } from './helpers/claude-config';
import { isolateTmux } from './helpers/private-tmux';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Backend, runCommand } from '../src/backend';
import type { Workspace } from '../src/shared/types';
import { readFixtureSetting } from './support/read-fixture-setting';

test('a late native repaint can acknowledge the first paste without another paste or Enter', { skip: process.platform === 'win32' }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lectern-late-prompt-')));
  const socket = 'late-prompt-' + randomUUID().slice(0, 8);
  const privateServer = isolateTmux(socket);
  const ws: Workspace = { id: 'late-prompt', kind: 'local', name: 'Delayed prompt', cwd: root };
  fixtureClaudeConfig(join(root, 'config'));
  const backend = new Backend({ tmuxSocket: socket, claudeCommand: process.execPath,
    claudeArgs: [resolve('scripts/mock-claude.mjs'), '--fixture-config', join(root, 'config'), '--delayed-setting-redraw'] });
  try {
    try { await runCommand(ws, 'command -v tmux'); } catch { t.skip('tmux unavailable'); return; }
    const session = await backend.createSession(ws);
    for (let i = 0; i < 60; i++) {
      if ((await backend.readSession(ws, session.id, true)).viewport?.includes('shortcuts')) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const transport = (backend as any).transport;
    const run = transport.run.bind(transport);
    let pastes = 0, enters = 0;
    transport.run = async (workspace: Workspace, script: string, options: object) => {
      if (script.includes("'paste-buffer'")) pastes++;
      if (script.includes("'send-keys'") && script.includes("'Enter'")) enters++;
      return run(workspace, script, options);
    };
    for (const kind of ['model', 'effort'] as const) {
      pastes = enters = 0;
      const menu = await readFixtureSetting(backend, ws, session.id, kind);
      assert.equal(menu.complete, true);
      assert.equal(pastes, 1);
      assert.equal(enters, 1);
    }
  } finally {
    await backend.dispose();
    privateServer.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
