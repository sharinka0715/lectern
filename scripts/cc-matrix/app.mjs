// The desktop app under test, launched by Playwright inside a sandbox, plus the
// UI helpers the scenarios share. Selectors live here (classes and data
// attributes first, visible text last) so a UI text change touches one file.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron, resizeWindow } from '../fixtures/electron.mjs';
import { SESSION_PREFIX } from './sandbox.mjs';

// Elements fading out stay a moment with data-leaving (inert, hidden from roles): never count or click them.
export const sel = {
  workspace: name => `.workspace-select[aria-label="${name}"]`,
  composer: 'form.composer textarea',
  send: 'form.composer .send-button',
  stop: 'form.composer .interrupt-button',
  turnAction: 'form.composer .composer-turn-action',
  activeRow: '.session-row.active',
  row: id => `.session-row[data-session-id="${id}"]`,
  assistant: 'article.message-assistant:not([data-leaving])',
  user: 'article.message-user:not([data-leaving])',
  permission: 'section.permission-card:not([data-leaving])',
  question: 'section.question-card:not([data-leaving])',
  trust: '.directory-trust-card:not([data-leaving])',
  queue: 'section.turn-queue:not([data-leaving])',
  progress: '.turn-progress:not([data-leaving])',
  tool: name => `details.tool-block[data-tool-name="${name}"]`,
  thought: 'details.thought-row[data-thought]',
  activityPill: '.activity-float-pill',
  openSubagent: '.activity-open-conversation',
  subagentColumn: '[data-task-column]',
  subagentRow: id => `[data-task-column] .task-column-list button[data-agent-id="${id}"]`,
  subagentDetail: id => `[data-task-column] [data-subagent-detail="${id}"]`,
  taskColumn: '[data-task-column]',
  taskRow: id => `[data-task-column] .task-column-list button[data-task-key="${id}"]`,
  taskDetail: id => `[data-task-column] [data-task-detail="${id}"]`,
  // /goal: the capsule above the input box (a <details>: data-goal-status, -phase, -condition,
  // -source), the clear button inside it (the app asks first) and the goal's event rows in the chat.
  goal: '[data-goal-status]:not([data-leaving])',
  goalClear: '[data-goal-clear]:not([data-leaving])',
  goalEvent: kind => `[data-goal-event="${kind}"]:not([data-leaving])`,
};

/** Workspaces the app starts with: one per folder, all on this machine, sharing
 * the sandbox's Claude configuration directory. */
export async function writeWorkspaces(sandbox, folders) {
  const entries = folders.map(folder => ({ id: folder.id, name: folder.name, kind: 'local', cwd: folder.cwd, ...(folder.historyScan === false && { historyScan: false }) }));
  await writeFile(path.join(sandbox.profile, 'workspaces.json'), JSON.stringify(entries, null, 2));
  return entries;
}

export async function launchApp(sandbox, { output, executable } = {}) {
  await mkdir(output, { recursive: true });
  // The scenarios' few text selectors are Chinese; pin the UI language (the sandbox LANG is en_US).
  const env = { ...sandbox.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: sandbox.profile, LECTERN_LOG_DIR: path.join(output, 'diagnostics'), LECTERN_DIAGNOSTIC_CONTENT: '1' };
  // macOS: Chromium must not reach for the login keychain from a temporary HOME.
  const switches = process.platform === 'darwin' ? ['--use-mock-keychain'] : [];
  const app = await _electron.launch({ args: [...(executable ? [] : ['.']), ...switches], ...(executable && { executablePath: path.resolve(executable) }), env, cwd: process.cwd(), timeout: 60_000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await resizeWindow(app, page, 1480, 940).catch(() => {});
  return { app, page, errors };
}

export function ui(page, sandbox) {
  const composer = page.locator(sel.composer);
  const helpers = {
    page, composer,
    async openDraft(workspaceName) {
      await page.locator(sel.workspace(workspaceName)).click();
      await page.waitForFunction(selector => { const el = document.querySelector(selector); return el && !el.disabled && el.getAttribute('aria-disabled') !== 'true'; }, sel.composer, { timeout: 30_000 });
    },
    async ready(timeout = 60_000) {
      await page.waitForFunction(selector => { const el = document.querySelector(selector); return el && !el.disabled && el.getAttribute('aria-disabled') !== 'true'; }, sel.composer, { timeout });
    },
    async type(text) { await composer.fill(text); },
    /** Send from an idle composer (the round send button). */
    async send(text) {
      await helpers.ready();
      await composer.fill(text);
      await page.locator(sel.send).click();
    },
    activeSessionId: (timeout = 10_000) => page.locator(sel.activeRow).first().getAttribute('data-session-id', { timeout }).catch(() => null),
    status: () => page.locator(sel.activeRow).getAttribute('data-status').catch(() => null),
    async waitStatus(status, timeout = 60_000) {
      await page.waitForFunction(([selector, wanted]) => document.querySelector(selector)?.getAttribute('data-status') === wanted, [sel.activeRow, status], { timeout });
    },
    /** Final (JSONL) assistant text containing `text`. */
    async waitReply(text, { timeout = 60_000, source = 'jsonl' } = {}) {
      await page.waitForFunction(([selector, wanted, src]) => [...document.querySelectorAll(selector)].some(el => (!src || el.dataset.source === src) && el.textContent.includes(wanted)),
        [sel.assistant, text, source], { timeout });
    },
    async waitUser(text, timeout = 60_000) {
      await page.waitForFunction(([selector, wanted]) => [...document.querySelectorAll(selector)].some(el => el.dataset.source === 'jsonl' && el.textContent.includes(wanted)), [sel.user, text], { timeout });
    },
    async transcript() {
      return page.evaluate(() => [...document.querySelectorAll('article.message')].map(el => ({ role: el.dataset.role, source: el.dataset.source, text: el.textContent.slice(0, 400),
        interrupted: !!el.querySelector('.message-interrupted') })));
    },
    async tools() {
      return page.evaluate(() => [...document.querySelectorAll('details.tool-block[data-tool-name]')].map(el => ({ name: el.dataset.toolName, state: el.dataset.toolState, id: el.dataset.toolId,
        text: el.querySelector('summary')?.textContent ?? '' })));
    },
    /** Open a tool row (and the group folding it) and return its result text. */
    async expandTool(name, index = 0) {
      await page.evaluate(([selector, i]) => {
        const row = document.querySelectorAll(selector)[i];
        for (let el = row; el; el = el.parentElement?.closest('details')) el.open = true;
      }, [sel.tool(name), index]);
      const output = page.locator(sel.tool(name)).nth(index).locator('.tool-output');
      await output.waitFor({ timeout: 10_000 });
      return output.innerText();
    },
    /** The tmux pane of the active chat (the app names sessions <prefix><uuid prefix>-…). */
    async pane() {
      const id = await helpers.activeSessionId(2_000);
      if (!id) return undefined;
      const line = sandbox.tmux('list-panes', '-a', '-F', '#{pane_id} #{session_name}').split('\n').find(row => row.includes(` ${SESSION_PREFIX}${id.slice(0, 8)}`));
      return line?.split(' ')[0];
    },
    async screen() { return sandbox.capture(await helpers.pane()); },
    /** The argv of the Claude process in the active chat's pane (a descendant of the pane's shell). */
    async claudeArgv() {
      const pane = await helpers.pane();
      const root = sandbox.tmux('display-message', '-p', '-t', pane, '#{pane_pid}').trim();
      if (!/^\d+$/.test(root)) return [];
      const table = execFileSync('ps', ['-A', '-o', 'pid=,ppid=']).toString().trim().split('\n').map(line => line.trim().split(/\s+/));
      const tree = [root];
      for (let i = 0; i < tree.length; i++) for (const [pid, ppid] of table) if (ppid === tree[i]) tree.push(pid);
      for (const pid of tree) {
        const argv = process.platform === 'linux'
          ? (await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).split('\0').filter(Boolean)
          : execFileSync('ps', ['-o', 'args=', '-p', pid]).toString().trim().split(/\s+/);
        if (argv.length && path.basename(argv[0]) === 'claude') return argv;
      }
      return [];
    },
    async closeChat() {
      const pane = await helpers.pane();
      const button = page.locator('.toolbar-button[aria-label="关闭当前对话"], .toolbar-button[aria-label="Close this conversation"]').first();
      if (await button.count()) {
        await button.click().catch(() => {});
        // "Close conversation" asks first; confirm with the dialog's submit button.
        const confirm = page.locator('dialog.confirm-action[open] button[type="submit"]');
        await confirm.waitFor({ timeout: 5_000 }).then(() => confirm.click(), () => {});
        await page.waitForTimeout(800);
      }
      if (pane && sandbox.tmux('display-message', '-p', '-t', pane, '#{pane_id}').trim() === pane) sandbox.tmux('kill-pane', '-t', pane);
    },
  };
  return helpers;
}

/** Native one-time prompts seen in any of the app's panes. Only observed: the app
 * must get past them itself (it starts sessions with auto mode as the default and
 * declines "Make auto mode your default permission mode?" should it still appear). */
export function observeNativeNudges(sandbox, seen) {
  for (const pane of sandbox.panes()) {
    const screen = sandbox.capture(pane);
    if (/Make auto mode your default permission mode\?/.test(screen)) seen.add('auto-mode-default-nudge');
    if (/Auto mode is now Claude Code's default permission mode/.test(screen)) seen.add('auto-mode-default-notice');
    // Auto mode's server check not passed through (expected only in the server-check scenario's folder).
    if (/We're changing auto mode to no longer charge for classifier requests/.test(screen)) seen.add('auto-mode-billing-notice');
    if (/^ {1,4}Auto mode can't check actions in this session$/m.test(screen)) seen.add('auto-mode-unavailable');
  }
}
