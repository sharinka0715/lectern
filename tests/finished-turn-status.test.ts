import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MessageDisplay } from '../src/core/message-display';
import { extractPreview } from '../src/core/screen';
import { parseExecutionMode } from '../src/core/session-telemetry';
import { paintBullets } from './helpers/claude-screen';

// Claude Code 2.1.329, captured with a loopback model: a reply that started a
// background shell and ended ("✻ Brewed for 0s · done 19:24 · 1 shell still
// running"), in a named session; its transcript ends with end_turn and turn_duration.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const screen = fixture('bgshell-2.1.329/screen.txt');
const lines = fixture('bgshell-2.1.329/session.jsonl').trim().split('\n');
const sessionId = JSON.parse(lines.find(line => line.includes('"sessionId"'))!).sessionId;
// Taken without colours: the reply's bullet is painted as Claude Code paints it (reply-rows.ts).
const painted = (view: string) => paintBullets(view, text => /^(?:已经改好|工作流已)/u.test(text));
const baked = screen.replace(/✻ Brewed for 0s · done 19:24 · 1 shell still running/u, '* Baked for 1m 41s · done 3:37 PM · 1 shell still running');

test('the status line above the input box is not part of the reply', () => {
  for (const view of [screen, baked]) {
    const preview = extractPreview(painted(view), '改一下表格', '', view);
    assert.equal(preview.status, 'idle');
    assert.match(preview.text, /原来那张表改成了文字列表。$/u);
    assert.doesNotMatch(preview.text, /done|still running/u);
  }
  const workflow = fixture('workflow-2.1.329/running.txt');
  assert.equal(extractPreview(painted(workflow), '运行工作流', '', workflow).text, '工作流已在后台运行。');
});

test('a finished turn read after its screen settles without waiting for turn_duration', () => {
  for (const view of [screen, baked]) {
    const display = new MessageDisplay(sessionId);
    const final = lines.findIndex(line => line.includes('"end_turn"'));
    display.ingestJsonl(Buffer.from(lines.slice(0, final).map(line => line + '\n').join('')));
    display.ingestScreen(painted(view), view);
    display.ingestJsonl(Buffer.from(lines[final] + '\n'));
    display.ingestScreen(painted(view), view);
    const last = display.getMessages().at(-1)!;
    assert.equal(last.status, 'complete');
    assert.doesNotMatch(last.text, /still running/u);
  }
});

test('the permission mode is read when background work replaces the cycle hint', () => {
  assert.equal(parseExecutionMode(screen)?.mode, 'acceptEdits');
  assert.equal(parseExecutionMode(screen.replace('accept edits on · 1 shell · ↓ to manage', 'auto mode on · 2 shells · ← for agents · ↓ to manage'))?.mode, 'auto');
  assert.equal(parseExecutionMode(fixture('workflow-2.1.329/running.txt'))?.mode, 'acceptEdits');
  assert.equal(parseExecutionMode(screen.replace('accept edits on · 1 shell · ↓ to manage', 'accept edits on · whatever this is')), undefined);
});

const withTaskFooter = (footer: string) => screen.replace('⏵⏵ accept edits on · 1 shell · ↓ to manage', footer);

test('the permission mode accepts comma-separated background task counts', () => {
  const cases = [
    // Claude Code 2.1.321, including the footer at 40 columns.
    ['⏵⏵ auto mode on · 1 shell, 1 monitor · ← for agents · ↓ to manage', 'auto'],
    ['⏵⏵ auto mode on · 1 shell, 1 monitor', 'auto'],
    ['⏵⏵ accept edits on · 2 shells, 2 monitors · ↓ to manage', 'acceptEdits'],
    ['⏸ plan mode on · 2 shells, 2 monitors · ↓ to manage', 'plan'],
    ['⏸ manual mode on · 2 shells, 2 monitors · ↓ to manage', 'default'],
    // Screenshot case and a synthetic mix of the other supported count types.
    ['⏵⏵ auto mode on · 1 shell, 1 monitor · ↓ to manage', 'auto'],
    ['⏵⏵ bypass permissions on · 2 agents, 1 workflow, 1 shell · ↓ to manage', 'bypassPermissions'],
  ];
  for (const [footer, mode] of cases) {
    assert.equal(parseExecutionMode(withTaskFooter(footer))?.mode, mode, footer);
  }
});

test('the permission mode accepts the aggregate background task count', () => {
  // Claude Code 2.1.331 with two shells, two monitors and an agent.
  const footer = '⏵⏵ auto mode on · 5 background tasks · ← for agents · ↓ to manage';
  assert.equal(parseExecutionMode(withTaskFooter(footer))?.mode, 'auto');
});

test('each comma-separated entry must be a complete task count', () => {
  for (const footer of [
    '⏵⏵ auto mode on · 1 shell, something else · ↓ to manage',
    '⏵⏵ auto mode on · 1 shell, ↓ to manage',
    '⏵⏵ auto mode on · 1 shell, 1',
    '⏵⏵ auto mode on · 1 shell,',
    '⏵⏵ auto mode on · 1 shell, 1 monitor · something else',
  ]) assert.equal(parseExecutionMode(withTaskFooter(footer)), undefined, footer);
});
