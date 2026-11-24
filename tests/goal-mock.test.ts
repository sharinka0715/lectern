import { fixtureClaudeConfig } from './helpers/claude-config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Backend, quoteShell, runCommand } from '../src/backend';
import { MessageDisplay } from '../src/core/message-display';
import { turnComposer } from '../src/core/turn-controls';
import type { Workspace } from '../src/shared/types';

// The offline mock's /goal (scripts/mock-claude.mjs) in a real tmux, driven through the backend: the
// indicator ticks every 25 ms so it can change between the reads of a guarded key.
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const numberedTail = (screen: string) => screen.trimEnd().split('\n')
  .map((line, index) => `${index + 1} | ${line}`).slice(-12).join('\n');
test('with the goal indicator ticking above the input box: /goal clear during a reply, an inline switch, the stop key', { skip: process.platform === 'win32', timeout: 90_000 }, async t => {
  // Split inside the timer and across the editor as it moves. A single cut keeps the redraw short.
  const mockEnv = {
    LECTERN_MOCK_GOAL_TICK_MS: '25',
    LECTERN_MOCK_STREAM_MS: '60',
    LECTERN_MOCK_GOAL_EVAL_MS: process.env.LECTERN_MOCK_GOAL_EVAL_MS ?? '850',
    LECTERN_MOCK_CHUNK_BYTES: process.env.LECTERN_MOCK_CHUNK_BYTES ?? '216',
    LECTERN_MOCK_CHUNK_MS: process.env.LECTERN_MOCK_CHUNK_MS ?? '5',
    LECTERN_MOCK_CHUNK_GOAL_ROW: '1',
    LECTERN_MOCK_CHUNK_SPLIT_AT: process.env.LECTERN_MOCK_CHUNK_SPLIT_AT ?? '0,768',
  };
  const saved = Object.keys(mockEnv).map(key => [key, process.env[key]] as const);
  Object.assign(process.env, mockEnv);
  t.after(() => { for (const [key, value] of saved)
    if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lectern-goal-mock-')));
  const workspace: Workspace = { id: 'goal-' + randomUUID().slice(0, 6), name: 'Goal', kind: 'local', cwd: root };
  fixtureClaudeConfig(join(root, 'config'));
  const socket = 'goal-' + randomUUID().slice(0, 8);
  const backend = new Backend({ tmuxSocket: socket, claudeCommand: process.execPath,
    claudeArgs: [resolve('scripts/mock-claude.mjs'), '--fixture-config', join(root, 'config'), '--alias-models'] });
  try {
    try { await runCommand(workspace, 'command -v tmux'); } catch { t.skip('tmux unavailable'); return; }
    const capture = async (pane: string) => (await runCommand(workspace, ['tmux', '-L', socket, 'capture-pane', '-p', '-t', pane].map(quoteShell).join(' '))).stdout.toString();
    const until = async (pane: string, test: (screen: string) => boolean, label: string) => {
      for (let i = 0; i < 400; i++) { const screen = await capture(pane); if (test(screen)) return screen; await pause(25); }
      assert.fail(`never: ${label}\n${numberedTail(await capture(pane))}`);
    };
    const session = await backend.createSession(workspace), paneId = session.paneId!;
    const withPaneFrames = async (label: string, action: (beforeAction: (screen: string) => void) => Promise<void>) => {
      let before = await capture(paneId);
      try { await action(screen => { before = screen; }); }
      catch (cause) {
        const failedFrame = () => capture(paneId).catch(() => '(capture-pane unavailable)');
        const after = await failedFrame();
        await pause(25);
        const later = await failedFrame();
        const frames = [`before:\n${numberedTail(before)}`, `after:\n${numberedTail(after)}`, `25 ms later:\n${numberedTail(later)}`];
        throw new Error(`${label}: ${String(cause)}\n${frames.join('\n')}`, { cause });
      }
    };
    await until(paneId, screen => screen.includes('shortcuts'), 'ready');
    const pid = Number((await runCommand(workspace, ['tmux', '-L', socket, 'display-message', '-p', '-t', paneId, '#{pane_pid}'].map(quoteShell).join(' '))).stdout.toString());
    // A goal whose reply goes on: /goal clear typed during it runs at once and writes only the cleared record.
    await backend.sendMessage(workspace, session.id, '/goal Hold the reply goal-hold');
    await until(paneId, screen => /Still working on step two/u.test(screen) && /◎ \/goal active \(\d+s\)/u.test(screen), 'held reply');
    await backend.turnAction(workspace, session.id, paneId, pid, { kind: 'command', text: '/goal clear' });
    await until(paneId, screen => /Goal cleared: Hold the reply goal-hold/u.test(screen), 'cleared notice');
    assert.match(await capture(paneId), /esc to interrupt/u, 'the reply goes on until released');
    await writeFile(join(join(root, 'config'), 'mock-release'), '');
    await until(paneId, screen => !/esc to interrupt/u.test(screen) && /shortcuts/u.test(screen), 'the reply ended');
    // A goal left paused and active: its timer ticks over the idle box; an inline switch's paste and Enter pass.
    await backend.sendMessage(workspace, session.id, '/goal Pause after two checks goal-pause');
    await until(paneId, screen => /Goal paused · goal checks kept finding/u.test(screen) && /shortcuts/u.test(screen) && /◎ \/goal active \(\d+s\)/u.test(screen), 'paused');
    const catalog = await backend.probeModelCatalog(workspace);
    const ticket = backend.bindSettingChoices(workspace, session.id, paneId, { kind: 'model', command: '/model', complete: true,
      options: catalog.models.map(row => ({ label: row.label, description: row.description, value: row.value })) });
    await withPaneFrames('inline model switch', async () => {
      const verified = await backend.setSessionSetting(workspace, session.id, ticket.token, ticket.options.find(option => option.label === 'Haiku')!.id, undefined, 'inline');
      assert.equal(verified.options.find(option => option.current)?.label, 'Haiku');
    });
    // A reply under the ticking goal stops on the first key.
    await withPaneFrames('stop', async beforeAction => {
      await backend.sendMessage(workspace, session.id, 'mock-hold reply while the goal timer ticks');
      const replying = await until(paneId, screen => {
        // The mock draws the spinner before the editor. Wait for the lower rule and footer too.
        const editor = turnComposer(screen);
        return !!editor?.running && screen.split('\n')[editor.top + 3]?.trim() === '⏸ manual mode on · ? for shortcuts';
      }, 'replying');
      beforeAction(replying);
      await backend.turnAction(workspace, session.id, paneId, pid, { kind: 'stop' });
      await until(paneId, screen => !/esc to interrupt/u.test(screen), 'stopped');
    });
    // The records Claude Code would write: as Lectern reads them.
    const file = (await backend.discover(workspace)).sessions.find(item => item.id === session.id)!.path!;
    const display = new MessageDisplay(session.id);
    display.ingestJsonl(await readFile(file), true, false);
    const rows = display.getMessages().filter(m => m.role === 'assistant').map(m => (m.taskNotifications ?? []).map(n => n.goal?.kind ?? 'task').join(' '));
    assert.deepEqual(rows.filter(Boolean), ['set not-met cleared', 'set not-met paused']);
    assert.deepEqual([display.goals.current?.status, display.goals.current?.condition], ['active', 'Pause after two checks goal-pause']);
    const records = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.ok(!records.some(record => record.type === 'system' && /<command-args>clear<\/command-args>/u.test(record.content ?? '')), 'a busy clear writes no command record');
  } finally {
    await backend.dispose();
    await runCommand(workspace, 'tmux -L ' + quoteShell(socket) + ' kill-server 2>/dev/null || true');
    await rm(root, { recursive: true, force: true });
  }
});
