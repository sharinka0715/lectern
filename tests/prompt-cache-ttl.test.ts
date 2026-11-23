import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend, quoteShell, runCommand } from '../src/backend';
import { launchPreferences, promptCacheTtlPreset, promptCacheTtlPresetOf, promptCacheTtlPresets, promptCacheTtls } from '../src/shared/prompt-cache';
import { defaultSessionOptions, loadDesktopState } from '../src/renderer/desktop-state';
import type { Workspace } from '../src/shared/types';

test('the prompt-cache setting is one of four presets; anything else is the default', () => {
  assert.deepEqual(promptCacheTtlPresets, ['default', 'both-5m', 'both-1h', 'main-1h-other-5m']);
  for (const preset of promptCacheTtlPresets) assert.equal(promptCacheTtlPreset(preset), preset);
  for (const value of ['', '5m', '1h', 'main-5m-other-1h', 'Both-5m', 60, null, undefined, {}]) assert.equal(promptCacheTtlPreset(value), 'default');
  // What each preset means for the main conversation and the other requests.
  assert.equal(promptCacheTtls('default'), undefined);
  assert.deepEqual(promptCacheTtls('both-5m'), { main: '5m', other: '5m' });
  assert.deepEqual(promptCacheTtls('both-1h'), { main: '1h', other: '1h' });
  assert.deepEqual(promptCacheTtls('main-1h-other-5m'), { main: '1h', other: '5m' });
  assert.equal(promptCacheTtls('main-5m-other-1h'), undefined);
  assert.deepEqual(launchPreferences(undefined), { enableWorkflows: true, promptCacheTtlPreset: 'default' });
  assert.deepEqual(launchPreferences({ enableWorkflows: false, promptCacheTtlPreset: 'both-1h' }), { enableWorkflows: false, promptCacheTtlPreset: 'both-1h' });
  assert.deepEqual(launchPreferences({ enableWorkflows: true, promptCacheTtlPreset: 'x' as never }), { enableWorkflows: true, promptCacheTtlPreset: 'default' });
});

test('the preset is stored with the other session options; the two old choices carry over only as a preset', () => {
  const read = (value: unknown) => loadDesktopState({ getItem: () => JSON.stringify(value) }).promptCacheTtlPreset;
  assert.equal(read({}), 'default');
  for (const preset of promptCacheTtlPresets) assert.equal(read({ promptCacheTtlPreset: preset }), preset);
  assert.equal(read({ promptCacheTtlPreset: '2h' }), 'default');
  assert.equal(loadDesktopState({ getItem: () => JSON.stringify({ promptCacheTtlPreset: 'both-5m', enableWorkflows: false }) }).enableWorkflows, false, 'other session options are kept');
  // Development builds of 0.2.2 stored the main conversation's and the other requests' lifetimes separately.
  assert.equal(read({ promptCacheTtl: '', subagentPromptCacheTtl: '' }), 'default');
  assert.equal(read({ promptCacheTtl: '5m', subagentPromptCacheTtl: '5m' }), 'both-5m');
  assert.equal(read({ promptCacheTtl: '1h', subagentPromptCacheTtl: '1h' }), 'both-1h');
  assert.equal(read({ promptCacheTtl: '1h', subagentPromptCacheTtl: '5m' }), 'main-1h-other-5m');
  for (const [main, other] of [['5m', '1h'], ['1h', ''], ['', '5m'], ['2h', 5]]) assert.equal(read({ promptCacheTtl: main, subagentPromptCacheTtl: other }), 'default', `${main}+${other}`);
  assert.equal(promptCacheTtlPresetOf(undefined, undefined), 'default');
  // The new key wins over leftovers of the old ones.
  assert.equal(read({ promptCacheTtlPreset: 'default', promptCacheTtl: '1h', subagentPromptCacheTtl: '1h' }), 'default');
  // "Restore defaults" on the Session page writes defaultSessionOptions.
  assert.equal(defaultSessionOptions.promptCacheTtlPreset, 'default');
});

test('new and resumed chats get the chosen preset\'s cache lifetimes in --settings; the default adds nothing', { skip: process.platform === 'win32', timeout: 40_000 }, async t => {
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

    backend.setLaunchPreferences({ enableWorkflows: true, promptCacheTtlPreset: 'main-1h-other-5m' });
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

    // Back to the default: a resume adds nothing again.
    backend.setLaunchPreferences({ enableWorkflows: true, promptCacheTtlPreset: 'default' });
    await resume(chosen.id);
    const [, again] = await launches(chosen.id, 2);
    assert.equal(again.resume, true);
    assert.equal('env' in again.settings, false);
    // A combination that is not offered (main 5m, others 1h) is the default too; a preset sets both.
    backend.setLaunchPreferences({ enableWorkflows: true, promptCacheTtlPreset: 'main-5m-other-1h' as never });
    const odd = await backend.createSession(workspace);
    assert.equal('env' in (await launches(odd.id, 1))[0].settings, false);
    backend.setLaunchPreferences({ enableWorkflows: true, promptCacheTtlPreset: 'both-5m' });
    const short = await backend.createSession(workspace);
    assert.deepEqual((await launches(short.id, 1))[0].settings.env, { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m' });
  } finally {
    await backend.dispose();
    await runCommand(workspace, 'tmux -L ' + quoteShell(socket) + ' kill-server 2>/dev/null || true');
    await rm(root, { recursive: true, force: true });
  }
});
