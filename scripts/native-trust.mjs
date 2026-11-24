// Explicit opt-in native GUI test. Home trust is observed and rejected only.
// Only this script's newly created empty temporary workspace is trusted.
import assert from 'node:assert/strict';
import { _electron } from './fixtures/electron.mjs';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { selectNativeScenario, validateNativeAnswer } from './native-dialogue.mjs';
import { startConversation } from './fixtures/sidebar-folders.mjs';
const exec = promisify(execFile);
const root = path.resolve('test-results', `native-trust-${Date.now()}`);
await mkdir(root, { recursive: true });
const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'lectern-native-trust-')));
await writeFile(path.join(cwd, 'README.md'), 'Empty, test-owned workspace for directory trust and everyday conversation checks.\n');
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: path.join(root, 'profile'), LECTERN_LOG_DIR: path.join(root, 'diagnostics'), LECTERN_DIAGNOSTIC_CONTENT: '1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL;
const report = { success: false, cwd, root, version: (await exec('claude', ['--version'])).stdout.trim(), home: {}, temporary: {}, turns: [], requests: 0 };
const dialogueTurns = Number(process.env.LECTERN_TRUST_DIALOGUE_TURNS ?? 3);
assert.ok(Number.isInteger(dialogueTurns) && dialogueTurns >= 0 && dialogueTurns <= 3, 'LECTERN_TRUST_DIALOGUE_TURNS must be 0–3');
report.requestedDialogueTurns = dialogueTurns;
const owned = [];
let app, page;
async function newSession(workspaceId) {
  // 新建对话 only opens a draft whose first message starts Claude Code (a real request);
  // start the pane without a message and open it from the sidebar, as the old button did.
  const started = await startConversation(page, workspaceId);
  await page.waitForFunction(({ id, sid }) => window.__snapshot?.workspaceId === id && window.__snapshot.sessionId === sid && !!window.__snapshot.paneId, { id: workspaceId, sid: started.id });
  const snapshot = await page.evaluate(() => window.__snapshot);
  owned.push({ workspaceId, sessionId: snapshot.sessionId, paneId: snapshot.paneId });
  return snapshot;
}
async function trustCard(workspaceId) {
  await page.waitForFunction(id => window.__snapshot?.workspaceId === id && window.__snapshot.directoryTrust && window.__snapshot.status === 'waiting', workspaceId);
  const card = page.locator('section[aria-label="目录信任确认"]'); await card.waitFor();
  assert.equal(await page.getByRole('textbox', { name: '发送给 Claude 的消息' }).isDisabled(), true);
  // The model list can be browsed at any time (it is the machine's list, not read from the pane),
  // but no choice can be applied while the trust prompt holds the native input.
  const picker = page.locator('button[data-setting-kind="model"]'), menu = page.locator('[data-setting-menu="model"]');
  await picker.click();
  await menu.getByRole('option').first().waitFor();
  assert.equal(await menu.locator('button[role="option"]:not(:disabled)').count(), 0, 'No model can be chosen during the trust prompt');
  await picker.click();
  await menu.waitFor({ state: 'hidden' });
  return card;
}
async function paneAlive(paneId) {
  const result = await exec('tmux', ['display-message', '-p', '-t', paneId, '#{pane_id}']).catch(() => undefined);
  return result?.stdout.trim() === paneId; // tmux may exit 0 with empty output for a missing target.
}
async function waitExited(paneId) {
  for (let i = 0; i < 40; i++) { if (!(await paneAlive(paneId))) return; await page.waitForTimeout(100); }
  throw new Error('Test-owned native pane did not exit after explicit No');
}
try {
  app = await _electron.launch({ args: ['.'], env, timeout: 60000 });
  page = await app.firstWindow(); page.setDefaultTimeout(30000);
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  await page.waitForFunction(() => !!window.desktop);
  await page.evaluate(async ({ cwd, home }) => {
    await window.desktop.saveWorkspace({ id: 'trust-scratch', name: '临时目录·信任测试', kind: 'local', cwd });
    await window.desktop.saveWorkspace({ id: 'trust-home', name: '主目录·提示检查', kind: 'local', cwd: home });
  }, { cwd, home: homedir() });
  await page.reload();
  await page.evaluate(() => {
    window.__snapshots = [];
    window.desktop.onSnapshot(value => { window.__snapshot = value; window.__snapshots.push(value); });
  });
  const home = await newSession('trust-home');
  const homeCard = await trustCard('trust-home');
  const initialHome = await page.evaluate(() => window.__snapshot);
  assert.equal(initialHome.directoryTrust.cwd, homedir());
  assert.equal(initialHome.directoryTrust.scope, 'session');
  assert.match(initialHome.viewport, /❯\s*No, exit/);
  const firstToken = initialHome.directoryTrust.token;
  await page.waitForTimeout(1300);
  assert.equal((await page.evaluate(() => window.__snapshot.directoryTrust)).token, firstToken, 'Read-only polling must neither act nor churn the confirmation token');
  await homeCard.getByRole('button', { name: '查看原生提示', exact: true }).click();
  await page.screenshot({ path: path.join(root, 'home-trust-readonly.png') });
  await writeFile(path.join(root, 'home-screen.txt'), initialHome.viewport);
  await homeCard.locator('button[data-trust-decision="exit"]').click();
  await waitExited(home.paneId);
  await page.locator('section[aria-label="目录信任确认"]').waitFor({ state: 'hidden' });
  report.home = { cwd: homedir(), sessionId: home.sessionId, scope: 'session', defaultChoice: 'No, exit', action: 'exit', trusted: false };
  // Reopening home must still ask: the test has never accepted broad home trust.
  const homeAgain = await newSession('trust-home');
  await trustCard('trust-home');
  await page.locator('button[data-trust-decision="exit"]').click();
  await waitExited(homeAgain.paneId);
  report.home.promptedAgain = true;

  const rejected = await newSession('trust-scratch');
  const rejectedCard = await trustCard('trust-scratch');
  assert.equal(await rejectedCard.getAttribute('data-directory-trust-cwd'), cwd);
  await rejectedCard.locator('button[data-trust-decision="exit"]').click();
  await waitExited(rejected.paneId);
  const accepted = await newSession('trust-scratch');
  const acceptCard = await trustCard('trust-scratch');
  assert.equal(await acceptCard.getAttribute('data-directory-trust-cwd'), cwd, 'No did not persist trust');
  const before = await page.evaluate(() => window.__snapshot);
  assert.equal(before.messages.length, 0);
  await page.screenshot({ path: path.join(root, 'temporary-trust-confirmation.png') });
  await acceptCard.locator('button[data-trust-decision="trust"]').click();
  await page.waitForFunction(sid => window.__snapshot?.sessionId === sid && window.__snapshot.status === 'idle' && !window.__snapshot.directoryTrust && !window.__snapshot.trustBusy, accepted.sessionId);
  assert.equal((await page.evaluate(() => window.__snapshot.messages)).length, 0, 'Trust confirmation does not create user or assistant bubbles');
  report.temporary = { sessionId: accepted.sessionId, rejectedSessionId: rejected.sessionId, explicitTrust: true, ready: true };

  if (process.env.LECTERN_TEST_MODEL_LABEL) {
    const menu = await page.evaluate(sid => window.desktop.getSessionSetting('trust-scratch', sid, 'model'), accepted.sessionId);
    const target = menu.options.find(option => option.label === process.env.LECTERN_TEST_MODEL_LABEL);
    assert.ok(target, 'Requested test model must exist in the actual native menu');
    if (!target.current) await page.evaluate(({ sid, token, id }) => window.desktop.setSessionSetting('trust-scratch', sid, token, id), { sid: accepted.sessionId, token: menu.token, id: target.id });
    report.model = target.label;
  }
  for (let turn = 0; turn < dialogueTurns; turn++) {
    const scenario = selectNativeScenario('trust', turn, '');
    const input = page.getByRole('textbox', { name: '发送给 Claude 的消息' });
    await input.fill(scenario.prompt);
    await page.getByRole('button', { name: '发送消息', exact: true }).click(); report.requests++;
    await page.waitForFunction(({ sid, turn }) => {
      const s = window.__snapshot;
      if (s?.sessionId !== sid) return false;
      if (['error', 'offline', 'waiting'].includes(s.status)) return true;
      const answers = s.messages.filter(message => message.role === 'assistant');
      return answers.length >= turn + 1 && answers.at(-1).source === 'jsonl' && answers.at(-1).status === 'complete' && s.status === 'idle';
    }, { sid: accepted.sessionId, turn }, { timeout: 180000 });
    const snapshots = await page.evaluate(sid => window.__snapshots.filter(s => s.sessionId === sid), accepted.sessionId);
    const final = snapshots.at(-1), answers = final.messages.filter(message => message.role === 'assistant');
    assert.equal(answers.length, turn + 1, 'Each real dialogue turn must retain exactly one assistant bubble');
    assert.equal(final.messages.filter(message => message.role === 'user').length, turn + 1);
    const answer = answers.at(-1), validation = validateNativeAnswer(scenario, answer, final);
    const previews = snapshots.flatMap(s => s.messages).filter(message => message.role === 'assistant' && message.source === 'preview' && message.id === answer.id);
    for (const previous of report.turns) assert.equal(answers.find(a => a.id === previous.answer.id)?.text, previous.answer.text, 'Earlier finalized replies remain intact');
    report.turns.push({ scenario, answer, validation, previewObserved: previews.length > 0 });
    await page.screenshot({ path: path.join(root, `dialogue-${turn + 1}.png`) });
  }
  assert.deepEqual(errors, []);
  report.diagnostics = await page.evaluate(() => window.desktop.diagnosticsInfo());
  assert.equal(report.diagnostics.droppedEvents, 0); assert.equal(report.diagnostics.lastError, undefined);
  report.success = true;
} catch (error) {
  report.error = String(error?.stack || error); process.exitCode = 1;
  if (page) {
    await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
    await writeFile(path.join(root, 'failure-screen.txt'), await page.evaluate(() => window.__snapshot?.viewport || window.__snapshot?.screen || '').catch(() => ''));
    report.incidentId = await page.evaluate(note => window.desktop.markDiagnosticIncident(note), report.error.slice(0, 1800)).catch(() => undefined);
  }
} finally {
  // A UI race may create a pane before its selection snapshot arrives. The
  // uniquely created empty workspace still identifies these as test-owned.
  if (page) {
    const leftovers = await page.evaluate(() => window.desktop.discover('trust-scratch')).catch(() => undefined);
    for (const pane of leftovers?.panes || []) if (pane.cwd === cwd && pane.managed && pane.sessionId
      && !owned.some(session => session.sessionId === pane.sessionId)) {
      owned.push({ workspaceId: 'trust-scratch', sessionId: pane.sessionId, paneId: pane.id });
    }
  }
  for (const session of owned) {
    const identity = await exec('tmux', ['display-message', '-p', '-t', session.paneId, '#{session_name}|#{@lectern_session_id}']).catch(() => undefined);
    const [name, bound] = identity?.stdout.trim().split('|') || [];
    if (bound === session.sessionId && name.startsWith(`lectern-${bound.slice(0, 8)}-`)) await exec('tmux', ['kill-session', '-t', name]).catch(() => {});
  }
  await app?.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: path.join(root, 'report.json'), success: report.success, requests: report.requests, error: report.error }, null, 2));
}
