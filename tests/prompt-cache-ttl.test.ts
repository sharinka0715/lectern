import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend, quoteShell, runCommand } from '../src/backend';
import { launchPreferences, promptCacheTtlChoice } from '../src/shared/prompt-cache';
import { defaultSessionOptions, loadDesktopState } from '../src/renderer/desktop-state';
import type { Workspace } from '../src/shared/types';

test('a prompt-cache choice is 5m, 1h or the default; anything else is the default', () => {
  for (const value of ['5m', '1h'] as const) assert.equal(promptCacheTtlChoice(value), value);
  for (const value of ['', '30m', '1H', 60, null, undefined, {}]) assert.equal(promptCacheTtlChoice(value), '');
  assert.deepEqual(launchPreferences(undefined), { enableWorkflows: true, promptCacheTtl: '', subagentPromptCacheTtl: '' });
  assert.deepEqual(launchPreferences({ enableWorkflows: false, promptCacheTtl: '1h', subagentPromptCacheTtl: 'x' as never }),
    { enableWorkflows: false, promptCacheTtl: '1h', subagentPromptCacheTtl: '' });
});

test('the cache lifetimes are stored with the other session options and default to Claude Code\'s', () => {
  const read = (value: unknown) => loadDesktopState({ getItem: () => JSON.stringify(value) });
  assert.equal(read({}).promptCacheTtl, '');
  assert.equal(read({}).subagentPromptCacheTtl, '');
  const saved = read({ promptCacheTtl: '1h', subagentPromptCacheTtl: '5m', enableWorkflows: false });
  assert.equal(saved.promptCacheTtl, '1h');
  assert.equal(saved.subagentPromptCacheTtl, '5m');
  assert.equal(saved.enableWorkflows, false, 'other session options are kept');
  const broken = read({ promptCacheTtl: '2h', subagentPromptCacheTtl: 5 });
  assert.equal(broken.promptCacheTtl, '');
  assert.equal(broken.subagentPromptCacheTtl, '');
  // "Restore defaults" on the Session page writes defaultSessionOptions.
  assert.equal(defaultSessionOptions.promptCacheTtl, '');
  assert.equal(defaultSessionOptions.subagentPromptCacheTtl, '');
});

test('new and resumed chats get the chosen cache lifetimes in --settings; the default adds nothing', { skip: process.platform === 'win32', timeout: 40_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lectern-cache-ttl-')));
  const config = join(root, 'config');
  const workspace: Workspace = { id: randomUUID(), name: 'fixture', kind: 'local', cwd: root, claudeDir: config };
  const socket = 'cache-ttl-' + randomUUID().slice(0, 8), exe = join(root, 'claude'), fixture = join(root, 'fixture.mjs');
  // A custom executable named claude gets the same per-launch settings as the real CLI.
  const backend = new Backend({ claudeCommand: exe, tmuxSocket: socket, claudeArgs: [fixture] });
  try {
    try { await runCommand(workspace, 'command -v tmux'); } catch { t.skip('tmux unavailable'); return; }
    await mkdir(config);
    await symlink(process.execPath, exe);
    // Records each launch (new or resumed, its --settings and the variables its shell exported),
    // leaves a one-prompt transcript so the chat can be resumed, and exits.
    await writeFile(fixture, `import fs from 'node:fs'; import path from 'node:path';
      const args = process.argv.slice(2), id = args.at(-1);
      const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, id + '.jsonl');
      if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ type: 'user', sessionId: id, cwd: process.cwd(), uuid: 'question', message: { role: 'user', content: 'cache lifetimes' } }) + '\\n');
      fs.appendFileSync(${JSON.stringify(root)} + '/' + id + '.launches', JSON.stringify({ resume: args.includes('--resume'),
        settings: JSON.parse(args[args.indexOf('--settings') + 1]), exported: process.env.CLAUDE_CODE_PROMPT_CACHE_TTL ?? null }) + '\\n');
      setTimeout(() => process.exit(0), 200);`);
    const launches = async (id: string, count: number) => {
      for (let i = 0; i < 200; i++) {
        const rows = (await readFile(join(root, id + '.launches'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
        if (rows.length >= count) return rows;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.fail(`launch ${count} of ${id} did not happen`);
    };
    /** Resume once the previous process has exited and its pane is gone. */
    const resume = async (id: string) => {
      for (let i = 0; i < 100; i++) {
        const panes = (await runCommand(workspace, `tmux -L ${quoteShell(socket)} list-panes -a -F '#{pane_id}' 2>/dev/null || true`)).stdout.toString().trim();
        if (!panes) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await backend.resumeSession(workspace, id);
    };
    const plain = await backend.createSession(workspace);
    const [first] = await launches(plain.id, 1);
    assert.equal(first.resume, false);
    assert.equal('env' in first.settings, false, 'the default leaves the cache lifetimes to Claude Code');

    backend.setLaunchPreferences({ enableWorkflows: true, promptCacheTtl: '1h', subagentPromptCacheTtl: '5m' });
    const chosen = await backend.createSession(workspace);
    const [created] = await launches(chosen.id, 1);
    assert.deepEqual(created.settings.env, { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m' });
    assert.deepEqual(created.settings.permissions, { defaultMode: 'auto' });
    assert.equal(created.exported, process.env.CLAUDE_CODE_PROMPT_CACHE_TTL ?? null, 'nothing is exported in the launch shell');
    // The chat started before the choice gets it when it is resumed.
    await resume(plain.id);
    const [, resumed] = await launches(plain.id, 2);
    assert.equal(resumed.resume, true);
    assert.deepEqual(resumed.settings.env, created.settings.env);

    // Back to the default: a resume adds nothing again; only the subagent choice: only its variable.
    backend.setLaunchPreferences({ enableWorkflows: true, promptCacheTtl: '', subagentPromptCacheTtl: '' });
    await resume(chosen.id);
    const [, again] = await launches(chosen.id, 2);
    assert.equal(again.resume, true);
    assert.equal('env' in again.settings, false);
    backend.setLaunchPreferences({ enableWorkflows: true, subagentPromptCacheTtl: '1h' });
    const other = await backend.createSession(workspace);
    assert.deepEqual((await launches(other.id, 1))[0].settings.env, { CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' });
  } finally {
    await backend.dispose();
    await runCommand(workspace, 'tmux -L ' + quoteShell(socket) + ' kill-server 2>/dev/null || true');
    await rm(root, { recursive: true, force: true });
  }
});
