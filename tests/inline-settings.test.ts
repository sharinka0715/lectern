import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Backend, quoteShell, runCommand } from '../src/backend';
import { inlineSettingArgument, type SettingChoices } from '../src/backend/native-settings';
import { readSettingReceipt } from '../src/core/settings-screen';
import type { Workspace } from '../src/shared/types';

test('native aliases, configured custom model IDs and effort levels switch inline; a model whose ID the menu hides keeps the menu', () => {
  const cases: [string, string | undefined, string | undefined][] = [
    ['Default (recommended)', 'Use the default model (currently Opus 5.5) · $4/$20 per Mtok', 'default'],
    ['Opus', 'Opus 5.5 · Best for everyday, complex tasks', 'opus'],
    ['Sonnet', 'Sonnet 5.5 · Efficient for routine tasks', 'sonnet'],
    ['Haiku', 'Haiku 5.5 · Fastest for quick answers', 'haiku'],
    ['Fable', 'Fable 5.2 · Most capable', 'fable'],
    ['Opus (1M context)', 'Opus 5.5 with 1M context', 'opus[1m]'],
    ['GPT-6-Luna (proxy)', 'codex/gpt-6-luna', undefined],
    ['Custom X', 'Custom model (gateway/custom-x)', 'gateway/custom-x'],
    ['gateway/custom-x', 'Custom model (gateway/custom-x)', 'gateway/custom-x'],
    ['Odd', 'Custom model (has space)', undefined],
    ['Gemini 4 Carbon', undefined, undefined],
    ['Default', 'Something else', undefined],
    ['Opus 4.1', 'Legacy', undefined],
  ];
  for (const [label, description, expected] of cases) assert.equal(inlineSettingArgument('model', { label, description }), expected, label);
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) assert.equal(inlineSettingArgument('effort', { label: level }), level);
  assert.equal(inlineSettingArgument('effort', { label: 'Quick' }), undefined);
});

test('with the SDK value, aliases and configured custom models switch inline; other IDs keep the session-only menu', () => {
  const cases: [string, string | undefined, string, string | undefined][] = [
    ['Opus 5.5', 'For complex work and everyday tasks', 'opus', 'opus'],
    ['Sonnet 5.5', 'Custom Sonnet model (gateway/claude-sonnet-5-5[1m])', 'sonnet', 'sonnet'],
    ['Opus (1M context)', 'Opus 5.5 with 1M context', 'opus[1m]', 'opus[1m]'],
    // 2.1.329's default row names the model directly; its receipt is not verifiable inline.
    ['Default (recommended)', 'Opus 5.5 · Best for everyday, complex tasks', 'default', undefined],
    ['Default (recommended)', 'Use the default model (currently Opus 5.5) · $4/$20 per Mtok', 'default', 'default'],
    // A gateway label "Fable" whose value is another model: never /model fable.
    ['Fable', 'Fable 5.1 · Most capable for your hardest and longest-running tasks', 'claude-fable-5-1[1m]', undefined],
    ['Opus 4.8', 'Best for everyday, complex tasks', 'claude-opus-4-8', undefined],
    ['GPT-6-Luna', 'Codex · user@example.com · via proxy', 'codex/gpt-6-luna', undefined],
    ['Custom X', 'Custom model (gateway/custom-x)', 'gateway/custom-x', 'gateway/custom-x'],
  ];
  for (const [label, description, value, expected] of cases) assert.equal(inlineSettingArgument('model', { label, description, value }), expected, `${label} ${value}`);
  assert.equal(inlineSettingArgument('effort', { label: 'xhigh', value: 'xhigh' }), 'xhigh');
  assert.equal(inlineSettingArgument('effort', { label: 'auto', value: 'auto' }), undefined);
});

/** One menu's rows from the machine's model list, as the main process binds them. */
async function listChoices(backend: Backend, workspace: Workspace, kind: 'model' | 'effort'): Promise<SettingChoices> {
  const catalog = await backend.probeModelCatalog(workspace);
  return kind === 'model'
    ? { kind, command: '/model', complete: true, options: catalog.models.map(row => ({ label: row.label, description: row.description, value: row.value })) }
    : { kind, command: '/effort', complete: true, options: catalog.models[0].efforts.map(level => ({ label: level, value: level })) };
}

test('the receipt of an inline command is read only under that exact typed line', () => {
  const frame = (typed: string, receipt: string) => `old line\n❯ ${typed}\n  ⎿  ${receipt}\n─────────────\n❯ \n─────────────\n  ⏵⏵ auto mode on (shift+tab to cycle)\n`;
  const receipt = 'Set model to Haiku 5.5 and saved as your default for new sessions';
  assert.equal(readSettingReceipt(frame('/model haiku', receipt), 'model', ['old line'], '/model haiku'), receipt);
  assert.equal(readSettingReceipt(frame('/model haiku', receipt), 'model', ['old line']), undefined, 'a bare /model transaction ignores it');
  assert.equal(readSettingReceipt(frame('/model sonnet', receipt), 'model', ['old line'], '/model haiku'), undefined);
});

async function withFixture(t: { skip(message: string): void }, aliases: boolean, body: (backend: Backend, workspace: Workspace, capture: (pane: string) => Promise<string>, socket: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lectern-inline-')));
  const workspace: Workspace = { id: 'inline-' + randomUUID().slice(0, 6), name: 'Inline', kind: 'local', cwd: root, claudeDir: join(root, 'config') };
  const socket = 'inline-' + randomUUID().slice(0, 8);
  const backend = new Backend({ tmuxSocket: socket, claudeCommand: process.execPath,
    claudeArgs: [resolve('scripts/mock-claude.mjs'), '--fixture-config', workspace.claudeDir!, ...(aliases ? ['--alias-models'] : [])] });
  try {
    try { await runCommand(workspace, 'command -v tmux'); } catch { t.skip('tmux unavailable'); return; }
    const capture = async (pane: string) => (await runCommand(workspace, ['tmux', '-L', socket, 'capture-pane', '-p', '-t', pane].map(quoteShell).join(' '))).stdout.toString();
    await body(backend, workspace, capture, socket);
  } finally {
    await backend.dispose();
    await runCommand(workspace, 'tmux -L ' + quoteShell(socket) + ' kill-server 2>/dev/null || true');
    await rm(root, { recursive: true, force: true });
  }
}

test('inline mode switches model and effort with one typed command each and never opens the menu', { skip: process.platform === 'win32', timeout: 30_000 }, async t => {
  await withFixture(t, true, async (backend, workspace, capture) => {
    const session = await backend.createSession(workspace), paneId = session.paneId!;
    for (let i = 0; i < 80 && !(await capture(paneId)).includes('shortcuts'); i++) await new Promise(r => setTimeout(r, 25));
    for (const [kind, label] of [['model', 'Haiku'], ['effort', 'high'], ['model', 'Custom X']] as const) {
      const ticket = backend.bindSettingChoices(workspace, session.id, paneId, await listChoices(backend, workspace, kind));
      const choice = ticket.options.find(option => option.label === label)!;
      const verified = await backend.setSessionSetting(workspace, session.id, ticket.token, choice.id, undefined, 'inline');
      assert.equal(verified.options.find(option => option.current)?.label, label);
      assert.match(verified.nativeFeedback ?? verified.detail ?? '', /saved as your default|^$/);
    }
    const screen = await capture(paneId);
    assert.match(screen, /❯ \/model haiku\n\s+⎿ Set model to Haiku 5\.5 and saved as your default/);
    assert.match(screen, /❯ \/effort high\n\s+⎿ Set effort level to high \(saved as your default/);
    assert.match(screen, /❯ \/model gateway\/custom-x\n\s+⎿ Set model to gateway\/custom-x and saved as your default/);
    assert.doesNotMatch(screen, /❯ \/(?:model|effort)\s*$/m, 'the business pane never showed a bare menu command');
  });
});

test('inline mode falls back to the session-only menu for a choice without an inline name', { skip: process.platform === 'win32', timeout: 30_000 }, async t => {
  await withFixture(t, false, async (backend, workspace, capture) => {
    const session = await backend.createSession(workspace), paneId = session.paneId!;
    for (let i = 0; i < 80 && !(await capture(paneId)).includes('shortcuts'); i++) await new Promise(r => setTimeout(r, 25));
    const ticket = backend.bindSettingChoices(workspace, session.id, paneId, await listChoices(backend, workspace, 'model'));
    const choice = ticket.options.find(option => option.label === 'Fixture Beta')!;
    const verified = await backend.setSessionSetting(workspace, session.id, ticket.token, choice.id, undefined, 'inline');
    assert.equal(verified.options.find(option => option.current)?.label, 'Fixture Beta');
    assert.match(await capture(paneId), /Set model to Fixture Beta for this session only/);
  });
});

test('two OSC-8 links on screen no longer erase the rows between them (custom model receipt)', async () => {
  const { stripTerminalEscapes } = await import('../src/core/screen');
  const link = (url: string) => `\x1b]8;id=x;${url}\x1b\\${url}\x1b]8;;\x1b\\`;
  const screen = [`▎ ${link('https://code.claude.com/docs/en/permission-modes')}`, '❯ /model gateway/custom-x',
    '  ⎿  Set model to gateway/custom-x and saved as your default for new sessions',
    `     ${link('https://code.claude.com/docs/en/model-config')} to set the window.`, '─'.repeat(40), '❯ ', '─'.repeat(40), '  ⏵⏵ auto mode on (shift+tab to cycle)', ''].join('\n');
  const plain = stripTerminalEscapes(screen);
  assert.match(plain, /❯ \/model gateway\/custom-x\n  ⎿  Set model to gateway\/custom-x/);
  assert.match(plain, /     https:\/\/code\.claude\.com\/docs\/en\/model-config to set the window\./);
  assert.equal(readSettingReceipt(screen, 'model', [], '/model gateway/custom-x'),
    'Set model to gateway/custom-x and saved as your default for new sessions https://code.claude.com/docs/en/model-config to set the window.');
});

// Claude Code 2.1.329+ lists running subagents below the input box, their timers ticking
// (tests/fixtures/task-rows-2.1.330/), and adds "↓ to manage" to the idle footer. The mock
// lists five, or seven ("↓ 2 more"), ticking every 250 ms, or every 40 ms for the stop key.
const listAgents = (workspace: Workspace, state: string) => mkdir(workspace.claudeDir!, { recursive: true })
  .then(() => writeFile(join(workspace.claudeDir!, 'screen-state'), state));
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

test('with subagents listed and ticking below the input box, inline and menu switches type, verify and read their receipt', { skip: process.platform === 'win32', timeout: 60_000 }, async t => {
  await withFixture(t, true, async (backend, workspace, capture) => {
    await listAgents(workspace, 'ready agents:5');
    const session = await backend.createSession(workspace), paneId = session.paneId!;
    const rounds = [
      ['agents:5', /↓ to manage\n\n {2}● main\n(?:.*第 \d 个子代理.*\n){4}.*第 5 个子代理/u, [['effort', 'high', 'inline'], ['model', 'Haiku', 'inline'], ['effort', 'low', 'menu'], ['model', 'Sonnet', 'menu']]],
      ['agents:7', /● main\n(?:.*\n){5} {2}↓ 2 more/u, [['effort', 'medium', 'inline'], ['model', 'Custom X', 'inline'], ['effort', 'high', 'menu'], ['model', 'Haiku', 'menu']]],
    ] as const;
    for (const [agents, listed, switches] of rounds) {
      await listAgents(workspace, `ready ${agents}`);
      for (let i = 0; i < 120 && !listed.test(await capture(paneId)); i++) await pause(25);
      for (const [kind, label, mode] of switches) {
        const ticket = backend.bindSettingChoices(workspace, session.id, paneId, await listChoices(backend, workspace, kind));
        const choice = ticket.options.find(option => option.label === label)!;
        const verified = await backend.setSessionSetting(workspace, session.id, ticket.token, choice.id, undefined, mode);
        assert.equal(verified.options.find(option => option.current)?.label, label, `${agents} ${mode} ${kind}`);
      }
      // The mock clears and redraws its whole screen at every tick: a read may catch a redraw half
      // done (on the macOS runner the pty hands it over in small pieces), so look a few times.
      let screen = await capture(paneId);
      for (let i = 0; i < 40 && !listed.test(screen); i++) { await pause(25); screen = await capture(paneId); }
      assert.match(screen, listed, `${agents} still listed`);
    }
    const screen = await capture(paneId);
    assert.match(screen, /❯ \/model gateway\/custom-x\n\s+⎿ Set model to gateway\/custom-x and saved as your default/);
    assert.match(screen, /Set effort level to high \(this session only\)/);
    assert.match(screen, /Set model to Haiku for this session only/);
  });
});

test('with subagents listed and ticking below the input box, the stop key is not refused', { skip: process.platform === 'win32', timeout: 60_000 }, async t => {
  await withFixture(t, true, async (backend, workspace, capture, socket) => {
    await listAgents(workspace, 'ready agents:7@40');
    const session = await backend.createSession(workspace), paneId = session.paneId!;
    for (let i = 0; i < 120 && !(await capture(paneId)).includes('↓ 2 more'); i++) await pause(25);
    const pid = Number((await runCommand(workspace, ['tmux', '-L', socket, 'display-message', '-p', '-t', paneId, '#{pane_pid}'].map(quoteShell).join(' '))).stdout.toString());
    await backend.sendMessage(workspace, session.id, 'a long reply to stop ' + '继续'.repeat(200));
    for (let i = 0; i < 120 && !(await capture(paneId)).includes('esc to interrupt'); i++) await pause(25);
    // A read of a redraw half done (40 ms ticks, see above) is refused before any key is sent: once more then.
    const stop = () => backend.turnAction(workspace, session.id, paneId, pid, { kind: 'stop' });
    await stop().catch(async error => {
      if (!/原生画面已变化|native screen changed/.test(String(error?.message))) throw error;
      await pause(100);
      await stop();
    });
    for (let i = 0; i < 120 && (await capture(paneId)).includes('esc to interrupt'); i++) await pause(25);
    assert.doesNotMatch(await capture(paneId), /esc to interrupt/, 'the reply stopped');
  });
});
