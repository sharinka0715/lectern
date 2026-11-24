// Feature scenarios for the compatibility matrix. Each scenario drives the
// desktop app against the real CLI and scripts the fake model through
// `api.script(name, fn)`; prompts carry `ccm:<name>` so the model knows which
// script answers. Rows (features) are what the coverage table reports.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { sel } from './app.mjs';
import { API_KEY, descendants, readJsonl, reap } from './sandbox.mjs';
import { textOf } from './fake-api.mjs';
import { compareVersions } from './versions.mjs';
import { hookStatus, launchedHooks, setDialogHooks } from '../fixtures/dialog-hooks.mjs';
import { previewQuestions } from './question-preview-input.mjs';

export const FEATURES = [
  { id: 'model-catalog', title: 'Model/effort lists from the stream-json control-request probe' },
  { id: 'launch-flags', title: 'New chat launches with the chosen --model/--effort' },
  { id: 'first-prompt', title: 'First prompt delivered once the native composer is ready' },
  { id: 'final-transcript', title: 'Final reply from the JSONL transcript' },
  { id: 'auto-mode-new', title: 'A new chat starts in auto mode (status bar)' },
  { id: 'auto-mode-user-manual', title: 'Auto mode even when the user\'s own default is manual, no blocking prompt' },
  { id: 'manual-fallback', title: 'Auto mode turned off (disableAutoMode): manual mode, permission cards' },
  { id: 'auto-mode-confirm', title: 'Auto mode asks after blocked actions: permission card with its reason' },
  { id: 'auto-mode-billing', title: 'Classifier billing notice (server check not passed through, before 2.1.321): card, cancel stops the turn, continue runs the action' },
  { id: 'auto-mode-unavailable', title: "Auto mode can't check actions (server check not passed through, 2.1.321+): card, stay, then the tool's own permission card" },
  { id: 'auto-mode-unavailable-leave', title: "Auto mode can't check actions: leave for accept edits mode from the card, the session goes on" },
  { id: 'trust-card', title: 'Directory trust prompt answered from the trust card' },
  { id: 'onboarding', title: 'Fresh config: first message waits for API-key approval and trust' },
  { id: 'streaming-preview', title: 'Streaming preview from the screen, then the JSONL reply' },
  { id: 'running-state', title: 'Running state detected (stop button, busy row)' },
  { id: 'tool-bash', title: 'Bash tool row with result' },
  { id: 'tool-read', title: 'Read tool row' },
  { id: 'tool-write', title: 'Write tool row (file created)' },
  { id: 'tool-edit', title: 'Edit tool row (file changed)' },
  { id: 'tool-error', title: 'Failed tool shown as an error' },
  { id: 'permission-allow', title: 'Permission card: allow' },
  { id: 'permission-deny', title: 'Permission card: deny (reply marked interrupted)' },
  { id: 'question-single', title: 'AskUserQuestion: single question' },
  { id: 'question-multi', title: 'AskUserQuestion: multi-question form with review' },
  { id: 'question-preview-multi', title: 'AskUserQuestion: mixed three-page form, preview and notes where available, reviewed and submitted with screen reading and hooks' },
  { id: 'question-single-long', title: 'AskUserQuestion: one long wrapped CJK question after a long preamble, wrapped option descriptions, named session' },
  { id: 'question-review-long', title: 'AskUserQuestion: review of long wrapped CJK questions in a named session (submit, cancel)' },
  { id: 'question-early', title: 'AskUserQuestion before the transcript has the call (the stream ends late): a card read off the screen, answered into its call' },
  { id: 'question-body', title: "AskUserQuestion whose question has blank lines, a list and wrapped rows, before the transcript has the call, in a named session: the card shows it as asked; a long answer of one's own typed from the card" },
  { id: 'hooks-launch', title: 'Recording hooks turned on in Settings → Session: a new chat\'s --settings has PreToolUse (AskUserQuestion only), PermissionRequest and SessionStart; Settings shows them active once SessionStart ran' },
  { id: 'hooks-question-tall', title: 'Recording hooks on: a question taller than the pane (its top cut off), before the transcript has the call: a card naming its call, text from the call\'s input, answered into it' },
  { id: 'hooks-permission', title: 'Recording hooks on: a permission card shows the call\'s whole input from its PermissionRequest hook, claims its call and approves it' },
  { id: 'hooks-off', title: 'Recording hooks turned off again: a new chat\'s --settings has no hooks, Settings says the screen is read' },
  { id: 'thinking', title: 'Thinking folded into a thought row' },
  { id: 'tasks', title: 'Task list tool (TodoWrite / TaskCreate)' },
  { id: 'queue', title: 'Queue a message during a reply' },
  { id: 'steer', title: 'Steer (send now) during a reply' },
  { id: 'interrupt', title: 'Interrupt a reply (stop button)' },
  { id: 'compact', title: '/compact with a message queued during compaction' },
  { id: 'rename', title: 'Rename a running session (/rename)' },
  { id: 'rewind-renamed', title: 'Rewind past one-step /model and /effort switches, right after renaming the session to a name too wide for the input box border, with a wrapped skill description among the /rewind completions' },
  { id: 'session-settings', title: 'Switch model and effort in a running session' },
  { id: 'statusline', title: 'Status line: model, context usage, billing route' },
  { id: 'background', title: 'Background shell and subagent ("running in background")' },
  { id: 'background-settings', title: 'Model and effort switched from the pickers after the reply while a background subagent still runs' },
  { id: 'preview-rows', title: "Live preview while background work runs: the reply's prose only, never the rows around it (waiting for agents, a subagent's message, folded and running commands, notifications)" },
  { id: 'subagent-column', title: "Subagent column: the subagent's own JSONL found, its turns shown live" },
  { id: 'subagent-resume', title: 'Subagent column: a SendMessage resume runs again with its new messages' },
  { id: 'subagent-listed', title: 'Subagents listed from their meta files on opening, their launches on a page not loaded (2.1.310+)' },
  { id: 'subagent-process-gone', title: 'A running subagent is no longer shown running once its conversation\'s process is gone (2.1.310+)' },
  { id: 'subagent-elsewhere', title: 'A subagent of the session resumed outside Lectern\'s panes shows running while that process lives (2.1.310+)' },
  { id: 'task-shell-output', title: "Task column: a background shell's command and its output file, appended while it runs" },
  { id: 'task-redirect-output', title: 'Task column: a background shell that redirected into a file shows that file' },
  { id: 'task-monitor-output', title: "Task column: a monitor's output file (where Monitor is offered)" },
  { id: 'close-in-place', title: 'Close conversation: the transcript stays mounted and turns into history' },
  { id: 'history-paging', title: 'Reopen a closed session: first page, then older history' },
  { id: 'resume', title: 'Resume a closed session (--resume) and continue' },
  { id: 'auto-mode-resume', title: 'A resumed session starts in auto mode (status bar)' },
  { id: 'rename-inactive', title: 'Rename a closed session (temporary resume)' },
  { id: 'attachment', title: 'Image attachment (@path) sent and shown' },
  { id: 'goal-lifecycle', title: '/goal sent from a new chat: not met (capsule, event row) while the continued turn runs, then met; the transcript has the setting sentinel, not met, met' },
  { id: 'goal-clear-busy', title: '/goal cleared from the capsule while a reply runs: only the clearing sentinel, capsule cleared, the native footer gone, no check after' },
  { id: 'goal-failed', title: '/goal the evaluator calls impossible: capsule and event row failed' },
  { id: 'goal-check-error', title: '/goal check without a usable answer: still active and retrying (capsule, event row), then /goal clear from the chat box' },
  { id: 'goal-resume', title: 'A conversation closed with its /goal active and resumed from Lectern: capsule still active, the native footer back' },
  { id: 'isolation', title: 'No request left the sandbox' },
  { id: 'cleanup', title: 'Nothing left running after the run' },
];

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const settingTrigger = kind => `.session-settings:not(.draft-settings) [data-setting-kind="${kind}"]`;

/** Pick an option of the composer's model or effort picker that matches `wanted` (patterns in order
 * of preference) and is not current. */
async function pickSetting({ page, note }, kind, wanted) {
  await page.waitForFunction(selector => !document.querySelector(selector)?.disabled, settingTrigger(kind), { timeout: 30_000 });
  await page.locator(settingTrigger(kind)).click();
  const menuSelector = `.session-settings:not(.draft-settings) [data-setting-menu="${kind}"]`;
  const menu = page.locator(menuSelector);
  const patterns = [wanted].flat();
  const choose = options => patterns.map(pattern => options.find(o => !o.current && !o.disabled && pattern.test(o.text))).find(Boolean);
  // The menu can show cached rows while a poll still sees the rename in progress.
  const { options, status } = await poll(() => page.evaluate(selector => {
    const menu = document.querySelector(selector);
    if (!menu) return { options: [], status: ['menu is closed'] };
    return {
      options: [...menu.querySelectorAll('.setting-option')].map(el => ({ id: el.dataset.optionId, text: el.textContent, current: el.dataset.current === 'true', disabled: el.disabled })),
      status: [...menu.querySelectorAll('[role="status"], [role="alert"]')].map(el => el.textContent.trim()),
    };
  }, menuSelector), ({ options }) => !!choose(options), 30_000);
  note(`${kind}-options`, options.map(o => o.text.slice(0, 40)));
  const option = choose(options);
  assert.ok(option, `no ${wanted} option among ${JSON.stringify(options)}\nMenu status: ${JSON.stringify(status)}`);
  await menu.locator(`.setting-option[data-option-id="${option.id}"]`).click();
  await menu.waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {});
  return option;
}
/** The status in the native record (`<config>/sessions/<pid>.json`) of the process running `sessionId`. */
async function nativeStatus(sandbox, sessionId) {
  const dir = path.join(sandbox.config, 'sessions');
  for (const name of await readdir(dir).catch(() => [])) {
    try {
      const record = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
      if (record?.sessionId === sessionId) return record.status ?? null;
    } catch {}
  }
}
/** `read()` again every `every` ms until `done(value)` or `ms` pass; the last value read. For files
 * Claude Code writes on its own schedule: a request reaching the fake API does not mean the
 * transcript (or a subagent's file) on disk has caught up with it. */
async function poll(read, done, ms = 20_000, every = 200) {
  for (const end = Date.now() + ms; ; await delay(every)) {
    const value = await read();
    if (done(value) || Date.now() >= end) return value;
  }
}
/** Close a tmux session the harness opened and wait until every process it ran has exited (exact
 * PIDs, as sandbox.close does); the ones that had to be stopped are returned. */
async function closeOwnSession(sandbox, name) {
  const root = Number(sandbox.tmux('display-message', '-p', '-t', `=${name}:`, '#{pane_pid}').trim());
  const tracked = root > 1 ? descendants(root) : [];
  sandbox.tmux('kill-session', '-t', `=${name}`);
  return reap(tracked);
}
/** Whether the global config is whole JSON that still approves the sandbox's API key. */
async function apiKeyApproval(sandbox) {
  const text = await readFile(path.join(sandbox.config, '.claude.json'), 'utf8').catch(error => `unreadable: ${error.code}`);
  try {
    const approved = JSON.parse(text).customApiKeyResponses?.approved ?? [];
    return { ok: approved.includes(API_KEY.slice(-20)), approved };
  } catch (error) { return { ok: false, error: `not JSON (${error.message})`, bytes: text.length }; }
}

/** A new chat in `folder` whose first message is `prompt`; resolves once Claude
 * Code has the message (it is in the transcript). */
async function startChat({ ui }, folder, prompt) {
  await ui.openDraft(folder.name);
  await ui.send(prompt);
  await ui.waitUser(prompt, 90_000);
}
/** The permission mode the status bar reports for the active chat. */
async function waitMode(page, mode, timeout = 30_000) {
  await page.waitForFunction(wanted => document.querySelector('.session-execution-mode')?.getAttribute('data-execution-mode') === wanted, mode, { timeout })
    .catch(async error => { throw new Error(`status bar mode ${await page.locator('.session-execution-mode').getAttribute('data-execution-mode').catch(() => '?')}, wanted ${mode}: ${error.message}`); });
}
const paragraph = 'The compatibility matrix streams this reply slowly so the desktop app can show it from the terminal before Claude Code writes the transcript. ';

/** Folders the app starts with. `main` pre-approves the file tools; `perm` turns
 * auto mode off and asks for every tool; `fresh` is not trusted yet; `onboard` uses
 * its own, barely used Claude configuration whose user prefers manual mode.
 * Lectern leaves auto mode's check on the server, which the fake API (a gateway to
 * Claude Code) never runs. The sandbox's configuration therefore sets
 * CLAUDE_CODE_AUTO_MODE_SERVER=0, so Claude Code checks actions itself and the
 * scenarios test what they are about (`onboard`, with a configuration of its own, only
 * gets plain replies). `server` has its own configuration without the variable: the
 * product's default path, which ends in a dialog (scenario server-check). */
export async function prepareFolders(sandbox) {
  const main = sandbox.work;
  const perm = path.join(sandbox.root, 'perm-work');
  const fresh = path.join(sandbox.root, 'fresh-work');
  // Background tasks run without permission questions: auto mode off, the tools allowed.
  const tasks = path.join(sandbox.root, 'tasks-work');
  const onboard = path.join(sandbox.root, 'onboard-work'), onboardConfig = path.join(sandbox.root, 'onboard-config');
  const server = path.join(sandbox.root, 'server-work'), serverConfig = path.join(sandbox.root, 'server-config');
  for (const dir of [perm, fresh, onboard, onboardConfig, server, serverConfig, path.join(tasks, '.claude')]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(tasks, '.claude', 'settings.json'), JSON.stringify({ permissions: { disableAutoMode: 'disable', allow: ['Bash', 'Monitor', 'ToolSearch', 'TaskStop'] } }));
  // Onboarding itself (theme, connectivity check against api.anthropic.com) cannot run
  // offline; this configuration has finished it and nothing else: the API key is not
  // approved yet and no folder is trusted.
  await writeFile(path.join(onboardConfig, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: sandbox.version, theme: 'dark' }));
  // ... and its user has chosen manual mode as the default (which makes Claude Code
  // offer "Make auto mode your default permission mode?" at startup).
  await writeFile(path.join(onboardConfig, 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'default' } }));
  // The permission folder turns auto mode off, Claude Code's documented opt-out
  // (permissions.disableAutoMode): sessions there start in manual mode and ask.
  await mkdir(path.join(perm, '.claude'), { recursive: true });
  await writeFile(path.join(perm, '.claude', 'settings.json'), JSON.stringify({ permissions: { disableAutoMode: 'disable' } }));
  await mkdir(path.join(main, '.claude'), { recursive: true });
  await writeFile(path.join(main, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite'] } }, null, 2));
  // Trust the permission folder too (the sandbox only seeded `main`).
  const configFile = path.join(sandbox.config, '.claude.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.projects[perm] = { ...config.projects[main] };
  config.projects[tasks] = { ...config.projects[main] };
  await writeFile(configFile, JSON.stringify(config, null, 2));
  // The same first-run state for `server` (onboarded, API key approved, folder trusted) and
  // the same settings, but not the variable that moves auto mode's check off the server.
  const settingsFile = path.join(sandbox.config, 'settings.json'), settings = JSON.parse(await readFile(settingsFile, 'utf8'));
  await writeFile(path.join(serverConfig, '.claude.json'), JSON.stringify({ ...config, projects: { [server]: { ...config.projects[main] } } }, null, 2));
  await writeFile(path.join(serverConfig, 'settings.json'), JSON.stringify(settings, null, 2));
  await writeFile(settingsFile, JSON.stringify({ ...settings, env: { CLAUDE_CODE_AUTO_MODE_SERVER: '0' } }, null, 2));
  return {
    main: { id: 'ccm-main', name: 'ccm-main', cwd: main },
    perm: { id: 'ccm-perm', name: 'ccm-perm', cwd: perm },
    fresh: { id: 'ccm-fresh', name: 'ccm-fresh', cwd: fresh },
    tasks: { id: 'ccm-tasks', name: 'ccm-tasks', cwd: tasks },
    onboard: { id: 'ccm-onboard', name: 'ccm-onboard', cwd: onboard, claudeDir: onboardConfig },
    server: { id: 'ccm-server', name: 'ccm-server', cwd: server, claudeDir: serverConfig },
  };
}

// /goal (Claude Code 2.1.139+, so every release here). The native footer right of the line above
// the input box while a goal is active: "◎ /goal active (12s)" (2.1.326+ also "◎ /goal paused").
const GOAL_FOOTER = /(?:^\s*|· )◎ \/goal (?:active|paused)\b/m;
/** The goal_status attachments in a session's transcript, in the conversation's order (by parentUuid, as
 * Claude Code reads it back): 2.1.300 can write a new session's first turn, set record included, after the
 * check that follows it. */
async function goalRecords(sandbox, id) {
  const file = id && (await sandbox.projectFiles()).find(name => name.includes(id));
  if (!file) return [];
  const records = await readJsonl(file), parents = new Map(records.filter(r => typeof r.uuid === 'string').map(r => [r.uuid, r.parentUuid]));
  const depth = uuid => { let n = 0; for (const seen = new Set(); parents.has(uuid) && !seen.has(uuid); uuid = parents.get(uuid)) { seen.add(uuid); n++; } return n; };
  return records.filter(r => r.type === 'attachment' && r.attachment?.type === 'goal_status')
    .map(r => ({ r, at: depth(r.uuid) })).sort((a, b) => a.at - b.at).map(({ r }) => r.attachment);
}
/** What the goal capsule and the chat's goal event rows show. */
const goalShown = page => page.evaluate(([capsule, rows]) => {
  const el = document.querySelector(capsule);
  return { status: el?.dataset.goalStatus ?? null, phase: el?.dataset.goalPhase ?? null, condition: el?.dataset.goalCondition ?? null,
    source: el?.dataset.goalSource ?? null, history: !!el?.hasAttribute('data-goal-history'),
    events: [...document.querySelectorAll(rows)].map(row => row.dataset.goalEvent) };
}, [sel.goal, '[data-goal-event]:not([data-leaving])']);
/** Wait until the capsule shows `wanted` ({ status, phase, condition }); the error says what it showed. */
async function waitGoal(page, wanted, timeout = 60_000) {
  await page.waitForFunction(([selector, want]) => {
    const el = document.querySelector(selector);
    return !!el && Object.entries(want).every(([key, value]) => el.dataset[`goal${key[0].toUpperCase()}${key.slice(1)}`] === value);
  }, [sel.goal, wanted], { timeout })
    .catch(async error => { throw new Error(`goal capsule ${JSON.stringify(await goalShown(page))}, wanted ${JSON.stringify(wanted)}: ${error.message.split('\n')[0]}`); });
}
async function waitGoalEvent(page, kind, timeout = 30_000) {
  await page.locator(sel.goalEvent(kind)).first().waitFor({ timeout })
    .catch(async error => { throw new Error(`no goal event row "${kind}" (${JSON.stringify(await goalShown(page))}): ${error.message.split('\n')[0]}`); });
}
/** A new chat whose first message, sent from the chat box, sets the goal; resolves with its session id
 * once the capsule shows the goal (`wanted` adds the status or phase to wait for). */
async function startGoal({ ui, page }, folder, condition, wanted = { status: 'active' }) {
  await ui.openDraft(folder.name);
  await ui.send(`/goal ${condition}`);
  await waitGoal(page, { condition, ...wanted }, 90_000);
  return ui.activeSessionId();
}

export const SCENARIOS = [
  {
    id: 'new-chat',
    features: ['model-catalog', 'launch-flags', 'first-prompt', 'final-transcript', 'auto-mode-new'],
    timeoutMs: 150_000,
    async run({ ui, page, api, sandbox, folders, check, note }) {
      api.script('hello', () => ({ text: 'Hello from the fake model (ccm-hello-reply).' }));
      await ui.openDraft(folders.main.name);
      let chosen = {};
      await check('model-catalog', async () => {
        await page.waitForFunction(() => document.querySelector('[data-draft-settings]')?.getAttribute('data-draft-settings') !== 'loading', null, { timeout: 90_000 });
        const state = await page.locator('[data-draft-settings]').getAttribute('data-draft-settings');
        assert.equal(state, 'ready', 'the model list probe failed');
        await page.locator('[data-setting-kind="model"]').click();
        const options = await page.locator('[data-setting-menu="model"] .setting-option').evaluateAll(els => els.map(el => el.dataset.optionValue));
        note('models', options);
        assert.ok(options.filter(Boolean).length >= 2, `model list: ${JSON.stringify(options)}`);
        chosen.model = options.find(value => /haiku/i.test(value)) ?? options.find(value => /sonnet/i.test(value)) ?? options.filter(Boolean).at(-1);
        await page.locator(`[data-setting-menu="model"] .setting-option[data-option-value="${chosen.model}"]`).click();
        await page.locator('[data-setting-kind="effort"]').click();
        const efforts = await page.locator('[data-setting-menu="effort"] .setting-option').evaluateAll(els => els.map(el => el.dataset.optionValue));
        note('efforts', efforts);
        chosen.effort = efforts.find(value => value === 'high') ?? efforts.filter(Boolean)[0];
        if (chosen.effort) await page.locator(`[data-setting-menu="effort"] .setting-option[data-option-value="${chosen.effort}"]`).click();
        else await page.keyboard.press('Escape');
      });
      await ui.send('Say hello ccm:hello');
      await check('first-prompt', async () => {
        await ui.waitUser('Say hello ccm:hello', 90_000);
        assert.equal(api.requests.filter(r => r.script === 'hello').length >= 1, true);
      });
      await check('final-transcript', async () => {
        await ui.waitReply('ccm-hello-reply');
        const users = (await ui.transcript()).filter(m => m.role === 'user');
        assert.equal(users.filter(m => m.text.includes('ccm:hello')).length, 1, 'the first prompt is shown once');
      });
      await check('auto-mode-new', async () => {
        await waitMode(page, 'auto');
        // From the per-process settings, not --permission-mode (ps splits argv on spaces on macOS).
        const command = (await ui.claudeArgv()).join(' ');
        assert.match(command, /"permissions":\{"defaultMode":"auto"\}/, 'auto mode comes from the per-process settings');
        assert.doesNotMatch(command, /--permission-mode/);
      });
      await check('launch-flags', async () => {
        if (!chosen.model) return { skip: 'no model list' };
        const argv = await ui.claudeArgv();
        note('launch', argv.filter(arg => !arg.startsWith('{')).join(' '));
        assert.equal(argv[argv.indexOf('--model') + 1], chosen.model, 'the --model value');
        if (chosen.effort) assert.equal(argv[argv.indexOf('--effort') + 1], chosen.effort, 'the --effort value');
        const request = api.requests.find(r => r.script === 'hello');
        note('request-model', request.model);
        assert.ok(request.model && (request.model.includes(chosen.model) || chosen.model.length < 12 && request.model.includes(chosen.model.replace(/\[.*\]$/, ''))), `request model ${request.model} vs ${chosen.model}`);
      });
    },
  },
  {
    id: 'trust',
    features: ['trust-card'],
    timeoutMs: 120_000,
    async run({ ui, page, api, sandbox, folders, check }) {
      api.script('trust', () => ({ text: 'Answered in a newly trusted folder (ccm-trust-reply).' }));
      await check('trust-card', async () => {
        await ui.openDraft(folders.fresh.name);
        await ui.send('Hello from a new folder ccm:trust');
        const card = page.locator(sel.trust);
        await card.waitFor({ timeout: 60_000 });
        assert.equal(await card.getAttribute('data-directory-trust-cwd'), folders.fresh.cwd);
        await card.locator('[data-trust-decision="trust"]').click();
        await ui.waitReply('ccm-trust-reply', { timeout: 60_000 });
        const config = JSON.parse(await readFile(path.join(sandbox.config, '.claude.json'), 'utf8'));
        assert.equal(config.projects?.[folders.fresh.cwd]?.hasTrustDialogAccepted, true, 'Claude Code saved the trust decision');
      });
    },
  },
  {
    id: 'onboarding',
    features: ['onboarding', 'auto-mode-user-manual'],
    timeoutMs: 180_000,
    async run({ ui, page, api, sandbox, folders, check, note }) {
      api.script('onboard', () => ({ text: 'First run complete (ccm-onboard-done).' }));
      await check('onboarding', async () => {
        await ui.openDraft(folders.onboard.name);
        await ui.send('Hello on first run ccm:onboard');
        // Answer each native first-run screen in the terminal, as a user would;
        // the directory trust prompt is answered from the app's own card.
        const seen = [];
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          if (await page.locator(sel.assistant).filter({ hasText: 'ccm-onboard-done' }).count()) break;
          if (await page.locator(sel.trust).count() && !seen.includes('trust-card')) {
            seen.push('trust-card');
            await page.locator(`${sel.trust} [data-trust-decision="trust"]`).click();
          }
          const pane = await ui.pane();
          const screen = sandbox.capture(pane);
          const answer = firstRunAnswer(screen);
          if (answer) {
            if (seen.at(-1) !== answer.name) seen.push(answer.name);
            for (const key of answer.keys) { sandbox.tmux('send-keys', '-t', pane, key); await delay(250); }
            await delay(700);
          } else await delay(400);
        }
        note('screens', seen);
        await ui.waitReply('ccm-onboard-done', { timeout: 5_000 });
        const users = (await ui.transcript()).filter(m => m.role === 'user' && m.text.includes('ccm:onboard'));
        assert.equal(users.length, 1, 'the first message is sent exactly once');
        assert.equal(api.requests.filter(r => r.script === 'onboard').length, 1);
      });
      await check('auto-mode-user-manual', async () => {
        await waitMode(page, 'auto');
        const screen = await ui.screen();
        assert.doesNotMatch(screen, /Make auto mode your default permission mode\?/);
        const settings = JSON.parse(await readFile(path.join(folders.onboard.claudeDir, 'settings.json'), 'utf8'));
        assert.deepEqual(settings.permissions, { defaultMode: 'default' }, "the user's own settings stay as they were");
      });
    },
  },
  {
    id: 'streaming',
    features: ['streaming-preview', 'running-state'],
    timeoutMs: 120_000,
    async run({ ui, page, api, folders, check, note }) {
      const text = paragraph.repeat(4) + 'ccm-stream-end';
      api.script('stream', () => ({ text, chunk: 12, delayMs: 160 }));
      await ui.openDraft(folders.main.name);
      await ui.send('Stream a long answer ccm:stream');
      await check('running-state', async () => {
        await page.locator(sel.stop).waitFor({ timeout: 60_000 });
        await ui.waitStatus('working', 30_000);
      });
      await check('streaming-preview', async () => {
        // Part of the reply shows (from the screen) before the transcript has it.
        await page.waitForFunction(([selector]) => [...document.querySelectorAll(selector)].some(el => el.dataset.source === 'preview' && el.textContent.includes('compatibility matrix streams')),
          [sel.assistant], { timeout: 40_000 });
        note('preview-seen-while-streaming', true);
        await ui.waitReply('ccm-stream-end', { timeout: 60_000 });
        const replies = (await ui.transcript()).filter(m => m.role === 'assistant');
        assert.equal(replies.filter(m => m.text.includes('compatibility matrix streams')).length, 1, 'one reply bubble, updated in place');
        await ui.waitStatus('idle', 30_000);
        assert.equal(await page.locator(sel.stop).count(), 0, 'the stop button goes away');
      });
    },
  },
  {
    id: 'tools',
    features: ['tool-bash', 'tool-read', 'tool-write', 'tool-edit', 'tool-error'],
    timeoutMs: 150_000,
    async run(ctx) {
      const { ui, page, api, folders, check } = ctx;
      const cwd = folders.main.cwd, notes = path.join(cwd, 'notes.txt'), fresh = path.join(cwd, 'fresh.md');
      const steps = [
        { name: 'Bash', input: { command: "printf 'alpha\\nbeta\\n' > notes.txt && echo ccm-bash-output", description: 'Create notes' } },
        { name: 'Read', input: { file_path: notes } },
        { name: 'Edit', input: { file_path: notes, old_string: 'beta', new_string: 'gamma' } },
        { name: 'Write', input: { file_path: fresh, content: '# Fresh\n\nWritten by the fake model.\n' } },
        { name: 'Read', input: { file_path: path.join(cwd, 'missing-file.txt') } },
      ];
      api.script('tools', ({ step }) => step < steps.length ? { blocks: [{ type: 'text', text: `Step ${step + 1}.` }, { type: 'tool_use', ...steps[step] }] } : { text: 'All tools ran (ccm-tools-reply).' });
      await startChat(ctx, folders.main, 'Run the tool tour ccm:tools');
      await ui.waitReply('ccm-tools-reply', { timeout: 90_000 });
      await page.waitForTimeout(500);
      const tools = await ui.tools();
      ctx.note('tools', tools.map(tool => `${tool.name}:${tool.state}`));
      const row = (name, index = 0) => tools.filter(tool => tool.name === name)[index];
      await check('tool-bash', async () => {
        assert.equal(row('Bash')?.state, 'completed', JSON.stringify(tools));
        // Expanding the row shows the command's output.
        assert.match(await ui.expandTool('Bash'), /ccm-bash-output/);
      });
      await check('tool-read', async () => assert.equal(row('Read')?.state, 'completed', JSON.stringify(tools)));
      await check('tool-edit', async () => {
        assert.equal(row('Edit')?.state, 'completed', JSON.stringify(tools));
        assert.equal(await readFile(notes, 'utf8'), 'alpha\ngamma\n');
      });
      await check('tool-write', async () => {
        assert.equal(row('Write')?.state, 'completed', JSON.stringify(tools));
        assert.ok(existsSync(fresh));
      });
      await check('tool-error', async () => assert.equal(row('Read', 1)?.state, 'error', JSON.stringify(tools)));
    },
  },
  {
    id: 'permission',
    features: ['manual-fallback', 'permission-allow', 'permission-deny'],
    timeoutMs: 150_000,
    async run(ctx) {
      const { ui, page, api, folders, check } = ctx;
      const cwd = folders.perm.cwd;
      const once = (block, done) => ({ step }) => step === 0 ? { blocks: [{ type: 'tool_use', ...block }] } : { text: done };
      api.script('perm-allow', once({ name: 'Bash', input: { command: 'echo allowed > allowed.txt', description: 'Write a marker file' } }, 'Allowed (ccm-perm-allow-done).'));
      api.script('perm-deny', once({ name: 'Write', input: { file_path: path.join(cwd, 'denied.md'), content: '# Denied\n' } }, 'Should not happen (ccm-perm-deny-done).'));
      const card = page.locator(sel.permission);
      // The card can come before the transcript has its call (read off the screen alone: Claude Code
      // writes in batches, and 2.1.300/2.1.310 can write a new session's first call ahead of its
      // prompt). The call must then show up in the chat and own the card: the transcript read right.
      const owned = async name => {
        ctx.note(`${name}-card-before-call`, await card.getAttribute('data-permission-call') === null);
        await page.waitForFunction(selector => document.querySelector(selector)?.dataset.permissionCall, sel.permission, { timeout: 30_000 });
        const id = await card.getAttribute('data-permission-call'), tools = await ui.tools();
        assert.equal(tools.find(tool => tool.id === id)?.name, name, JSON.stringify(tools));
        return id;
      };
      await check('manual-fallback', async () => {
        await startChat(ctx, folders.perm, 'Write a marker ccm:perm-allow');
        // The folder turns auto mode off: Claude Code falls back to manual mode.
        await waitMode(page, 'default');
      });
      await check('permission-allow', async () => {
        await card.waitFor({ timeout: 60_000 });
        assert.match(await card.innerText(), /echo allowed > allowed\.txt/);
        const labels = await card.locator('[data-permission-option] strong').allInnerTexts();
        ctx.note('bash-options', labels);
        assert.match(labels[0], /^Yes/);
        const call = await owned('Bash');
        await card.locator('[data-permission-option="1"]').click();
        await card.waitFor({ state: 'detached', timeout: 30_000 });
        await ui.waitReply('ccm-perm-allow-done');
        assert.equal((await readFile(path.join(cwd, 'allowed.txt'), 'utf8')).trim(), 'allowed');
        assert.equal((await ui.tools()).find(tool => tool.id === call)?.state, 'completed');
      });
      await check('permission-deny', async () => {
        await ui.waitStatus('idle', 30_000);
        await ui.send('Create a file ccm:perm-deny');
        await card.waitFor({ timeout: 60_000 });
        const labels = await card.locator('[data-permission-option] strong').allInnerTexts();
        ctx.note('write-options', labels);
        assert.match(labels.at(-1), /^No\b/);
        await owned('Write');
        await card.locator(`[data-permission-option="${labels.length}"]`).click();
        await card.waitFor({ state: 'detached', timeout: 30_000 });
        await ui.waitStatus('idle', 30_000);
        assert.equal(existsSync(path.join(cwd, 'denied.md')), false);
        await page.waitForFunction(() => document.querySelectorAll('article.message-assistant .message-interrupted').length >= 1, null, { timeout: 20_000 });
        const users = (await ui.transcript()).filter(m => m.role === 'user');
        assert.ok(!users.some(m => m.text.includes('[Request interrupted')), 'interruption markers are not user messages');
        assert.equal(api.requests.filter(r => r.script === 'perm-deny').length, 1, 'no follow-up request after the denial');
      });
    },
  },
  {
    id: 'auto-confirm',
    features: ['auto-mode-confirm'],
    timeoutMs: 150_000,
    async run(ctx) {
      const { ui, page, api, folders, check } = ctx;
      // The fake safety check cannot grade actions marked ccm-blocked: Claude Code blocks
      // two in a row and asks about the third, with the reason quoted above the question.
      api.script('auto-confirm', ({ step }) => step < 3
        // A pipeline: simple commands inside the project skip the safety check.
        ? { blocks: [{ type: 'tool_use', name: 'Bash', input: { command: `seq -w 1 3 | sed 's/$/ ccm-blocked-${step}/' | tee blocked-${step}.txt`, description: `Blocked step ${step + 1}` } }] }
        : { text: 'Ran it after the confirmation (ccm-auto-confirm-done).' });
      await check('auto-mode-confirm', async () => {
        await startChat(ctx, folders.main, 'Try the commands auto mode cannot grade ccm:auto-confirm');
        const card = page.locator(sel.permission);
        await card.waitFor({ timeout: 90_000 });
        assert.match(await card.innerText(), /Auto mode (?:needs your confirmation|classifier requires confirmation)/);
        assert.equal(await page.locator('.session-execution-mode').getAttribute('data-execution-mode'), 'auto');
        // The fake model answers at once: the dialog can be on screen before Claude Code has
        // written the third call (and the second one's result), so the card first belongs to
        // the second call and a click then is refused by the transcript guard. Answer once the
        // chat shows the third call, as a reader would.
        await page.waitForFunction(selector => document.querySelectorAll(selector).length >= 3, sel.tool('Bash'), { timeout: 30_000 });
        await card.locator('[data-permission-option="1"]').click();
        await card.waitFor({ state: 'detached', timeout: 30_000 });
        await ui.waitReply('ccm-auto-confirm-done', { timeout: 60_000 });
        assert.ok(existsSync(path.join(folders.main.cwd, 'blocked-2.txt')), 'the confirmed command ran');
        assert.ok(!existsSync(path.join(folders.main.cwd, 'blocked-0.txt')), 'the blocked ones did not');
      });
    },
  },
  {
    id: 'server-check',
    features: ['auto-mode-billing', 'auto-mode-unavailable', 'auto-mode-unavailable-leave'],
    timeoutMs: 300_000,
    async run(ctx) {
      const { ui, page, api, sandbox, folders, check, note } = ctx;
      // Lectern's default: auto mode's check stays on the server, and the fake API, a gateway to
      // Claude Code, never runs it. Before the first action that needs the check Claude Code
      // 2.1.300 and 2.1.310 show their classifier billing notice, 2.1.321+ "Auto mode can't check
      // actions in this session"; each is a card in chats the app starts in `server`, whose
      // configuration does not set CLAUDE_CODE_AUTO_MODE_SERVER.
      const expected = compareVersions(ctx.version, '2.1.321') < 0 ? 'billing' : 'unavailable';
      const cwd = folders.server.cwd;
      const command = name => ({ blocks: [{ type: 'tool_use', name: 'Bash', input: { command: `seq -w 1 3 | sed 's/$/ ccm-server/' | tee ${name}.txt`, description: `Checked ${name}` } }] });
      api.script('server-cancel', ({ step }) => step < 1 ? command('billing-cancel') : { text: 'Should not run (ccm-server-cancel-done).' });
      api.script('server-continue', ({ step }) => step < 1 ? command('billing-continue') : { text: 'Ran it after the notice (ccm-server-continue-done).' });
      api.script('auto-unavailable', ({ step }) => step < 1 ? command('unavailable-stay') : { text: 'Ran it after approval (ccm-unavailable-stay-done).' });
      api.script('auto-unavailable-leave', ({ step }) => step < 1 ? command('unavailable-leave') : { text: 'Should not run (ccm-unavailable-leave-done).' });
      api.script('auto-unavailable-after', () => ({ text: 'Still here in accept edits mode (ccm-unavailable-after).' }));
      const billing = page.locator(`${sel.permission}[data-permission-kind="auto-mode-billing"]`);
      const card = page.locator(`${sel.permission}[data-permission-kind="auto-mode-unavailable"]`);
      const toolCard = page.locator(`${sel.permission}:not([data-permission-kind])`);
      // The native dialog, kept per release for parser samples.
      const record = async name => {
        const screen = (await ui.screen()).replaceAll(sandbox.root, '<sandbox>');
        await writeFile(path.join(ctx.dir, `server-check.${name}.txt`), screen);
        return screen;
      };
      /** The chat's first checked action brings this release's own card, nothing else. */
      const offered = async () => {
        const seen = await Promise.race([billing.waitFor({ timeout: 90_000 }).then(() => 'billing'), card.waitFor({ timeout: 90_000 }).then(() => 'unavailable'),
          toolCard.waitFor({ timeout: 90_000 }).then(() => 'tool'), ui.waitReply('(ccm-', { timeout: 90_000 }).then(() => 'reply')]).catch(error => `none: ${error.message.split('\n')[0]}`);
        if (seen === expected) return;
        const screen = await record('unexpected');
        note('unexpected', { seen, screen: screen.split('\n').slice(-30) });
        throw new Error(`expected the ${expected} card, saw ${seen}; screen:\n${screen.split('\n').filter(line => line.trim()).slice(-12).join('\n')}`);
      };
      const skip = `Claude Code ${ctx.version} shows ${expected === 'billing' ? 'the classifier billing notice' : '"Auto mode can\'t check actions"'} instead`;
      if (expected === 'unavailable') await check('auto-mode-billing', async () => ({ skip }));
      else for (const feature of ['auto-mode-unavailable', 'auto-mode-unavailable-leave']) await check(feature, async () => ({ skip }));
      if (expected === 'billing') await check('auto-mode-billing', async () => {
        await startChat(ctx, folders.server, 'Run the command auto mode checks on the server ccm:server-cancel');
        await offered();
        note('notice', (await record('billing-notice')).split('\n').slice(-16));
        assert.equal(await page.locator('.session-execution-mode').getAttribute('data-execution-mode'), 'auto');
        const text = await billing.innerText();
        assert.match(text, /auto mode 计费说明/);
        assert.match(text, /Claude Code 自己的计费变更说明/);
        assert.match(text, /We're changing auto mode to no longer charge for classifier requests in Claude Code\./);
        assert.match(text, /classifier requests are billed as before/);
        assert.deepEqual(await billing.locator('.question-option strong').allInnerTexts(), ['继续', '取消']);
        assert.deepEqual(await billing.locator('.question-mark').allInnerTexts(), ['Enter', 'Esc']);
        assert.equal(await billing.locator('.question-option[aria-pressed="true"]').count(), 0, 'nothing is preselected');
        await billing.screenshot({ path: path.join(ctx.dir, 'server-check.billing-card.png') });
        // Cancel (Esc): the turn stops, the action does not run, nothing is remembered.
        await billing.locator('[data-permission-cancel]').click();
        await billing.waitFor({ state: 'detached', timeout: 30_000 });
        await ui.waitStatus('idle', 30_000);
        assert.ok(!existsSync(path.join(cwd, 'billing-cancel.txt')), 'the cancelled action did not run');
        assert.equal(api.requests.filter(r => r.script === 'server-cancel').length, 1, 'the stopped turn sent nothing more');
        // The next checked action brings the notice again; continue (Enter) runs it after Claude Code's own check.
        const checks = api.requests.filter(r => r.kind === 'classifier').length;
        await ui.send('Run another one ccm:server-continue');
        await offered();
        await billing.locator('[data-permission-option="1"]').click();
        await billing.waitFor({ state: 'detached', timeout: 30_000 });
        await ui.waitReply('ccm-server-continue-done', { timeout: 60_000 });
        assert.ok(existsSync(path.join(cwd, 'billing-continue.txt')), 'the action ran');
        assert.ok(api.requests.filter(r => r.kind === 'classifier').length > checks, 'checked by Claude Code with a request of its own');
        const config = JSON.parse(await readFile(path.join(folders.server.claudeDir, '.claude.json'), 'utf8'));
        assert.equal(typeof config.autoModeClassifierBillingNoticeAcknowledgedAt, 'number', 'Claude Code remembers the answer');
        assert.equal(await page.locator('.session-execution-mode').getAttribute('data-execution-mode'), 'auto');
      });
      if (expected === 'unavailable') await check('auto-mode-unavailable', async () => {
        await startChat(ctx, folders.server, 'Run the command auto mode cannot check ccm:auto-unavailable');
        await offered();
        note('dialog', (await record('dialog')).split('\n').slice(-24));
        assert.match(await card.innerText(), /Auto mode can't check actions in this session/);
        assert.deepEqual(await card.locator('[data-permission-option]').evaluateAll(rows => rows.map(row => row.dataset.permissionKey)), ['Enter', 'BTab']);
        assert.equal(await page.locator('.session-execution-mode').getAttribute('data-execution-mode'), 'auto');
        await card.locator('[data-permission-option="1"]').click();
        await card.waitFor({ state: 'detached', timeout: 30_000 });
        // Staying in auto mode: this action now asks like any tool, and runs once approved.
        await toolCard.waitFor({ timeout: 30_000 });
        note('after-stay', (await record('after-stay')).split('\n').slice(-20));
        assert.match(await toolCard.innerText(), /ccm-server/);
        // Claude Code asks with unnumbered choices and "No" first; approve with "Yes".
        const choices = await toolCard.locator('[data-permission-option] strong').allInnerTexts();
        note('after-stay-options', choices);
        await toolCard.locator('[data-permission-option]', { has: page.locator('strong', { hasText: /^Yes$/ }) }).click();
        await toolCard.waitFor({ state: 'detached', timeout: 30_000 });
        await ui.waitReply('ccm-unavailable-stay-done', { timeout: 60_000 });
        assert.ok(existsSync(path.join(cwd, 'unavailable-stay.txt')), 'the approved command ran');
        assert.equal(await page.locator('.session-execution-mode').getAttribute('data-execution-mode'), 'auto');
      });
      if (expected === 'unavailable') await ui.closeChat();
      // A new chat (a new Claude Code process) asks again.
      if (expected === 'unavailable') await check('auto-mode-unavailable-leave', async () => {
        await startChat(ctx, folders.server, 'Run the command again ccm:auto-unavailable-leave');
        await offered();
        await card.locator('[data-permission-option="2"]').click();
        await card.waitFor({ state: 'detached', timeout: 30_000 });
        // The turn stops in accept edits mode; the waiting action never ran.
        await waitMode(page, 'acceptEdits');
        note('after-leave', (await record('after-leave')).split('\n').slice(-12));
        await ui.waitStatus('idle', 30_000);
        assert.ok(!existsSync(path.join(cwd, 'unavailable-leave.txt')), 'the waiting action did not run');
        await ui.send('Go on ccm:auto-unavailable-after');
        await ui.waitReply('ccm-unavailable-after', { timeout: 60_000 });
        assert.equal(api.requests.filter(r => r.script === 'auto-unavailable-leave').length, 1, 'the stopped turn sent nothing more');
      });
    },
  },
  {
    id: 'question',
    features: ['question-single', 'question-multi', 'question-single-long', 'question-review-long', 'question-early', 'question-body', 'question-preview-multi'],
    timeoutMs: 300_000,
    async run(ctx) {
      const { ui, page, api, sandbox, folders, check } = ctx;
      const drink = { header: 'Drink', question: 'Which drink should we serve?', multiSelect: false, options: [
        { label: 'Tea', description: 'A warm infusion.' }, { label: 'Juice', description: 'A cold drink.' }] };
      const snacks = { header: 'Snacks', question: 'Which snacks should we pack?', multiSelect: true, options: [
        { label: 'Fruit', description: 'Fresh fruit.' }, { label: 'Bread', description: 'Fresh bread.' }] };
      const answers = {};
      const ask = (name, questions, preamble = 'One question first.', plan = {}) => api.script(name, ({ step, toolResults }) => {
        if (step === 0) return { blocks: [{ type: 'text', text: preamble }, { type: 'tool_use', name: 'AskUserQuestion', input: { questions } }], ...plan };
        answers[name] = toolResults.map(result => result.text).join('\n');
        return { text: `Thanks (ccm-${name}-done).` };
      });
      ask('ask-single', [drink]);
      ask('ask-multi', [drink, snacks]);
      // Long CJK questions wrap in the 120-column pane: the review page then quotes
      // every question with a bar (2.1.300 to 2.1.330).
      const cleanup = { header: '旧脚本', multiSelect: false,
        question: '示例相册服务在上午维护时重启了一次，我已经重新提交了缩略图任务。两台测试机（192.0.2.10、192.0.2.11，任务 demo-20260101-abcd）上还在运行的旧版同步脚本 sync_demo.sh（只包括我启动的那些，不包括你自己开的压测进程），能不能由我登录上去停掉？停掉之后我会把没跑完的批次重新排队，等新服务就绪再继续。',
        options: [{ label: '可以停', description: '停掉旧脚本并重新排队。' }, { label: '先别停', description: '保留现状，稍后再说。' }] };
      const extras = { header: '收尾', multiSelect: true,
        question: '处理完成之后还需要顺手做哪些收尾工作？这些都可以在同一批任务里完成，但每多选一项整体时间大约会增加半小时左右，请按实际需要勾选。',
        options: [{ label: '生成索引页', description: '列出全部相册。' }, { label: '清理临时文件', description: '删除中间产物。' }] };
      ask('ask-long', [cleanup, extras]);
      // The stream ends a while after the call (a gateway's late end of stream): Claude Code
      // 2.1.300–2.1.330 write the reply and the call only once the question is answered.
      const coffee = { header: 'Coffee', question: 'How should the coffee be?', multiSelect: false, options: [
        { label: 'Black', description: 'No milk.' }, { label: 'With milk', description: 'A splash of milk.' }] };
      ask('ask-early', [coffee], 'Let me check first.', { tailMs: 1500 });
      ask('ask-long-cancel', [cleanup, extras]);
      // One question under a long reply: a wrapped CJK title, wrapped option descriptions.
      const album = { header: '方案', multiSelect: false,
        question: '相册页（示例应用用 ImageGrid 组件显示的缩略图墙）在后台补齐元数据时会立刻重新生成缩略图，如果恰好这时滚动就会闪一下、需要等半秒才稳定（不会丢图）。详情页今天已经改成「同一张图还在屏幕上时缩略图不变，只在尺寸变化时重新生成」。相册页要不要也改成这种做法？',
        options: [{ label: '统一成详情页做法 (Recommended)', description: '改动小：同一张图在屏幕上时缩略图不变，滚动时不会因为补齐元数据而闪烁；尺寸或内容变化时仍然重新生成，画质检查不放松。和 CI 修复一起做，再跑一轮完整 CI。' },
          { label: '保持现状', description: '偶尔会闪一下，但逻辑最保守，不再改动。' }] };
      ask('ask-single-long', [album], '好，我把这个问题说清楚，再问你一次。\n\n背景：示例应用的相册页用 ImageGrid 组件显示缩略图。每张缩略图都记着它是根据哪一份元数据生成的，元数据一变就重新生成。\n\n两个页面现在的做法不一样：\n\n- 详情页（今天刚改过）：只要屏幕上还是同一张图，缩略图就保持不变。\n- 相册页（没改）：元数据只要一变就立刻重新生成，恰好在滚动时会闪一下。\n\n影响：不会丢图，也不会卡住，最坏的情况是偶尔闪一下。');
      const squash = text => text.replace(/\s+/g, '');
      const card = page.locator(sel.question);
      const option = number => card.locator(`button.question-option[data-question-number="${number}"]`);
      const heading = text => page.waitForFunction(([selector, wanted]) => document.querySelector(selector)?.textContent.replace(/\s+/g, '') === wanted,
        [`${sel.question} h3`, squash(text)], { timeout: 20_000 });
      // A named session closes the native dialog with a rule carrying its name.
      const rename = async name => {
        const id = await ui.activeSessionId();
        await page.locator(sel.row(id)).hover();
        await page.locator(`.session-row-wrap:has(${sel.row(id)}) .session-rename`).click();
        const dialog = page.locator('dialog.session-rename-dialog');
        await dialog.locator('input').fill(name);
        await dialog.locator('button[type="submit"]').click();
        await dialog.waitFor({ state: 'hidden', timeout: 40_000 });
        return id;
      };
      await check('question-single', async () => {
        await startChat(ctx, folders.main, 'Ask me one question ccm:ask-single');
        await card.waitFor({ timeout: 60_000 });
        assert.match(await card.innerText(), /Which drink should we serve\?/);
        await option(2).click();
        await ui.waitReply('ccm-ask-single-done');
        assert.match(answers['ask-single'], /Juice/);
      });
      await check('question-multi', async () => {
        await ui.waitStatus('idle', 30_000);
        await ui.send('Ask me two questions ccm:ask-multi');
        await card.waitFor({ timeout: 60_000 });
        await option(1).click();
        await card.getByText(snacks.question, { exact: true }).waitFor({ timeout: 20_000 });
        await option(1).click();
        await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-pressed') === 'true', `${sel.question} button.question-option[data-question-number="1"]`, { timeout: 15_000 });
        await option(2).click();
        await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-pressed') === 'true', `${sel.question} button.question-option[data-question-number="2"]`, { timeout: 15_000 });
        await card.locator('nav.question-nav button').last().click();
        // The review page: submit.
        await card.locator('dl.question-review').waitFor({ timeout: 20_000 });
        await card.locator('footer.question-actions button.primary-button').first().click();
        await ui.waitReply('ccm-ask-multi-done');
        assert.match(answers['ask-multi'], /Tea/);
        assert.match(answers['ask-multi'], /Fruit, Bread/);
      });
      await check('question-single-long', async () => {
        await ui.waitStatus('idle', 30_000);
        await rename('Demo 示例开发');
        await ui.waitStatus('idle', 30_000);
        await ui.send('Ask me one long question ccm:ask-single-long');
        await card.waitFor({ timeout: 60_000 });
        await heading(album.question);
        // Wrapped descriptions come back whole, in order; Type something and Chat stay as designed.
        assert.deepEqual((await card.locator('button.question-option small').allInnerTexts()).map(squash), album.options.map(o => squash(o.description)));
        assert.equal(await card.locator('button.question-option').count(), 3);
        const screen = await ui.screen();
        ctx.note('single-layout', { quoteBar: /^│ /mu.test(screen), nameRule: /─ Demo 示例开发 ─+\s*$/u.test(screen.trimEnd()) });
        await writeFile(path.join(ctx.dir, 'question-single-long.txt'), screen);
        await page.screenshot({ path: path.join(ctx.dir, 'question-single-long.png') });
        await option(1).click();
        await ui.waitReply('ccm-ask-single-long-done');
        assert.match(answers['ask-single-long'], /统一成详情页做法/);
      });
      await check('question-review-long', async () => {
        await ui.waitStatus('idle', 30_000);
        const id = await rename('示例问答');
        const reviewed = async () => {
          await card.locator('dl.question-review').waitFor({ timeout: 20_000 });
          return card.locator('dl.question-review dt').allInnerTexts();
        };
        await ui.waitStatus('idle', 30_000);
        await ui.send('Ask me two long questions ccm:ask-long');
        await card.waitFor({ timeout: 60_000 });
        await heading(cleanup.question);
        await option(1).click();
        await heading(extras.question);
        await option(1).click();
        await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-pressed') === 'true', `${sel.question} button.question-option[data-question-number="1"]`, { timeout: 15_000 });
        await option(2).click();
        await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-pressed') === 'true', `${sel.question} button.question-option[data-question-number="2"]`, { timeout: 15_000 });
        await card.locator('nav.question-nav button').last().click();
        assert.deepEqual((await reviewed()).map(squash), [cleanup.question, extras.question].map(squash));
        const screen = await ui.screen();
        ctx.note('review-layout', { quoteBars: /^ │ [●⏺] /mu.test(screen), nameRule: /─ 示例问答 ─+\s*$/u.test(screen.trimEnd()) });
        await card.locator('footer.question-actions button.primary-button').first().click();
        await ui.waitReply('ccm-ask-long-done');
        assert.match(answers['ask-long'], /可以停/);
        assert.match(answers['ask-long'], /生成索引页, 清理临时文件/);
        // Answer one question, skip the other, then cancel on the review page.
        await ui.waitStatus('idle', 30_000);
        await ui.send('Ask me again, I will cancel ccm:ask-long-cancel');
        await card.waitFor({ timeout: 60_000 });
        await heading(cleanup.question);
        await option(2).click();
        await heading(extras.question);
        await card.locator('nav.question-nav button').last().click();
        assert.deepEqual((await reviewed()).map(squash), [squash(cleanup.question)]);
        await card.locator('footer.question-actions button[data-question-number="2"]').click();
        await card.waitFor({ state: 'detached', timeout: 30_000 });
        let result;
        for (let i = 0; i < 50 && !result; i++, await delay(200)) {
          const records = await readJsonl((await sandbox.projectFiles()).find(file => file.includes(id)));
          const asked = records.flatMap(r => Array.isArray(r.message?.content) ? r.message.content : []).filter(b => b.type === 'tool_use' && b.name === 'AskUserQuestion').at(-1);
          result = records.find(r => Array.isArray(r.message?.content) && r.message.content.some(b => b.type === 'tool_result' && b.tool_use_id === asked?.id));
        }
        assert.equal(result?.toolUseResult, 'User rejected tool use', 'the cancelled review rejected the question');
      });
      await check('question-early', async () => {
        await ui.waitStatus('idle', 30_000);
        await ui.send('Ask me while the reply streams ccm:ask-early');
        await card.waitFor({ timeout: 60_000 });
        await heading(coffee.question);
        const id = await ui.activeSessionId();
        const records = await readJsonl((await sandbox.projectFiles()).find(file => file.includes(id)));
        const written = records.some(r => Array.isArray(r.message?.content) && r.message.content.some(b => b.type === 'tool_use' && b.input?.questions?.[0]?.question === coffee.question));
        ctx.note('question-early', { deferred: !written });
        // Not in the transcript yet: the card is read off the screen alone and names no call.
        if (!written) assert.equal(await card.getAttribute('data-question-call'), null);
        await option(2).click();
        await ui.waitReply('ccm-ask-early-done');
        assert.match(answers['ask-early'], /With milk/);
      });
      // The reported shape (2.1.33x through a gateway): paragraphs, a list and rows wrapped at the
      // pane's width, and no call in the transcript while the dialog is up.
      const job = { header: 'H200 job', multiSelect: false, question: ['要提交这个 H200 job 来测 736 rel 20k 吗？我建议同一个 job 顺带测 736 abs 20k：736 rel 只有 20k，没有同步数的 abs 对照就分不清是动作表示还是训练步数的影响。',
        '', '384 abs 30k 已经在本机 2 张 L40 上开始跑（约 25 分钟），不占这个 job。', '',
        '- Job 名：demo-grad-eval-736rel-20k-736abs-20k（yaml：work/jobs/demo-grad-eval-736rel-20k-736abs-20k.yaml，复制自上次的 demo-grad-eval-736abs-60k-init）',
        '- 预计：每个 ckpt 约 18 分钟（含 3 到 4 分钟加载权重），两个一共约 40 分钟。'].join('\n'),
        options: [{ label: '提交 (Recommended)', description: '一个 H200 job 依次跑 736 rel 20k 和 736 abs 20k，约 40 分钟' }, { label: '不提交', description: '在本机跑，再多约 45 分钟' }] };
      const typed = '先跑 736 rel 20k，跑完看一下 gram.pt 的大小和 eval/grad_align/step20000/summary.json 再决定要不要接着跑 736 abs 20k，如果两个都正常就把结果汇总到同一张表里';
      ask('ask-body', [job], '先看一下队列。', { tailMs: 1500 });
      await check('question-body', async () => {
        await ui.waitStatus('idle', 30_000);
        await ui.send('Ask me the long one ccm:ask-body');
        await card.waitFor({ timeout: 60_000 });
        // Blank lines and list items come through as asked, not run together.
        await page.waitForFunction(([selector, wanted]) => document.querySelector(selector)?.textContent === wanted, [`${sel.question} h3`, job.question], { timeout: 20_000 });
        await writeFile(path.join(ctx.dir, 'question-body.txt'), await ui.screen());
        // A long answer of one's own wraps under "Type something." on screen; the card still reads it.
        await option(3).click();
        const field = card.locator('.question-editor textarea');
        await field.waitFor({ timeout: 20_000 });
        await field.fill(typed);
        await card.locator('.question-editor-actions button.secondary-button').click();
        await card.locator('.question-editor-actions button.primary-button').click({ timeout: 30_000 });
        await ui.waitReply('ccm-ask-body-done');
        assert.ok(answers['ask-body'].includes(typed), answers['ask-body']);
      });
      await check('question-preview-multi', async () => {
        const selected = [0, 1, 1];
        const nav = card.locator('nav.question-nav button');
        const rawPreview = card.locator('.question-preview pre');
        const note = 'Sample note for the second layout';
        for (const hooks of [false, true]) {
          const name = hooks ? 'ask-preview-hooks' : 'ask-preview-screen';
          ask(name, previewQuestions, 'Three choices for the sample panel.', { tailMs: 1500 });
          if (hooks) await setDialogHooks(page, true);
          try {
            await startChat(ctx, folders.main, 'Start a named sample chat');
            await ui.waitStatus('idle');
            await rename('示例会话');
            assert.equal(!!launchedHooks(await ui.claudeArgv()), hooks);
            await ui.send(`Ask me three questions ccm:${name}`);
            await heading(previewQuestions[0].question);
            if (hooks) await page.waitForFunction(selector => document.querySelector(selector)?.dataset.questionCall, sel.question);
            else assert.equal(await card.getAttribute('data-question-call'), null);
            await option(1).click();
            await heading(previewQuestions[1].question);
            const hasPreview = (await ui.screen()).includes('n to add notes');
            ctx.note(name, { hasPreview, hooks });
            await nav.first().click();
            await heading(previewQuestions[0].question);
            assert.equal(await option(1).getAttribute('aria-pressed'), 'true');
            await nav.last().click();
            await heading(previewQuestions[1].question);
            const label = previewQuestions[1].options[1].label;
            if (hasPreview) {
              assert.match(await rawPreview.textContent(), /工具栏 A/);
              await card.getByRole('button', { name: `预览「${label}」` }).click();
              await rawPreview.filter({ hasText: '工具栏 B' }).waitFor();
              if (hooks) assert.equal(await rawPreview.textContent(), previewQuestions[1].options[1].preview);
              await card.getByRole('button', { name: `备注「${label}」` }).click();
              await card.locator('.question-editor textarea').fill(note);
              await card.locator('.question-editor-actions button.secondary-button').click();
              await card.locator('.question-editor-actions button.primary-button').click();
            } else await option(2).click();
            await heading(previewQuestions[2].question);
            await option(2).click();
            const review = card.locator('dl.question-review');
            await review.waitFor();
            assert.deepEqual((await review.locator('dd').allInnerTexts()).map(squash), previewQuestions.map((q, i) => squash(q.options[selected[i]].label)));
            await card.locator('footer.question-actions button.primary-button').click();
            await ui.waitReply(`ccm-${name}-done`);
            for (const [i, q] of previewQuestions.entries()) {
              assert.ok(answers[name].includes(`"${q.question}"="${q.options[selected[i]].label}"`), answers[name]);
            }
            if (hasPreview) assert.ok(answers[name].includes(note), answers[name]);
          } finally {
            if (hooks) await setDialogHooks(page, false);
          }
        }
      });
    },
  },
  {
    id: 'thinking-tasks',
    features: ['thinking', 'tasks'],
    timeoutMs: 150_000,
    async run(ctx) {
      const { ui, page, api, folders, check } = ctx;
      api.script('think', () => ({ blocks: [
        { type: 'thinking', thinking: 'The user wants a short answer. I will reply with the marker and nothing else.' },
        { type: 'text', text: 'Thought it over (ccm-think-reply).' }] }));
      await check('thinking', async () => {
        await startChat(ctx, folders.main, 'Think before answering ccm:think');
        await ui.waitReply('ccm-think-reply');
        await page.locator(sel.thought).first().waitFor({ state: 'attached', timeout: 20_000 });
        const replies = (await ui.transcript()).filter(m => m.role === 'assistant');
        assert.ok(!replies.some(m => m.text.includes('I will reply with the marker')), 'folded thinking is not reply text');
      });
      await check('tasks', async () => {
        await ui.waitStatus('idle', 30_000);
        const offered = api.requests.find(r => r.kind === 'main')?.tools ?? [];
        const tool = ['TodoWrite', 'TaskCreate'].find(name => offered.includes(name));
        ctx.note('task-tool', tool ?? `none of TodoWrite/TaskCreate among ${offered.join(',')}`);
        if (!tool) return { skip: `this release offers no TodoWrite or TaskCreate tool to the main loop (deferred or disabled)` };
        const input = tool === 'TodoWrite'
          ? { todos: [{ content: 'Check the matrix', status: 'in_progress', activeForm: 'Checking the matrix' }, { content: 'Write the report', status: 'pending', activeForm: 'Writing the report' }] }
          : { subject: 'Check the matrix', description: 'Run every scenario', activeForm: 'Checking the matrix' };
        api.script('tasks', ({ step }) => step === 0 ? { blocks: [{ type: 'tool_use', name: tool, input }] } : { text: 'Planned (ccm-tasks-done).' });
        await ui.send('Plan the work ccm:tasks');
        await ui.waitReply('ccm-tasks-done');
        await page.waitForFunction(() => /Check the matrix/.test(document.querySelector('.conversation-tasks, .task-list, [data-task-list]')?.textContent ?? document.body.textContent), null, { timeout: 20_000 });
      });
    },
  },
  {
    id: 'turn-controls',
    features: ['queue', 'steer', 'interrupt'],
    timeoutMs: 300_000,
    async run(ctx) {
      const { ui, page, api, folders, check } = ctx;
      const slow = () => ({ text: paragraph.repeat(6) + 'ccm-slow-end', chunk: 10, delayMs: 200 });
      for (const name of ['slow-a', 'slow-b', 'slow-c']) api.script(name, slow);
      api.script('queued', () => ({ text: 'Queued message answered (ccm-queued-done).' }));
      api.script('steered', () => ({ text: 'Steered reply (ccm-steered-done).' }));
      const streaming = () => page.waitForFunction(selector => [...document.querySelectorAll(selector)].some(el => el.dataset.source === 'preview' && el.textContent.includes('compatibility matrix streams')), sel.assistant, { timeout: 40_000 });
      // The fake API writes a slow reply's end (`done`, with `aborted` when Claude Code dropped the stream)
      // only at its next pause, up to 200 ms after the drop, and Claude Code may go on first: 2.1.321 sent
      // the steering request some 150 ms before dropping the reply. Read a slow request once it has ended
      // (dropped, or streamed to the end: about 18 s in all).
      const ended = script => poll(() => api.requests.find(r => r.script === script), r => r?.done !== undefined, 30_000);
      const timeline = (...entries) => JSON.stringify(entries.map(r => r && { script: r.script, at: r.at, done: r.done, aborted: r.aborted }));
      await check('queue', async () => {
        await startChat(ctx, folders.main, 'Slow reply ccm:slow-a');
        await page.locator(sel.stop).waitFor({ timeout: 40_000 });
        await streaming();
        await ui.type('Queued follow-up ccm:queued');
        await page.locator(sel.turnAction).first().click();
        await page.locator(sel.queue).waitFor({ timeout: 20_000 });
        await ui.waitReply('ccm-slow-end', { timeout: 90_000 });
        await ui.waitReply('ccm-queued-done', { timeout: 60_000 });
        const slowA = api.requests.find(r => r.script === 'slow-a'), queued = api.requests.find(r => r.script === 'queued');
        assert.ok(queued.at >= slowA.done, 'the queued message waited for the reply');
      });
      await check('steer', async () => {
        await ui.waitStatus('idle', 30_000);
        await ui.send('Another slow reply ccm:slow-b');
        await page.locator(sel.stop).waitFor({ timeout: 40_000 });
        await streaming();
        await ui.type('Change course ccm:steered');
        await page.locator(sel.turnAction).nth(1).click();
        await ui.waitReply('ccm-steered-done', { timeout: 60_000 });
        const slowB = await ended('slow-b'), steered = api.requests.find(r => r.script === 'steered');
        // Steering, unlike queueing, does not wait for the reply: its request went out before the reply ended
        // by itself (dropping it, before or just after, is Claude Code's way of steering).
        assert.ok(slowB.aborted || steered.at < (slowB.done ?? Infinity), `the steering message went out before the reply finished: ${timeline(slowB, steered)}`);
      });
      await check('interrupt', async () => {
        await ui.waitStatus('idle', 60_000);
        const before = await page.locator(`${sel.assistant} .message-interrupted`).count();
        await ui.send('Third slow reply ccm:slow-c');
        await page.locator(sel.stop).waitFor({ timeout: 40_000 });
        await streaming();
        await page.locator(sel.stop).click();
        await ui.waitStatus('idle', 30_000);
        await page.waitForFunction(([selector, count]) => document.querySelectorAll(selector).length > count, [`${sel.assistant} .message-interrupted`, before], { timeout: 20_000 });
        // Read before its end was written, a reply still streaming passed as cancelled.
        const slowC = await ended('slow-c');
        assert.ok(slowC.aborted, `the model request was cancelled: ${timeline(slowC)}`);
      });
    },
  },
  {
    id: 'compact',
    features: ['compact'],
    timeoutMs: 200_000,
    async run(ctx) {
      const { ui, page, api, sandbox, folders, check } = ctx;
      api.script('compact-seed', () => ({ text: 'Some context worth compacting (ccm-compact-seed).' }));
      api.script('after-compact', () => ({ text: 'Answered after compaction (ccm-after-compact-done).' }));
      api.script('@compact', () => ({ gate: 'compact', text: '<summary>\n1. Primary Request and Intent: exercise /compact in the matrix.\n2. Pending Tasks: none.\n</summary>' }));
      await check('compact', async () => {
        await startChat(ctx, folders.main, 'Seed the context ccm:compact-seed');
        await ui.waitReply('ccm-compact-seed');
        await ui.waitStatus('idle', 30_000);
        await ui.send('/compact');
        // While the summary request is held, the app shows the compaction and only queues.
        await page.locator(`${sel.progress}[data-turn-progress="compacting"]`).waitFor({ timeout: 60_000 });
        assert.ok(api.waiting('compact') >= 1, 'the compaction request reached the fake API');
        await ui.type('After compaction ccm:after-compact');
        await page.locator(sel.turnAction).first().waitFor({ timeout: 20_000 });
        assert.equal(await page.locator(sel.turnAction).count(), 1, 'only "queue" is offered while compacting');
        await page.locator(sel.turnAction).first().click();
        await page.locator(sel.queue).waitFor({ timeout: 20_000 });
        api.release('compact');
        await ui.waitReply('ccm-after-compact-done', { timeout: 90_000 });
        const after = api.requests.find(r => r.script === 'after-compact'), summary = api.requests.find(r => r.kind === 'compact');
        assert.ok(after.at > summary.done, 'the queued message went out after the summary');
        await ui.waitStatus('idle', 30_000);
        assert.equal(await page.locator(`${sel.assistant} .markdown:text-is("正在等待 Claude…")`).count(), 0, 'no reply left waiting');
      });
    },
  },
  {
    id: 'session',
    features: ['statusline', 'session-settings', 'rename', 'rewind-renamed'],
    timeoutMs: 240_000,
    async run(ctx) {
      const { ui, page, api, sandbox, folders, check } = ctx;
      // A user skill whose long CJK description wraps; Claude Code offers it beside /rewind.
      // Only this scenario's Claude Code processes start while it exists.
      const skill = path.join(sandbox.config, 'skills', 'review-reminder');
      await mkdir(skill, { recursive: true });
      await writeFile(path.join(skill, 'SKILL.md'), '---\nname: review-reminder\ndescription: 读取最近一次代码评审的记录，简要告诉用户还有哪些评审意见没有处理、哪些讨论还没有结论，以及合并之前需要先确认的地方。用户说“评审提醒”时使用。\n---\n\nSay hello.\n');
      api.script('session', () => ({ text: 'Ready for settings (ccm-session-reply).' }));
      api.script('after-settings', () => ({ text: 'Using the new settings (ccm-after-settings).' }));
      await startChat(ctx, folders.main, 'Session settings check ccm:session');
      await ui.waitReply('ccm-session-reply');
      await ui.waitStatus('idle', 30_000);
      await check('statusline', async () => {
        // The statusLine callback reports model and context; a custom base URL is a gateway route.
        await page.waitForFunction(() => document.querySelector('.session-context-usage')?.getAttribute('data-context-input-tokens'), null, { timeout: 30_000 });
        await page.waitForFunction(selector => /Opus|Sonnet|Haiku/i.test(document.querySelector(selector)?.textContent ?? ''), '.session-settings:not(.draft-settings) [data-setting-kind="model"]', { timeout: 30_000 });
        ctx.note('statusline', await page.locator('.session-telemetry').innerText());
        assert.equal(await page.locator('.session-execution-mode').getAttribute('data-execution-mode'), 'auto');
        assert.ok(await page.locator('.telemetry-billing').count() === 0 || /自定义|custom/i.test(await page.locator('.telemetry-billing').innerText()), 'a custom endpoint is not billed as a subscription');
      });
      await check('session-settings', async () => {
        const pick = (kind, wanted) => pickSetting(ctx, kind, wanted);
        await pick('model', /Sonnet/i);
        await page.waitForFunction(selector => /Sonnet/i.test(document.querySelector(selector)?.textContent ?? ''), '.session-settings:not(.draft-settings) [data-setting-kind="model"]', { timeout: 30_000 });
        await pick('effort', /^\s*low/i);
        await page.waitForFunction(selector => /low/i.test(document.querySelector(selector)?.textContent ?? ''), '.session-settings:not(.draft-settings) [data-setting-kind="effort"]', { timeout: 30_000 });
        await ui.send('Next turn ccm:after-settings');
        await ui.waitReply('ccm-after-settings');
        const request = api.requests.find(r => r.script === 'after-settings');
        ctx.note('after-settings-request', { model: request.model, effort: request.effort });
        assert.match(request.model, /sonnet/i);
      });
      const rename = async (id, name) => {
        await page.locator(sel.row(id)).hover();
        await page.locator(`.session-row-wrap:has(${sel.row(id)}) .session-rename`).click();
        const dialog = page.locator('dialog.session-rename-dialog');
        await dialog.locator('input').fill(name);
        await dialog.locator('button[type="submit"]').click();
        await dialog.waitFor({ state: 'hidden', timeout: 40_000 });
        await page.waitForFunction(([selector, name]) => document.querySelector(selector)?.textContent.includes(name), [`${sel.row(id)} .session-title`, name], { timeout: 30_000 });
        const jsonl = (await sandbox.projectFiles()).find(file => file.includes(id));
        const records = await readJsonl(jsonl);
        assert.ok(records.some(r => r.type === 'custom-title' && r.customTitle === name), 'Claude Code saved the name');
      };
      await check('rename', async () => {
        await ui.waitStatus('idle', 30_000);
        await rename(await ui.activeSessionId(), 'Matrix renamed session');
      });
      await check('rewind-renamed', async () => {
        // The chat above: Lectern switched model and effort in one step after its first prompt
        // (session-settings) and switches effort again now, the last thing before the rewind.
        // Claude Code lists each switch as a rewind point between the prompts; Lectern's own list
        // has to line up with its list row by row to choose the second prompt.
        await pickSetting(ctx, 'effort', [/^\s*high\b/i, /^\s*medium\b/i]);
        await page.waitForFunction(selector => /high|medium/i.test(document.querySelector(selector)?.textContent ?? ''), '.session-settings:not(.draft-settings) [data-setting-kind="effort"]', { timeout: 30_000 });
        await ui.waitStatus('idle', 30_000);
        const id = await ui.activeSessionId();
        // Wider than the input box's upper border can hold: cut there with an ellipsis. Claude Code
        // writes the rename's records some 250 ms after its title, so the rewind chosen right away
        // can be refused for a changed transcript: Lectern then reads it again and rewinds anyway.
        await rename(id, '矩阵回退测试 ' + '很长的会话名称'.repeat(12));
        const jsonl = (await sandbox.projectFiles()).find(file => file.includes(id));
        const commands = (await readJsonl(jsonl)).filter(r => r.type === 'user' && !r.isMeta && /^<command-name>/.test(textOf(r.message?.content).trim()))
          .map(r => textOf(r.message.content).replace(/\s+/g, ' ').replace(/<command-name>(\S+)<\/command-name>.*<command-args>(.*)<\/command-args>/, '$1 $2').trim());
        ctx.note('rewind-renamed-commands', commands);
        assert.ok(commands.some(c => c.startsWith('/model')) && commands.filter(c => c.startsWith('/effort')).length >= 2, 'the switches are command records Claude Code lists');
        await page.locator('.rewind-launch').click();
        const picker = page.locator('dialog.rewind-picker');
        await picker.locator('.rewind-choices button', { hasText: 'Next turn ccm:after-settings' }).click();
        // The native menu opened (the typed /rewind was recognized and submitted) and reached its confirmation.
        await page.locator('section.rewind-panel:not([data-leaving]) .rewind-confirm').click({ timeout: 45_000 });
        await page.waitForFunction(([selector, text]) => document.querySelector(selector)?.value === text, [sel.composer, 'Next turn ccm:after-settings'], { timeout: 30_000 });
        await page.waitForFunction(selector => ![...document.querySelectorAll(selector)].some(node => node.textContent.includes('Next turn ccm:after-settings')), sel.user, { timeout: 30_000 });
        assert.ok([...await page.locator(sel.user).allTextContents()].some(text => text.includes('Session settings check')), 'the first prompt stays');
        // The restored prompt is back in the input box, under the cut name.
        ctx.note('rewind-renamed-border', (await ui.screen()).split('\n').filter(line => / ─\s*$/u.test(line)).map(line => line.trimEnd()));
      });
      await rm(skill, { recursive: true, force: true });
    },
  },
  {
    id: 'background',
    features: ['background', 'background-settings'],
    timeoutMs: 200_000,
    async run(ctx) {
      const { ui, page, api, sandbox, folders, check } = ctx;
      // The main loop starts a background shell and a background subagent; the
      // subagent's own request carries `ccm:bg-agent` and is held until released.
      api.script('bg', ({ step, toolResults }) => {
        if (step === 0) return { blocks: [
          { type: 'tool_use', name: 'Bash', input: { command: 'sleep 4; echo ccm-bg-shell-done', description: 'Wait in the background', run_in_background: true } },
          { type: 'tool_use', name: 'Agent', input: { description: 'Background helper', prompt: 'Wait for the signal ccm:bg-agent', subagent_type: 'general-purpose', run_in_background: true } }] };
        if (toolResults.length) return { text: 'Started in the background (ccm-bg-started).' };
        return { text: 'Background result received (ccm-bg-notified).' };
      });
      api.script('bg-agent', () => ({ gate: 'bg-agent', text: 'Helper finished.' }));
      await check('background', async () => {
        await startChat(ctx, folders.main, 'Start background work ccm:bg');
        await ui.waitReply('ccm-bg-started', { timeout: 60_000 });
        const id = await ui.activeSessionId();
        const row = page.locator(`${sel.row(id)}[data-background]`);
        await row.waitFor({ timeout: 40_000 });
        ctx.note('row', await page.locator(sel.row(id)).getAttribute('aria-label'));
        // The reply is over: the composer sends rather than stops.
        await page.locator(sel.send).waitFor({ timeout: 20_000 });
        assert.equal(await page.locator(sel.stop).count(), 0);
      });
      // Claude Code reports busy while the subagent runs, its screen back at the empty prompt.
      // The pickers switch model and effort there; a reply in progress would not allow it.
      try {
        await check('background-settings', async () => {
          await ui.waitReply('ccm-bg-notified', { timeout: 60_000 });
          const id = await ui.activeSessionId();
          await page.locator(`${sel.row(id)}[data-background][data-status="idle"]`).waitFor({ timeout: 30_000 });
          ctx.note('native-status', await nativeStatus(sandbox, id));
          const word = (option, pattern) => pattern.exec(option.text)[0].toLowerCase();
          const shows = (kind, text) => page.waitForFunction(([selector, wanted]) => document.querySelector(selector)?.textContent.toLowerCase().includes(wanted),
            [settingTrigger(kind), text], { timeout: 30_000 });
          // Effort first, on the model the chat started with (which has effort levels).
          const effort = word(await pickSetting(ctx, 'effort', [/^\s*low\b/i, /^\s*high\b/i]), /low|high/i);
          await shows('effort', effort);
          await shows('model', word(await pickSetting(ctx, 'model', [/Sonnet/i, /Haiku/i]), /Sonnet|Haiku/i));
          const screen = await ui.screen();
          ctx.note('screen', screen.split('\n').filter(line => line.trim()).slice(-12));
          assert.match(screen, /Set model to /, 'the native receipt of the model switch');
          assert.match(screen, new RegExp(`Set effort level to ${effort}`, 'i'), 'the native receipt of the effort switch');
          assert.ok(api.waiting('bg-agent') >= 1 && await page.locator(`${sel.row(id)}[data-background]`).count() === 1, 'the subagent still runs');
          ctx.note('native-status-after', await nativeStatus(sandbox, id));
        });
      } finally { api.release('bg-agent'); }
      await check('background', async () => {
        const id = await ui.activeSessionId();
        await page.waitForFunction(selector => !document.querySelector(selector), `${sel.row(id)}[data-background]`, { timeout: 90_000 });
      });
    },
  },
  {
    id: 'preview-rows',
    features: ['preview-rows'],
    timeoutMs: 180_000,
    async run(ctx) {
      const { ui, page, api, folders, check, note } = ctx;
      // The reply streams slowly while background work comes and goes, as probe-preview-rows.mjs
      // samples it: a background shell, a subagent that hands back once the turn is over (its message,
      // its notification, the turn that follows), folded and running commands. The preview (screen
      // text before the transcript has it) shows the reply's prose and never one of those rows.
      const prose = n => `Streamed paragraph ${n} of the preview check, written slowly so the app reads it off the screen first (ccm-pv-${n}).`;
      const bash = (command, run_in_background) => ({ type: 'tool_use', name: 'Bash', input: { command, description: `Run ${command.split(';')[0]}`, ...(run_in_background && { run_in_background }) } });
      const slow = { chunk: 8, delayMs: 90 }, answers = new Map();
      api.script('pv', ({ step, toolResults }) => {
        if (!answers.has(step)) answers.set(step, step === 0 ? { ...slow, blocks: [{ type: 'text', text: prose(0) }, bash('sleep 1; echo pv-shell', true),
          { type: 'tool_use', name: 'Agent', input: { description: 'Preview helper', prompt: 'Hand back later ccm:pv-agent', subagent_type: 'general-purpose', run_in_background: true } }] }
          : step === 1 ? { blocks: [{ type: 'text', text: 'Two quick checks.' }, bash('echo one'), bash('echo two')] }
          : step === 2 || toolResults.some(result => /pv-slept/.test(result.text)) ? { ...slow, text: prose(step) }
          : { ...slow, blocks: [{ type: 'text', text: prose(step) }, bash('sleep 2; echo pv-slept')] });
        return answers.get(step);
      });
      const report = 'Helper report for the preview check.';
      api.script('pv-agent', ({ body }) => (body.tools ?? []).some(tool => tool.name === 'SubagentHandback')
        ? { gate: 'pv-agent', blocks: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: report } }] } : { gate: 'pv-agent', text: report });
      await check('preview-rows', async () => {
        // Sample the reply's prose (not its tool and notification rows) of the newest reply, all along.
        await page.evaluate(() => {
          const seen = window.__ccmPreview = { texts: [], previews: 0 };
          window.__ccmPreviewTimer = setInterval(() => {
            const last = [...document.querySelectorAll('article.message-assistant:not([data-leaving])')].at(-1);
            if (!last) return;
            if (last.dataset.source === 'preview') seen.previews++;
            const text = [...last.querySelectorAll('.message-content > .markdown:not([data-fade-placeholder])')].map(el => el.textContent).join('\n');
            if (text && seen.texts.at(-1) !== text && seen.texts.length < 4000) seen.texts.push(text);
          }, 40);
        });
        try {
          await startChat(ctx, folders.main, 'Stream while background work runs ccm:pv');
          for (const end = Date.now() + 60_000; Date.now() < end && !/Waiting for \d+ background agents? to finish/.test(await ui.screen());) await new Promise(resolve => setTimeout(resolve, 200));
          api.release('pv-agent');
          const id = await ui.activeSessionId();
          await page.waitForFunction(selector => !document.querySelector(selector), `${sel.row(id)}[data-background]`, { timeout: 90_000 });
          await ui.waitStatus('idle', 60_000);
          await new Promise(resolve => setTimeout(resolve, 1500));
        } finally { api.release('pv-agent'); }
        const seen = await page.evaluate(() => { clearInterval(window.__ccmPreviewTimer); return window.__ccmPreview; });
        const rows = /Waiting for \d+ background|Message from @|\bRan \d+ shell command|Running \d+ shell command|" finished|Background command|exit code|Thought for \d|agents? launched|Auto mode lets|Monitor event|Run (?:sleep|echo)/;
        note('samples', { texts: seen.texts.length, previews: seen.previews, last: seen.texts.at(-1)?.slice(-200) });
        assert.ok(seen.previews > 0, 'the reply was shown from the screen before the transcript had it');
        const leaked = seen.texts.find(text => rows.test(text));
        assert.ok(!leaked, `a row around the reply showed as its text: ${leaked?.match(rows)?.[0]} in ${JSON.stringify(leaked?.slice(-300))}`);
      });
    },
  },
  {
    id: 'history',
    features: ['close-in-place', 'history-paging', 'rename-inactive', 'resume', 'auto-mode-resume'],
    timeoutMs: 300_000,
    async run(ctx) {
      const { ui, page, api, folders, check } = ctx;
      // Two turns with large tool output push the first one out of the first page (128 KiB).
      // Outputs stay under Claude Code's persisted-output threshold so the transcript keeps them.
      const big = ({ step }) => step < 6 ? { blocks: [{ type: 'tool_use', name: 'Bash', input: { command: `seq -w 1 1000 | sed 's/$/ ccm-history-line-${step}/'`, description: `Print a long list ${step + 1}` } }] }
        : { text: 'Printed (ccm-big-done).' };
      api.script('big-one', big); api.script('big-two', big);
      api.script('small', () => ({ text: 'Small reply (ccm-small-done).' }));
      api.script('resumed', () => ({ text: 'Back again (ccm-resumed-done).' }));
      await startChat(ctx, folders.main, 'First long turn ccm:big-one');
      await ui.waitReply('ccm-big-done', { timeout: 90_000 });
      await ui.waitStatus('idle', 30_000);
      await ui.send('Second long turn ccm:big-two');
      await page.waitForFunction(selector => document.querySelectorAll(selector).length >= 2, `${sel.assistant}[data-source="jsonl"]`, { timeout: 90_000 });
      await ui.waitStatus('idle', 60_000);
      await ui.send('A short turn ccm:small');
      await ui.waitReply('ccm-small-done', { timeout: 60_000 });
      await ui.waitStatus('idle', 30_000);
      const id = await ui.activeSessionId();
      await check('close-in-place', async () => {
        // The same bubbles stay while the chat turns into resumable history: never blank, no reload.
        const shown = await page.locator(sel.assistant).last().elementHandle();
        await page.evaluate(() => {
          window.ccmTranscriptEmptied = false;
          new MutationObserver(() => { if (!document.querySelector('.conversation-scroll .message-assistant')) window.ccmTranscriptEmptied = true; })
            .observe(document.body, { childList: true, subtree: true });
        });
        await ui.closeChat();
        await page.locator('.resume-bar:not([data-leaving])').waitFor({ timeout: 30_000 });
        assert.equal(await shown.evaluate(node => node.isConnected), true, 'closing reloaded the transcript');
        assert.equal(await page.evaluate(() => window.ccmTranscriptEmptied), false, 'closing blanked the transcript');
      });
      await check('history-paging', async () => {
        // A fresh read starts from the newest page. Leaving and coming back would show the
        // cached reader with every page it holds; reloading the window reopens it in place.
        await page.reload();
        await ui.waitReply('ccm-small-done', { timeout: 30_000 });
        await page.locator('.history-page-control button').waitFor({ timeout: 30_000 });
        assert.equal(await page.locator(`${sel.user}:has-text("First long turn")`).count(), 0, 'the oldest turn is not on the first page');
        await page.locator('.history-page-control button').click();
        await page.locator(`${sel.user}:has-text("First long turn")`).waitFor({ timeout: 30_000 });
      });
      await check('rename-inactive', async () => {
        await page.locator(sel.row(id)).hover();
        await page.locator(`.session-row-wrap:has(${sel.row(id)}) .session-rename`).click();
        const dialog = page.locator('dialog.session-rename-dialog');
        await dialog.locator('input').fill('Matrix closed session');
        await dialog.locator('button[type="submit"]').click();
        await dialog.waitFor({ state: 'hidden', timeout: 60_000 });
        await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('Matrix closed session'), `${sel.row(id)} .session-title`, { timeout: 30_000 });
      });
      await check('resume', async () => {
        await page.locator('.resume-bar:not([data-leaving]) button').first().click();
        await ui.ready(60_000);
        const argv = await ui.claudeArgv();
        assert.equal(argv[argv.indexOf('--resume') + 1], id, 'claude --resume <session>');
        await ui.send('Continue the session ccm:resumed');
        await ui.waitReply('ccm-resumed-done', { timeout: 60_000 });
        assert.ok(api.requests.find(r => r.script === 'resumed'));
      });
      await check('auto-mode-resume', async () => waitMode(page, 'auto'));
    },
  },
  {
    id: 'attachment',
    features: ['attachment'],
    timeoutMs: 150_000,
    async run(ctx) {
      const { ui, page, api, folders, check } = ctx;
      api.script('image', () => ({ text: 'I can see the picture (ccm-image-done).' }));
      await check('attachment', async () => {
        const file = path.join(folders.main.cwd, 'swatch.png');
        await writeFile(file, pngSwatch());
        await ui.openDraft(folders.main.name);
        // As a user does: the "+" button's file dialog, then typing the question.
        const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('form.composer button.composer-attach').click()]);
        await chooser.setFiles(file);
        // The file shows as a card above the text and as a chip in it; the path stays out of the text box.
        const attached = () => page.waitForFunction(() => {
          const cards = [...document.querySelectorAll('.composer-attachments [data-attachment-card]')];
          return cards.some(card => card.textContent.includes('swatch.png') || card.dataset.tip?.includes('swatch.png'))
            && document.querySelectorAll('form.composer .composer-chip-face').length === 1
            && !document.querySelector('.composer-attachments [data-state="uploading"]');
        }, null, { timeout: 20_000 });
        await attached();
        assert.ok(!(await page.locator(sel.composer).inputValue()).includes('swatch.png'), 'the path stays out of the text box');
        // The chip is part of the text: fill() would replace it too, so type after it with keys.
        await page.locator(sel.composer).pressSequentially('What is in this picture? ccm:image');
        assert.ok((await page.locator(sel.composer).inputValue()).endsWith('What is in this picture? ccm:image'), 'the words follow the chip');
        await attached();
        await page.locator(sel.send).click();
        await ui.waitReply('ccm-image-done', { timeout: 90_000 });
        const request = api.requests.find(r => r.script === 'image');
        ctx.note('images-in-request', request.images);
        assert.ok(request.images >= 1, 'Claude Code sent the image to the model');
        await page.locator(`${sel.user} .attachment-cards [data-attachment-card], ${sel.user} [data-attachment-chip]`).first().waitFor({ state: 'attached', timeout: 30_000 });
      });
    },
  },
  {
    id: 'subagents',
    features: ['subagent-column', 'subagent-resume', 'subagent-listed', 'subagent-process-gone', 'subagent-elsewhere'],
    timeoutMs: 360_000,
    async run(ctx) {
      const { ui, page, api, sandbox, folders, check, note } = ctx;
      // The main loop launches one subagent; the subagent's own turns are scripted
      // too (its prompt carries `ccm:sa-child`) and held at gates, so the column is
      // checked while it runs. Then SendMessage resumes it (`ccm:sa-child2`).
      let agentId;
      api.script('sa-main', ({ step }) => step === 0
        ? { blocks: [{ type: 'tool_use', name: 'Agent', input: { description: 'Matrix helper', prompt: 'Inspect the folder ccm:sa-child', subagent_type: 'general-purpose', run_in_background: true } }] }
        : { text: `Main step ${step} (ccm-sa-main-${step}).` });
      api.script('sa-child', ({ step }) => step === 0
        ? { gate: 'sa-child', blocks: [{ type: 'thinking', thinking: 'The helper plans before it looks.' }, { type: 'text', text: 'Child looks around (ccm-sa-child-text).' },
          { type: 'tool_use', name: 'Bash', input: { command: 'echo ccm-sa-child-tool', description: 'Echo once' } }] }
        : { gate: 'sa-child-end', text: 'Child report (ccm-sa-child-report).' });
      api.script('sa-resume', ({ step, messages, body }) => {
        const offered = (body.tools ?? []).map(tool => tool.name);
        agentId ??= [...messages.map(m => textOf(m.content)).join('\n').matchAll(/agentId: ([A-Za-z0-9_-]+)/g)].map(m => m[1]).at(-1);
        if (step === 0 && !offered.includes('SendMessage') && offered.includes('ToolSearch')) return { blocks: [{ type: 'tool_use', name: 'ToolSearch', input: { query: 'select:SendMessage', max_results: 1 } }] };
        if (step <= 1 && offered.includes('SendMessage') && !messages.some(m => JSON.stringify(m.content).includes('ccm:sa-child2')))
          return { blocks: [{ type: 'tool_use', name: 'SendMessage', input: { to: agentId, summary: 'More', message: 'Continue please ccm:sa-child2' } }] };
        return { text: 'Resume handled (ccm-sa-resume-done).' };
      });
      api.script('sa-child2', () => ({ gate: 'sa-child2', text: 'Resumed report (ccm-sa-child2-report).' }));
      const transcriptFile = async id => {
        const projects = path.join(sandbox.config, 'projects');
        for (const dir of await readdir(projects).catch(() => [])) {
          const file = path.join(projects, dir, id, 'subagents', `agent-${agentId}.jsonl`);
          if (existsSync(file)) return file;
        }
      };
      await check('subagent-column', async () => {
        await startChat(ctx, folders.main, 'Launch a helper ccm:sa-main');
        await ui.waitReply('ccm-sa-main-1', { timeout: 60_000 });
        for (let i = 0; i < 100 && !api.waiting('sa-child'); i++) await delay(300);
        assert.ok(api.waiting('sa-child') >= 1, 'the subagent asked the model');
        const id = await ui.activeSessionId();
        // The subagent's own transcript, from the result of its launch in the main JSONL.
        const main = (await sandbox.projectFiles()).find(file => file.includes(id));
        const launched = (await readJsonl(main)).find(r => r.toolUseResult?.agentId);
        agentId = launched?.toolUseResult?.agentId;
        assert.ok(agentId, 'the Agent result names the subagent');
        // Only the model has its request so far: its files may not be on disk yet.
        const file = await poll(() => transcriptFile(id), Boolean);
        assert.ok(file, `its transcript is at <project>/${id}/subagents/agent-${agentId}.jsonl`);
        const meta = await poll(() => readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8').then(JSON.parse).catch(() => null), Boolean, 5_000);
        note('layout', { transcript: `<project>/<session>/subagents/agent-<agentId>.jsonl`, meta: meta && Object.keys(meta).sort(),
          launch: { status: launched.toolUseResult.status, async: launched.toolUseResult.isAsync } });
        // The activity card opens the column on it.
        if (!await page.locator('.activity-float').isVisible()) await page.locator(sel.activityPill).click();
        const section = page.locator('.activity-float-section').filter({ has: page.locator('.activity-float-title', { hasText: '子代理' }) });
        await section.locator('.activity-float-toggle').click();
        await section.locator(sel.openSubagent).first().click();
        await page.locator(sel.subagentColumn).waitFor();
        const row = page.locator(sel.subagentRow(agentId)), detail = page.locator(sel.subagentDetail(agentId));
        assert.equal(await row.getAttribute('data-state'), 'running');
        await detail.locator(`${sel.user}:has-text("Inspect the folder")`).waitFor({ timeout: 20_000 });
        api.release('sa-child');
        // Its turns appear while it runs: text, the folded thinking and the tool with its result.
        await detail.locator(`${sel.assistant}:has-text("ccm-sa-child-text")`).waitFor({ timeout: 40_000 });
        await detail.locator(sel.tool('Bash')).waitFor({ state: 'attached', timeout: 40_000 });
        await page.waitForFunction(selector => document.querySelector(selector)?.dataset.toolState === 'completed', `${sel.subagentDetail(agentId)} ${sel.tool('Bash')}`, { timeout: 40_000 });
        await detail.locator(sel.thought).first().waitFor({ state: 'attached', timeout: 20_000 });
        assert.equal(await row.getAttribute('data-state'), 'running', 'still running until its notification');
        api.release('sa-child-end');
        await detail.locator(`${sel.assistant}:has-text("ccm-sa-child-report")`).waitFor({ timeout: 40_000 });
        await page.waitForFunction(selector => document.querySelector(selector)?.dataset.state === 'completed', sel.subagentRow(agentId), { timeout: 60_000 });
        await page.screenshot({ path: path.join(ctx.dir, 'subagents.column.png') }).catch(() => {});
      });
      await check('subagent-resume', async () => {
        await ui.waitStatus('idle', 60_000);
        await ui.send('Resume the helper ccm:sa-resume');
        const detail = page.locator(sel.subagentDetail(agentId));
        await page.waitForFunction(selector => document.querySelector(selector)?.dataset.state === 'running', sel.subagentRow(agentId), { timeout: 60_000 });
        // The message from the main agent (an isMeta "coordinator" record) shows while the
        // resumed run waits for the model, without the native wrapper; then the new reply.
        await detail.locator(`${sel.user}:has-text("Continue please ccm:sa-child2")`).waitFor({ timeout: 40_000 });
        assert.equal(await detail.locator(`${sel.user}:has-text("The coordinator sent")`).count(), 0);
        for (let i = 0; i < 100 && !api.waiting('sa-child2'); i++) await delay(300);
        api.release('sa-child2');
        await detail.locator(`${sel.assistant}:has-text("ccm-sa-child2-report")`).waitFor({ timeout: 40_000 });
        await page.waitForFunction(selector => document.querySelector(selector)?.dataset.state === 'completed', sel.subagentRow(agentId), { timeout: 60_000 });
        await page.screenshot({ path: path.join(ctx.dir, 'subagents.resumed.png') }).catch(() => {});
        await page.locator(`${sel.subagentColumn} .task-column-bar button`).click();
      });
      // Claude Code 2.1.310+ keeps each subagent's state in its meta file: two more subagents
      // (one ends at once, one is held running), then a turn longer than the first page. Opened
      // again, all three are listed with their states though their launches are not loaded; once
      // the conversation is closed (its process gone), the held one is not shown running.
      const metaPath = async agent => (await transcriptFile(await ui.activeSessionId()))?.replace(`agent-${agentId}.jsonl`, `agent-${agent}.meta.json`);
      const older = compareVersions(ctx.version, '2.1.310') < 0 && `Claude Code ${ctx.version} writes no finished: its subagents keep the transcript's state (earlier rows)`;
      const more = {};
      api.script('sa-more', ({ step }) => step === 0
        ? { blocks: [{ type: 'tool_use', name: 'Agent', input: { description: 'Matrix quick helper', prompt: 'Report at once ccm:sa-quick', subagent_type: 'general-purpose', run_in_background: true } },
          { type: 'tool_use', name: 'Agent', input: { description: 'Matrix held helper', prompt: 'Work until released ccm:sa-hold', subagent_type: 'general-purpose', run_in_background: true } }] }
        : { text: `More step ${step} (ccm-sa-more-${step}).` });
      api.script('sa-quick', () => ({ text: 'Quick report (ccm-sa-quick-report).' }));
      api.script('sa-hold', () => ({ gate: 'sa-hold', gateTimeoutMs: 200_000, text: 'Held report (ccm-sa-hold-report).' }));
      api.script('sa-filler', () => ({ text: 'Filler (ccm-sa-filler-done). ' + 'lorem ipsum dolor sit amet '.repeat(6000) }));
      await check('subagent-listed', async () => {
        if (older) return { skip: older };
        await ui.waitStatus('idle', 60_000);
        await ui.send('Launch two more helpers ccm:sa-more');
        await ui.waitReply('ccm-sa-more-1', { timeout: 60_000 });
        const id = await ui.activeSessionId();
        const records = await readJsonl((await sandbox.projectFiles()).find(file => file.includes(id)));
        // The launching calls by description, then their results (one record each, or several in one without toolUseResult).
        const calls = new Map(records.flatMap(r => r.type === 'assistant' && Array.isArray(r.message?.content) ? r.message.content : [])
          .filter(b => b.type === 'tool_use' && b.name === 'Agent' && /^Matrix (quick|held) helper$/.test(b.input?.description)).map(b => [b.id, b.input.description.split(' ')[1]]));
        for (const r of records) for (const b of r.type === 'user' && Array.isArray(r.message?.content) ? r.message.content : []) {
          if (b.type !== 'tool_result' || !calls.has(b.tool_use_id)) continue;
          more[calls.get(b.tool_use_id)] = (r.message.content.length === 1 && r.toolUseResult?.agentId) || /agentId: ([A-Za-z0-9_-]+)/.exec(textOf(b.content))?.[1];
        }
        assert.ok(more.quick && more.held, `both launched: ${JSON.stringify(more)}`);
        for (let i = 0; i < 100 && !api.waiting('sa-hold'); i++) await delay(300);
        assert.ok(api.waiting('sa-hold') >= 1, 'the held subagent asked the model');
        // The quick one's notification gets its own reply before the long turn.
        await ui.waitReply('ccm-sa-more-2', { timeout: 60_000 });
        await ui.waitStatus('idle', 60_000);
        await ui.send('Write a long note ccm:sa-filler');
        await ui.waitReply('ccm-sa-filler-done', { timeout: 90_000 });
        const metas = {};
        for (const [name, agent] of Object.entries({ first: agentId, ...more })) metas[name] = JSON.parse(await readFile(await metaPath(agent), 'utf8'));
        note('meta', Object.fromEntries(Object.entries(metas).map(([name, meta]) => [name, { keys: Object.keys(meta).sort(), finished: meta.finished ?? null }])));
        // A fresh read: the newest page only.
        await page.reload();
        await ui.waitReply('ccm-sa-filler-done', { timeout: 30_000 });
        await page.locator('.history-page-control button').waitFor({ timeout: 30_000 });
        assert.equal(await page.locator(`${sel.user}:has-text("Launch two more helpers")`).count(), 0, 'their launch is not on the first page');
        if (!await page.locator('.activity-float').isVisible()) await page.locator(sel.activityPill).click();
        const section = page.locator('.activity-float-section').filter({ has: page.locator('.activity-float-title', { hasText: '子代理' }) });
        await section.waitFor({ timeout: 20_000 });
        await section.locator('.activity-float-toggle').click();
        await section.locator(sel.openSubagent).first().click();
        await page.locator(sel.subagentColumn).waitFor();
        const rows = () => page.locator(`${sel.subagentColumn} .task-column-list button[data-kind="agent"]`).evaluateAll(buttons => buttons.map(row => [row.dataset.agentId, row.dataset.state, row.querySelector('.task-state')?.textContent]));
        await page.waitForFunction(selector => document.querySelectorAll(selector).length >= 3, `${sel.subagentColumn} .task-column-list button[data-kind="agent"]`, { timeout: 20_000 });
        const listed = await rows();
        note('listed', listed);
        assert.deepEqual(listed.map(([agent, state]) => [agent, state]), [[more.held, 'running'], [more.quick, 'completed'], [agentId, 'completed']], 'all three, running first, newest first');
        assert.ok(listed.every(([, , label]) => label !== '较早'), 'none is "earlier"');
        assert.equal(await page.locator(`${sel.user}:has-text("Launch two more helpers")`).count(), 0, 'still not loaded');
        await page.screenshot({ path: path.join(ctx.dir, 'subagents.listed.png') }).catch(() => {});
      });
      await check('subagent-process-gone', async () => {
        if (older) return { skip: older };
        assert.ok(more.held, 'the held subagent runs');
        await page.waitForFunction(selector => document.querySelector(selector)?.dataset.state === 'running', sel.subagentRow(more.held), { timeout: 20_000 });
        await ui.closeChat();
        await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('data-session-live') === 'false', sel.activeRow, { timeout: 30_000 });
        if (!await page.locator(sel.subagentRow(more.held)).count()) {
          if (!await page.locator('.activity-float').isVisible()) await page.locator(sel.activityPill).click();
          const section = page.locator('.activity-float-section').filter({ has: page.locator('.activity-float-title', { hasText: '子代理' }) });
          if (!await section.locator(sel.openSubagent).count()) await section.locator('.activity-float-toggle').click();
          await section.locator(sel.openSubagent).first().click();
        }
        await page.waitForFunction(selector => { const state = document.querySelector(selector)?.dataset.state; return !!state && state !== 'running'; }, sel.subagentRow(more.held), { timeout: 30_000 });
        const meta = JSON.parse(await readFile(await metaPath(more.held), 'utf8'));
        const state = await page.locator(sel.subagentRow(more.held)).getAttribute('data-state');
        note('after-close', { state, finished: meta.finished ?? null });
        assert.equal(state, meta.finished ? 'completed' : 'interrupted', 'ended by the process exit: interrupted unless Claude Code wrote finished');
        assert.equal(await page.locator(`${sel.subagentColumn} .task-column-list button[data-state="running"]`).count(), 0, 'nothing runs');
        await page.screenshot({ path: path.join(ctx.dir, 'subagents.process-gone.png') }).catch(() => {});
      });
      api.release('sa-hold');
      // The user resumes the session in a terminal of their own (a tmux session the app never reads),
      // which launches one more subagent: running while that process lives, not once it is gone.
      api.script('sa-out', ({ step }) => step === 0
        ? { blocks: [{ type: 'tool_use', name: 'Agent', input: { description: 'Matrix outside helper', prompt: 'Work until released ccm:sa-out-child', subagent_type: 'general-purpose', run_in_background: true } }] }
        : { text: `Outside step ${step} (ccm-sa-out-${step}).` });
      api.script('sa-out-child', () => ({ gate: 'sa-out-child', gateTimeoutMs: 200_000, text: 'Outside report (ccm-sa-out-report).' }));
      await check('subagent-elsewhere', async () => {
        if (older) return { skip: older };
        const id = await ui.activeSessionId(), own = 'ccm-own-terminal', known = new Set([agentId, ...Object.values(more)]);
        const before = await sandbox.projectFiles();
        // Its terminal is closed once (in the check, or else in `finally`), its processes awaited by PID.
        let closing, passed = false;
        const closeOwn = () => closing ??= closeOwnSession(sandbox, own);
        try {
          sandbox.tmux('new-session', '-d', '-s', own, '-x', '120', '-y', '40', '-c', folders.main.cwd,
            'env', '-i', ...Object.entries(sandbox.env).map(([key, value]) => `${key}=${value}`), 'claude', '--resume', id);
          for (let i = 0; i < 100 && !/^\s*❯/m.test(sandbox.capture(own)); i++) await delay(300);
          sandbox.tmux('send-keys', '-t', own, '-l', 'Launch one more helper ccm:sa-out');
          await delay(500);
          sandbox.tmux('send-keys', '-t', own, 'Enter');
          for (let i = 0; i < 100 && !api.waiting('sa-out-child'); i++) await delay(300);
          assert.ok(api.waiting('sa-out-child') >= 1, `the outside helper asked the model: ${sandbox.capture(own).slice(-600)}`);
          // The launch's result reaches the transcript when Claude Code writes it, which can be after
          // the subagent's own request: read until a launch not seen before is there. Read too: any
          // transcript made since (a resume that copied the session to a new UUID), for the message.
          const launches = async () => Promise.all((await sandbox.projectFiles()).filter(file => file.includes(id) || !before.includes(file)).map(async file =>
            ({ file: path.basename(file), agents: (await readJsonl(file).catch(() => [])).flatMap(r => r.toolUseResult?.agentId ? [r.toolUseResult.agentId] : []) })));
          const fresh = files => files.find(entry => entry.file === `${id}.jsonl`)?.agents.filter(agent => !known.has(agent)) ?? [];
          const t0 = Date.now(), read = await poll(launches, files => fresh(files).length > 0, 30_000);
          const out = fresh(read).at(-1), launchSeenMs = Date.now() - t0;
          assert.ok(out, `its launch is in the same transcript: agent IDs by file ${JSON.stringify(read)}, known ${JSON.stringify([...known])}`);
          await page.waitForFunction(selector => document.querySelector(selector)?.dataset.state === 'running', sel.subagentRow(out), { timeout: 40_000 });
          assert.equal(await page.locator(sel.activeRow).getAttribute('data-session-live'), 'false', 'no Lectern pane runs it');
          await page.screenshot({ path: path.join(ctx.dir, 'subagents.elsewhere.png') }).catch(() => {});
          await closeOwn();
          await page.waitForFunction(selector => { const state = document.querySelector(selector)?.dataset.state; return !!state && state !== 'running'; }, sel.subagentRow(out), { timeout: 40_000 });
          note('elsewhere', { state: await page.locator(sel.subagentRow(out)).getAttribute('data-state'), held: await page.locator(sel.subagentRow(more.held)).getAttribute('data-state'), launchSeenMs });
          passed = true;
        } finally {
          // Pass or fail, the outside Claude Code is gone before its subagent's gate opens: nothing
          // outside the app goes on with that turn (or writes the configuration) while the next
          // scenario runs, and the tmux server its session started (sandbox.mjs) exits with it.
          const stopped = await closeOwn();
          api.release('sa-out-child');
          const config = await apiKeyApproval(sandbox);
          note('elsewhere-cleanup', { stopped, config });
          // Not to hide the first failure: checked only when the rest passed (the note has them anyway).
          if (passed) {
            assert.deepEqual(stopped, [], 'the outside Claude Code exited once its terminal was closed');
            assert.ok(config.ok, `once it exited, the configuration is still JSON approving the API key: ${JSON.stringify(config)}`);
          }
        }
      });
    },
  },
  {
    id: 'task-column',
    features: ['task-shell-output', 'task-redirect-output', 'task-monitor-output'],
    timeoutMs: 200_000,
    async run(ctx) {
      const { ui, page, api, sandbox, folders, check, note } = ctx;
      // The main loop starts a background shell that prints, one that redirects into a file
      // and (where offered; a deferred tool from 2.1.310, not offered by 2.1.300) a monitor.
      let monitor = false, searched = false, launched = false;
      api.script('task-main', ({ body }) => {
        const offered = (body.tools ?? []).map(tool => tool.name);
        if (!launched && !searched && !offered.includes('Monitor') && offered.includes('ToolSearch')) {
          searched = true;
          return { blocks: [{ type: 'tool_use', name: 'ToolSearch', input: { query: 'select:Monitor', max_results: 1 } }] };
        }
        if (!launched) {
          launched = true; monitor = offered.includes('Monitor');
          return { blocks: [
            { type: 'tool_use', name: 'Bash', input: { command: 'echo ccm-task-plain-1; sleep 4; echo ccm-task-plain-2', description: 'Matrix plain task', run_in_background: true } },
            { type: 'tool_use', name: 'Bash', input: { command: 'sleep 1; echo ccm-task-redirected > ccm-task.log 2>&1', description: 'Matrix redirected task', run_in_background: true } },
            ...(monitor ? [{ type: 'tool_use', name: 'Monitor', input: { command: 'echo ccm-monitor-1; sleep 1; echo ccm-monitor-2', description: 'Matrix monitor', timeout_ms: 60000 } }] : [])] };
        }
        return { text: 'Background tasks noted (ccm-task-started).' };
      });
      await startChat(ctx, folders.tasks, 'Start background tasks ccm:task-main');
      await ui.waitReply('ccm-task-started', { timeout: 60_000 });
      const id = await ui.activeSessionId();
      const main = (await sandbox.projectFiles()).find(file => file.includes(id));
      const calls = new Map();
      for (const r of await readJsonl(main)) for (const block of Array.isArray(r.message?.content) ? r.message.content : [])
        if (block.type === 'tool_use' && /^Matrix /.test(block.input?.description ?? '')) calls.set(block.input.description, block.id);
      const plain = calls.get('Matrix plain task'), redirected = calls.get('Matrix redirected task'), watch = calls.get('Matrix monitor');
      assert.ok(plain && redirected, `the tool calls are in the transcript: ${JSON.stringify([...calls])}`);
      const results = (await readJsonl(main)).filter(r => r.toolUseResult && typeof r.toolUseResult === 'object');
      note('results', results.filter(r => r.toolUseResult.backgroundTaskId || r.toolUseResult.taskId).map(r => Object.keys(r.toolUseResult).sort().join(',')));
      if (!await page.locator('.activity-float').isVisible()) await page.locator(sel.activityPill).click();
      const section = page.locator('.activity-float-section').filter({ has: page.locator('.activity-float-title', { hasText: /^终端$/ }) });
      await section.locator('.activity-float-toggle').click();
      await page.locator(`article.activity-card[data-activity-id="${plain}"] ${sel.openSubagent}`).click();
      await page.locator(sel.taskColumn).waitFor();
      const detail = page.locator(sel.taskDetail(plain));
      await check('task-shell-output', async () => {
        await detail.locator('.task-output', { hasText: 'ccm-task-plain-1' }).waitFor({ timeout: 30_000 });
        assert.match(await detail.locator('.task-command').innerText(), /echo ccm-task-plain-1; sleep 4/);
        // Appended while it runs, then the exit code from the end of the native file.
        await detail.locator('.task-output', { hasText: 'ccm-task-plain-2' }).waitFor({ timeout: 30_000 });
        await page.waitForFunction(selector => document.querySelector(selector)?.dataset.state === 'completed', sel.taskDetail(plain), { timeout: 60_000 });
        await detail.locator('[data-exit-code="0"]').waitFor({ timeout: 20_000 });
        assert.ok(!(await detail.locator('.task-output').innerText()).includes('[exited'), 'the native trailer is not shown as output');
        await page.screenshot({ path: path.join(ctx.dir, 'task-column.shell.png') }).catch(() => {});
      });
      await check('task-redirect-output', async () => {
        await page.locator(sel.taskRow(redirected)).click();
        const file = page.locator(sel.taskDetail(redirected));
        await file.locator('.task-output', { hasText: 'ccm-task-redirected' }).waitFor({ timeout: 40_000 });
        assert.equal(await file.getAttribute('data-source'), 'file:0');
        assert.equal(await file.locator('[data-redirect-path]').getAttribute('data-redirect-path'), path.join(folders.tasks.cwd, 'ccm-task.log'));
        await page.screenshot({ path: path.join(ctx.dir, 'task-column.redirect.png') }).catch(() => {});
      });
      await check('task-monitor-output', async () => {
        note('monitor', monitor ? 'offered' : 'not offered');
        if (!monitor) return { skip: 'Claude Code does not offer the Monitor tool' };
        assert.ok(watch, 'the Monitor call is in the transcript');
        await page.locator(sel.taskRow(watch)).click();
        await page.locator(sel.taskDetail(watch)).locator('.task-output', { hasText: 'ccm-monitor-2' }).waitFor({ timeout: 40_000 });
      });
      await page.locator(`${sel.taskColumn} .task-column-bar button`).click();
    },
  },
  {
    // Lectern sends /goal from the chat box and shows the goal as a capsule above the input box and as
    // event rows in the chat. The fake evaluator answers from the condition's `ccm-goal:` plan
    // (fake-api.mjs); the main scripts answer the first turn and the turn the goal's feedback continues,
    // held at a gate where a row needs the goal to stay put. Each row is its own chat and keeps its own
    // evidence (goal.<row>.failure.json), so one failing row does not hide the others. Not here: the
    // check-in while background work runs (at least a minute, CLAUDE_CODE_GOAL_CHECKIN_MINUTES).
    id: 'goal',
    features: ['goal-lifecycle', 'goal-clear-busy', 'goal-failed', 'goal-check-error', 'goal-resume'],
    timeoutMs: 360_000,
    async run(ctx) {
      const { ui, page, api, sandbox, folders, check, note } = ctx;
      // Step two is long (13 KB), as a goal's work is: the transcript then outgrows the first page read on
      // every release, not only where Claude Code's own snapshot records already do (the reopen check).
      api.script('goal-life', ({ feedback }) => feedback ? { gate: 'goal-life-2', text: `${paragraph.repeat(90)}\n\nStep two done (ccm-goal-step-two).` } : { text: 'Step one done (ccm-goal-step-one).' });
      api.script('goal-clear', () => ({ gate: 'goal-clear', text: 'Held until released (ccm-goal-clear-reply).' }));
      api.script('goal-fail', () => ({ text: 'Tried the impossible (ccm-goal-fail-reply).' }));
      api.script('goal-error', () => ({ text: `${paragraph.repeat(90)}\n\nDid the work (ccm-goal-error-reply).` }));
      api.script('goal-resume', ({ feedback }) => feedback ? { gate: 'goal-resume', text: 'Still at it (ccm-goal-resume-two).' } : { text: 'Started (ccm-goal-resume-one).' });
      const checks = condition => api.requests.filter(r => r.kind === 'goal' && r.condition === condition).length;
      const held = name => poll(() => api.waiting(name), n => n >= 1, 30_000).then(n => assert.ok(n >= 1, `the request held at ${name} reached the fake API`));
      const screen = (test, ms = 20_000) => poll(() => ui.screen(), test, ms, 300);
      const records = (id, done = () => true) => poll(() => goalRecords(sandbox, id), done);
      // Reopened as after a restart: a fresh read from the newest page (reloading the window; leaving and
      // coming back shows the cached reader). Claude Code writes some 110 KB of snapshot records after the
      // first prompt, so that page can start at the `/goal` command, after the setting record before it.
      const reopen = async reply => { await page.reload(); await ui.waitReply(reply, { timeout: 30_000 }); };
      const failures = [];
      let id;
      const row = async (feature, gates, fn) => {
        id = undefined;
        try { await check(feature, fn); } catch (error) {
          failures.push(`${feature}: ${String(error?.message ?? error).split('\n')[0]}`);
          const evidence = { error: String(error?.stack ?? error), shown: await goalShown(page).catch(() => null), screen: (await ui.screen().catch(() => '')).split('\n'),
            goalRecords: await goalRecords(sandbox, id ?? await ui.activeSessionId(2_000)).catch(() => []), transcript: await ui.transcript().catch(() => []), requests: api.requests.slice(-12) };
          await writeFile(path.join(ctx.dir, `goal.${feature}.failure.json`), JSON.stringify(evidence, null, 2));
          await page.screenshot({ path: path.join(ctx.dir, `goal.${feature}.failure.png`) }).catch(() => {});
        } finally {
          for (const gate of gates) api.release(gate);
          await ui.closeChat().catch(() => {});
        }
      };
      await row('goal-lifecycle', ['goal-life-2'], async () => {
        const condition = 'Finish both steps ccm:goal-life ccm-goal:no-yes';
        id = await startGoal(ctx, folders.main, condition);
        await waitGoalEvent(page, 'set');
        // Checked once, not met: the goal's feedback continues the turn, held here.
        await waitGoal(page, { status: 'active', phase: 'not-met' });
        await waitGoalEvent(page, 'not-met');
        await held('goal-life-2');
        // Seen now: the long step two scrolls it out of the pane.
        assert.match(await screen(s => /◯ Goal not yet met/.test(s)), /◯ Goal not yet met/);
        api.release('goal-life-2');
        await waitGoal(page, { status: 'met', condition });
        await waitGoalEvent(page, 'met');
        const list = await records(id, list => list.some(r => r.met && !r.sentinel));
        note('lifecycle-records', list.map(r => ({ met: r.met, sentinel: r.sentinel, iterations: r.iterations })));
        assert.deepEqual(list.map(r => [r.met, !!r.sentinel, !!r.failed]), [[false, true, false], [false, false, false], [true, false, false]], 'set, not met, met');
        assert.equal(list[2].iterations, 2);
        const shown = await screen(s => /✔ Goal achieved/.test(s) && !GOAL_FOOTER.test(s));
        assert.match(shown, /✔ Goal achieved/);
        assert.doesNotMatch(shown, GOAL_FOOTER, 'the native footer is gone');
        await reopen('ccm-goal-step-two');
        await waitGoal(page, { status: 'met', condition });
        for (const kind of ['set', 'not-met', 'met']) await waitGoalEvent(page, kind, 15_000).catch(error => { throw new Error(`reopened: ${error.message}`); });
      });
      await row('goal-clear-busy', ['goal-clear'], async () => {
        const condition = 'Stop once cleared ccm:goal-clear ccm-goal:yes';
        id = await startGoal(ctx, folders.main, condition);
        await held('goal-clear');
        await page.locator(sel.stop).waitFor({ timeout: 30_000 });
        assert.match(await screen(s => GOAL_FOOTER.test(s)), GOAL_FOOTER, 'the native footer shows the goal');
        // The reply still runs: clear from the opened capsule, confirmed in the app's dialog.
        if (!await page.locator(sel.goalClear).first().isVisible()) await page.locator(`${sel.goal} > summary`).first().click();
        await page.waitForFunction(selector => document.querySelector(selector)?.disabled === false, sel.goalClear, { timeout: 30_000 });
        await page.locator(sel.goalClear).first().click();
        await page.locator('dialog.confirm-action[open] .danger-button').click();
        await waitGoal(page, { status: 'cleared', condition });
        await waitGoalEvent(page, 'cleared');
        const last = (await records(id, list => list.at(-1)?.met === true)).at(-1);
        assert.deepEqual([last?.met, last?.sentinel, last?.condition], [true, true, condition], `the clearing sentinel: ${JSON.stringify(last)}`);
        assert.doesNotMatch(await screen(s => !GOAL_FOOTER.test(s)), GOAL_FOOTER, 'the native footer is gone');
        assert.equal(api.requests.filter(r => r.script === 'goal-clear' && r.done).length, 0, 'cleared while the reply ran');
        api.release('goal-clear');
        await ui.waitReply('ccm-goal-clear-reply');
        await ui.waitStatus('idle', 30_000);
        assert.equal(checks(condition), 0, 'no goal check once cleared');
      });
      await row('goal-failed', [], async () => {
        const condition = 'Reach what cannot be reached ccm:goal-fail ccm-goal:impossible';
        id = await startGoal(ctx, folders.main, condition, { status: 'failed' });
        await waitGoalEvent(page, 'failed');
        const last = (await records(id, list => list.at(-1)?.failed)).at(-1);
        assert.deepEqual([last?.met, last?.failed, last?.iterations], [false, true, 1], `the failed record: ${JSON.stringify(last)}`);
        // "Goal could not be achieved" up to 2.1.325, "Goal couldn't be achieved" from 2.1.326.
        const shown = await screen(s => /✘ Goal could(?:n't| not) be achieved/.test(s) && !GOAL_FOOTER.test(s));
        assert.match(shown, /✘ Goal could(?:n't| not) be achieved/);
        assert.doesNotMatch(shown, GOAL_FOOTER, 'the native footer is gone');
      });
      await row('goal-check-error', [], async () => {
        // The evaluator's answer is not JSON: the goal stays active, Claude Code retries in a minute.
        const condition = 'Judge this with a broken check ccm:goal-error ccm-goal:bad';
        id = await startGoal(ctx, folders.main, condition);
        await waitGoal(page, { status: 'active', phase: 'retrying' });
        await waitGoalEvent(page, 'retry');
        const shown = await screen(s => /the goal check could not complete/.test(s));
        assert.match(shown, /Goal still active · the goal check could not complete/);
        assert.match(shown, GOAL_FOOTER, 'the native footer still shows the goal');
        const last = (await records(id)).at(-1);
        assert.deepEqual([last?.met, last?.sentinel], [false, true], `a failed check writes no goal_status: ${JSON.stringify(last)}`);
        await reopen('ccm-goal-error-reply');
        await waitGoal(page, { status: 'active', phase: 'retrying', condition }).catch(error => { throw new Error(`reopened: ${error.message}`); });
        await waitGoalEvent(page, 'retry', 15_000);
        await ui.waitStatus('idle', 30_000);
        await ui.send('/goal clear');
        await waitGoal(page, { status: 'cleared', condition });
        const cleared = (await records(id, list => list.at(-1)?.met === true)).at(-1);
        assert.deepEqual([cleared?.met, cleared?.sentinel], [true, true], `the clearing sentinel: ${JSON.stringify(cleared)}`);
        assert.doesNotMatch(await screen(s => !GOAL_FOOTER.test(s)), GOAL_FOOTER, 'the native footer is gone');
      });
      await row('goal-resume', ['goal-resume'], async () => {
        const condition = 'Keep at it across a resume ccm:goal-resume ccm-goal:no';
        id = await startGoal(ctx, folders.main, condition);
        await waitGoal(page, { status: 'active', phase: 'not-met' });
        await held('goal-resume');
        const before = await goalRecords(sandbox, id);
        // Closed while the goal's continued turn runs: Lectern stops Claude Code (TERM) and keeps the
        // chat as history (ui.closeChat would also kill a pane still there after 0.8 s).
        await page.locator('.toolbar-button[aria-label="关闭当前对话"]').click();
        await page.locator('dialog.confirm-action[open] button[type="submit"]').click();
        await page.locator('.resume-bar:not([data-leaving])').waitFor({ timeout: 30_000 });
        api.release('goal-resume');
        const last = (await goalRecords(sandbox, id)).at(-1);
        assert.ok(last && last.met === false && !last.failed, `still active when closed: ${JSON.stringify(last)}`);
        // Closed, the goal still active in the transcript is shown as history (no clear button).
        await waitGoal(page, { status: 'active', history: 'true', condition });
        await page.locator('.resume-bar:not([data-leaving]) button').first().click();
        await ui.ready(60_000);
        const argv = await ui.claudeArgv();
        assert.equal(argv[argv.indexOf('--resume') + 1], id, 'claude --resume <session>');
        await waitGoal(page, { status: 'active', condition });
        assert.match(await screen(s => GOAL_FOOTER.test(s)), GOAL_FOOTER, 'Claude Code restored the goal');
        // Live again: no longer history, the clear button back.
        await page.waitForFunction(selector => { const el = document.querySelector(selector); return el && !el.hasAttribute('data-goal-history'); }, sel.goal, { timeout: 30_000 })
          .catch(async error => { throw new Error(`the resumed goal still shows as history (${JSON.stringify(await goalShown(page))}): ${error.message.split('\n')[0]}`); });
        assert.equal(await page.locator(sel.goalClear).count(), 1, 'the clear button is back');
        note('resume-records', { before: before.length, after: (await goalRecords(sandbox, id)).length });
      });
      if (failures.length) throw new Error(`goal rows failed: ${failures.join('; ')}`);
      // end of goal rows
    },
  },
  {
    // Settings → Session's recording hooks (src/backend/dialog-hooks.ts). Last: every other scenario
    // runs with the setting at its default (off), and this one turns it off again whatever happens.
    id: 'dialog-hooks',
    features: ['hooks-launch', 'hooks-question-tall', 'hooks-permission', 'hooks-off'],
    timeoutMs: 300_000,
    async run(ctx) {
      const { ui, page, api, folders, check } = ctx;
      const card = page.locator(sel.question), perm = page.locator(sel.permission), answers = {};
      // 30 rows of question, three options with descriptions: taller than the 40-row pane.
      const items = Array.from({ length: 30 }, (_, i) => `- Step ${i + 1}: one more row that makes this dialog taller than the pane.`);
      const tall = { header: 'Plan', multiSelect: false, question: ['Which plan should run tonight?', '', ...items].join('\n'), options: [
        { label: 'Plan A', description: 'Run the full suite on every target, then publish the report.' },
        { label: 'Plan B', description: 'Run only the quick checks this time.' },
        { label: 'Plan C', description: 'Do nothing tonight and ask again tomorrow.' }] };
      api.script('hooks-tall', ({ step, toolResults }) => {
        if (step === 0) return { blocks: [{ type: 'text', text: 'One question first.' }, { type: 'tool_use', name: 'AskUserQuestion', input: { questions: [tall] } }], tailMs: 1500 };
        answers.tall = toolResults.map(result => result.text).join('\n');
        return { text: 'Thanks (ccm-hooks-tall-done).' };
      });
      const command = `printf '%s\\n' ${Array.from({ length: 14 }, (_, i) => `hook-line-${i + 1}`).join(' ')} > hooks-perm.txt`;
      api.script('hooks-perm', ({ step }) => step === 0 ? { blocks: [{ type: 'tool_use', name: 'Bash', input: { command, description: 'Write the hooks marker' } }] }
        : { text: 'Written (ccm-hooks-perm-done).' });
      api.script('hooks-off', () => ({ text: 'Plain reply (ccm-hooks-off-done).' }));
      try {
        await check('hooks-launch', async () => {
          await setDialogHooks(page, true);
          await startChat(ctx, folders.main, 'Ask me the tall one ccm:hooks-tall');
          const hooks = launchedHooks(await ui.claudeArgv());
          ctx.note('hooks-settings', hooks && Object.fromEntries(Object.entries(hooks).map(([event, [group]]) => [event, group.matcher ?? '*'])));
          assert.deepEqual(Object.keys(hooks ?? {}), ['PreToolUse', 'PermissionRequest', 'SessionStart']);
          assert.equal(hooks.PreToolUse[0].matcher, 'AskUserQuestion');
          assert.equal((await hookStatus(page, 'active', 60_000)).state, 'active');
        });
        await check('hooks-question-tall', async () => {
          await card.waitFor({ timeout: 60_000 });
          const screen = await ui.screen();
          await writeFile(path.join(ctx.dir, 'hooks-question-tall.txt'), screen);
          // The dialog's top (rule, tab strip, the question's start) is out of the pane.
          ctx.note('hooks-tall-top-cut', !screen.includes('Which plan should run tonight?'));
          await page.waitForFunction(selector => document.querySelector(selector)?.dataset.questionCall, sel.question, { timeout: 10_000 });
          assert.equal(await card.locator('h3').textContent(), tall.question);
          assert.deepEqual((await card.locator('button.question-option strong').allInnerTexts()).slice(0, 3), ['Plan A', 'Plan B', 'Plan C']);
          await card.locator('button.question-option[data-question-number="2"]').click();
          await ui.waitReply('ccm-hooks-tall-done');
          assert.match(answers.tall, /Plan B/);
        });
        await check('hooks-permission', async () => {
          await startChat(ctx, folders.perm, 'Write the hooks marker ccm:hooks-perm');
          await perm.waitFor({ timeout: 60_000 });
          const shown = perm.locator('.permission-call[data-permission-hook-tool="Bash"]');
          await shown.waitFor({ timeout: 10_000 });
          assert.match(await shown.innerText(), /hook-line-14 > hooks-perm\.txt/);
          await page.waitForFunction(selector => document.querySelector(selector)?.dataset.permissionCall, sel.permission, { timeout: 30_000 });
          const id = await perm.getAttribute('data-permission-call');
          assert.equal((await ui.tools()).find(tool => tool.id === id)?.name, 'Bash');
          await perm.locator('[data-permission-option="1"]').click();
          await perm.waitFor({ state: 'detached', timeout: 30_000 });
          await ui.waitReply('ccm-hooks-perm-done');
          assert.match(await readFile(path.join(folders.perm.cwd, 'hooks-perm.txt'), 'utf8'), /^hook-line-14$/m);
        });
      } finally {
        await setDialogHooks(page, false);
      }
      await check('hooks-off', async () => {
        await startChat(ctx, folders.main, 'Just reply ccm:hooks-off');
        await ui.waitReply('ccm-hooks-off-done');
        assert.equal(launchedHooks(await ui.claudeArgv()), undefined);
        assert.equal((await hookStatus(page, 'off')).state, 'off');
      });
    },
  },
  // end of SCENARIOS
];

/** The keys a user presses on a native first-run screen (none for other screens).
 * The auto-mode nudge is left to the run-wide watcher (dismissNativeNudges). */
export function firstRunAnswer(screen) {
  if (/Choose the text style that looks best/.test(screen)) return { name: 'theme', keys: ['Enter'] };
  if (/Do you want to use this API key\?/.test(screen)) return { name: 'api-key', keys: ['Up', 'Enter'] };
  if (/Security notes:?/i.test(screen) && /Press Enter to continue/i.test(screen)) return { name: 'security-notes', keys: ['Enter'] };
  if (/Use Claude Code's terminal setup\?/.test(screen)) return { name: 'terminal-setup', keys: ['Escape'] };
  if (/Press Enter to continue/i.test(screen) && !/❯\s*$/m.test(screen)) return { name: 'continue', keys: ['Enter'] };
  return undefined;
}

/** A 16×16 PNG, built here so the repository carries no binary fixture. */
function pngSwatch() {
  const { deflateSync, crc32 } = zlib;
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])) >>> 0);
    return Buffer.concat([length, Buffer.from(type), data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(16, 0); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.concat(Array.from({ length: 16 }, (_, y) => Buffer.concat([Buffer.from([0]), ...Array.from({ length: 16 }, (_, x) => Buffer.from([x * 16, y * 16, 160]))])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
