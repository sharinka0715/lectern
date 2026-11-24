// Explicit opt-in: operates the installed Claude Code TUI and sends one everyday dialogue.
// All choices come from the actual slash menus. Never reads auth/config credentials.
import assert from 'node:assert/strict';
import { _electron } from './fixtures/electron.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { selectNativeScenario, validateNativeAnswer } from './native-dialogue.mjs';
import { startConversation } from './fixtures/sidebar-folders.mjs';
const exec = promisify(execFile);
const root = path.resolve('test-results', `native-settings-${Date.now()}`);
const cwd = path.join(root, 'workspace');
await mkdir(cwd, { recursive: true });
await writeFile(path.join(cwd, 'README.md'), 'Empty workspace for native TUI model and effort selection verification.\n');
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: path.join(root, 'profile'), LECTERN_LOG_DIR: path.join(root, 'diagnostics'), LECTERN_DIAGNOSTIC_CONTENT: '1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL;
const scenario = selectNativeScenario('settings');
const report = { success: false, cwd, logs: env.LECTERN_LOG_DIR, version: (await exec('claude', ['--version'])).stdout.trim(), requests: 0,
  scenario: { id: scenario.id, title: scenario.title }, prompt: scenario.prompt };
let app, page, sid, paneId, originalModel, originalEffort;
const workspaceId = 'native-settings';
async function read(kind) {
  return page.evaluate(({ workspaceId, sid, kind }) => window.desktop.getSessionSetting(workspaceId, sid, kind), { workspaceId, sid, kind });
}
async function restore(kind, original) {
  if (!original) return;
  const fresh = await read(kind);
  const target = fresh.options.find(option => option.label === original.label);
  assert.ok(target, `Original ${kind} is still offered by native menu`);
  if (target.id !== fresh.currentOptionId) await page.evaluate(({ workspaceId, sid, token, id }) => window.desktop.setSessionSetting(workspaceId, sid, token, id), { workspaceId, sid, token: fresh.token, id: target.id });
  const verified = await read(kind);
  assert.equal(verified.options.find(option => option.id === verified.currentOptionId)?.label, original.label);
  report[`${kind}Restored`] = true;
}
async function chooseInUI(kind, target) {
  await page.locator(`button[data-setting-kind="${kind}"]`).click();
  const menu = page.locator(`[data-setting-menu="${kind}"]`);
  await menu.locator('button[data-option-id]').first().waitFor({ timeout: 120000 });
  await menu.getByRole('option').filter({ has: page.getByText(target.label, { exact: true }) }).click();
  await menu.waitFor({ state: 'hidden', timeout: 120000 });
  assert.ok((await page.locator(`button[data-setting-kind="${kind}"]`).innerText()).includes(target.label));
}
try {
  app = await _electron.launch({ args: ['.'], env, timeout: 60000 });
  page = await app.firstWindow(); page.setDefaultTimeout(30000);
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  await page.waitForFunction(() => !!window.desktop);
  await page.evaluate(cwd => window.desktop.saveWorkspace({ id: 'native-settings', name: '本机 Claude · 模型测试', kind: 'local', cwd }), cwd);
  await page.reload();
  await page.evaluate(() => {
    window.__snapshots = [];
    window.desktop.onSnapshot(value => { window.__snapshot = value; window.__snapshots.push(value); });
  });
  // 新建对话 only opens a draft whose first message starts Claude Code (a real request);
  // start the pane without a message and open it from the sidebar, as the old button did.
  await startConversation(page, workspaceId);
  await page.waitForFunction(() => !!window.__snapshot?.paneId);
  ({ sessionId: sid, paneId } = await page.evaluate(() => window.__snapshot));
  report.sessionId = sid; report.paneId = paneId;
  for (let i = 0; i < 60; i++) {
    const snapshot = await page.evaluate(() => window.__snapshot);
    const screen = snapshot.viewport || snapshot.screen;
    if (/(?:trust this folder|trust the files|project you created|trust this directory)/i.test(screen) && screen.includes(cwd) && /Yes, I trust this folder/.test(screen)) {
      await page.evaluate(async ({ workspaceId, sid, direction }) => {
        await window.desktop.sendKey(workspaceId, sid, direction);
        await window.desktop.sendKey(workspaceId, sid, 'Enter');
      }, { workspaceId, sid, direction: /❯\s*No, exit/.test(screen) ? 'Down' : 'Up' });
    } else if (snapshot.status === 'idle' && /^\s*❯\s*(?:Try ["“].*)?\s*$/mu.test(screen)) break;
    await page.waitForTimeout(500);
  }
  await page.waitForFunction(() => window.__snapshot?.status === 'idle' && !window.__snapshot.settingBusy
    && (window.__snapshot.statusLineManaged || ['ready', 'failed'].includes(window.__snapshot.settings?.initialization)), undefined, { timeout: 120000 });
  report.initialModel = await read('model');
  report.initialEffort = await read('effort');
  originalModel = report.initialModel.options.find(option => option.id === report.initialModel.currentOptionId);
  originalEffort = report.initialEffort.options.find(option => option.id === report.initialEffort.currentOptionId);
  // A session-only alias can be ambiguous in statusLine. This process owns
  // a new disposable conversation. Only restore selections with evidence.
  assert.ok(report.initialModel.complete && report.initialEffort.complete);
  // Optional test-only choice must still be present in the just-observed TUI;
  // useful when a user's provider advertises aliases it cannot actually serve.
  const targetModel = process.env.LECTERN_TEST_MODEL_LABEL
    ? report.initialModel.options.find(option => option.label === process.env.LECTERN_TEST_MODEL_LABEL && option.id !== originalModel?.id)
    : report.initialModel.options.find(option => option.id !== originalModel?.id && /sonnet|haiku/i.test(option.label) && !option.disabled);
  assert.ok(targetModel, 'Native account must offer a second model for this opt-in switching test');
  await chooseInUI('model', targetModel);
  report.selectedModel = await read('model');
  assert.equal(report.selectedModel.options.find(option => option.id === report.selectedModel.currentOptionId)?.label, targetModel.label);
  const effortForModel = await read('effort');
  const targetEffort = effortForModel.options.find(option => option.id !== effortForModel.currentOptionId);
  assert.ok(targetEffort, 'Native model must offer a second effort level for this test');
  await chooseInUI('effort', targetEffort);
  report.selectedEffort = await read('effort');
  assert.equal(report.selectedEffort.options.find(option => option.id === report.selectedEffort.currentOptionId)?.label, targetEffort.label);
  await page.waitForFunction(() => !window.__snapshot.settingBusy && window.__snapshot.status === 'idle');
  assert.equal((await page.evaluate(() => window.__snapshot.messages)).length, 0, 'Local settings commands never invent chat turns');
  const input = page.getByRole('textbox', { name: '发送给 Claude 的消息' });
  await input.fill(scenario.prompt);
  await page.getByRole('button', { name: '发送消息', exact: true }).click(); report.requests++;
  await page.waitForFunction(() => {
    const snapshot = window.__snapshot;
    if (!snapshot) return false;
    if (snapshot.status === 'error' || snapshot.status === 'offline' || snapshot.messages.some(message => message.tools?.length)) return true;
    return snapshot.status === 'idle' && snapshot.messages.some(message => message.role === 'assistant'
      && message.source === 'jsonl' && message.status === 'complete' && message.text.trim());
  }, undefined, { timeout: 180000 });
  const snapshots = await page.evaluate(() => window.__snapshots);
  const final = snapshots.at(-1);
  assert.equal(final.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(final.messages.find(message => message.role === 'user').text, scenario.prompt);
  assert.equal(final.messages.filter(message => message.role === 'assistant').length, 1);
  const answer = final.messages.find(message => message.role === 'assistant');
  report.answer = answer;
  report.validation = validateNativeAnswer(scenario, answer, final);
  const previews = snapshots.flatMap(snapshot => snapshot.messages).filter(message => message.role === 'assistant' && message.source === 'preview');
  for (const preview of previews) assert.equal(preview.id, answer.id);
  report.bubbleId = answer.id; report.previewObserved = previews.some(message => message.text.trim());
  await page.getByTitle('查看终端原屏').click();
  await page.screenshot({ path: path.join(root, 'native-settings-complete.png') });
  await restore('model', originalModel); await restore('effort', originalEffort);
  report.diagnostics = await page.evaluate(() => window.desktop.diagnosticsInfo());
  assert.equal(report.diagnostics.droppedEvents, 0); assert.equal(report.diagnostics.lastError, undefined);
  assert.deepEqual(errors, []);
  report.success = true;
} catch (error) {
  report.error = String(error?.stack || error); process.exitCode = 1;
  if (page) {
    await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
    await writeFile(path.join(root, 'failure-screen.txt'), await page.evaluate(() => window.__snapshot?.viewport || window.__snapshot?.screen || '').catch(() => ''));
    report.incidentId = await page.evaluate(note => window.desktop.markDiagnosticIncident(note), report.error.slice(0, 1800)).catch(() => undefined);
    await restore('model', originalModel).catch(error => { report.modelRestoreError = String(error); });
    await restore('effort', originalEffort).catch(error => { report.effortRestoreError = String(error); });
  }
} finally {
  if (sid && paneId) {
    const identity = await exec('tmux', ['display-message', '-p', '-t', paneId, '#{session_name}|#{@lectern_session_id}']).catch(() => undefined);
    const [name, bound] = identity?.stdout.trim().split('|') || [];
    if (bound === sid && name.startsWith(`lectern-${sid.slice(0, 8)}-`)) await exec('tmux', ['kill-session', '-t', name]).catch(() => {});
  }
  await app?.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: path.join(root, 'report.json'), success: report.success, requests: report.requests, error: report.error }, null, 2));
}
