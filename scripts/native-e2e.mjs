// Explicit opt-in integration test: launches the installed, logged-in Claude TUI
// and sends one small everyday conversation. Never part of `npm test`.
import assert from 'node:assert/strict';
import { _electron } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { selectNativeScenario, validateNativeAnswer } from './native-dialogue.mjs';

const exec = promisify(execFile);
const root = path.resolve('test-results', `native-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const workspace = path.join(root, 'workspace');
await mkdir(workspace, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), 'Temporary workspace for one Lectern native TUI diagnostic check. No tools or file changes are required.\n');
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: path.join(root, 'profile'), LECTERN_LOG_DIR: path.join(root, 'diagnostics'), LECTERN_DIAGNOSTIC_CONTENT: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const scenario = selectNativeScenario('native');
const report = { workspace, logs: env.LECTERN_LOG_DIR, success: false, version: (await exec('claude', ['--version'])).stdout.trim(), messagesSent: 0,
  scenario: { id: scenario.id, title: scenario.title }, prompt: scenario.prompt };
const errors = [];
let app, page, sessionId, paneId;
try {
  app = await _electron.launch({ args: ['.'], env, timeout: 60000 });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(String(error)));
  page.setDefaultTimeout(20000);
  await page.waitForFunction(() => !!window.desktop);
  await page.evaluate(async cwd => {
    await window.desktop.saveWorkspace({ id: 'native-diagnostics', name: '本机 Claude · 诊断测试', kind: 'local', cwd });
  }, workspace);
  await page.reload();
  await page.getByRole('button', { name: /^新建对话/ }).first().waitFor();
  await page.evaluate(() => {
    window.__nativeSnapshots = [];
    window.desktop.onSnapshot(snapshot => {
      window.__nativeSnapshot = snapshot;
      window.__nativeSnapshots.push(snapshot);
      if (window.__nativeSnapshots.length > 500) window.__nativeSnapshots.shift();
    });
  });
  await page.getByRole('button', { name: /^新建对话/ }).first().click();
  await page.waitForFunction(() => !!window.__nativeSnapshot?.paneId);
  sessionId = await page.evaluate(() => window.__nativeSnapshot.sessionId);
  paneId = await page.evaluate(() => window.__nativeSnapshot.paneId);
  report.sessionId = sessionId;
  let trustConfirmed = false, securityNotesAccepted = false, themeAccepted = false, ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const snapshot = await page.evaluate(() => window.__nativeSnapshot);
    const screen = snapshot?.screen || '';
    // This test owns the empty directory it trusts. No other permission dialog
    // is ever accepted automatically.
    if (!themeAccepted && /Choose the text style that looks best with your terminal/i.test(screen) && /Auto \(match terminal\)/.test(screen)) {
      await page.evaluate(async id => window.desktop.sendKey('native-diagnostics', id, 'Enter'), sessionId);
      themeAccepted = true;
      report.themeAccepted = true;
    } else if (!securityNotesAccepted && /Security notes:/i.test(screen) && /Press Enter to continue/i.test(screen)) {
      await page.evaluate(async id => window.desktop.sendKey('native-diagnostics', id, 'Enter'), sessionId);
      securityNotesAccepted = true;
      report.securityNotesAccepted = true;
    } else if (!trustConfirmed && /(?:trust this folder|trust the files|project you created|trust this directory)/i.test(screen)
      && /(?:1\.\s*(?:Yes|I trust)|Yes, I trust this folder)/i.test(screen) && screen.includes(workspace)) {
      const direction = /❯\s*No, exit/.test(screen) ? 'Down' : 'Up';
      await page.evaluate(async ({ sessionId, direction }) => {
        await window.desktop.sendKey('native-diagnostics', sessionId, direction);
        await window.desktop.sendKey('native-diagnostics', sessionId, 'Enter');
      }, { sessionId, direction });
      trustConfirmed = true;
      report.trustConfirmed = true;
    } else if (snapshot?.status === 'idle' && /^\s*❯\s*(?:Try ["“].*)?\s*$/mu.test(screen)
      && !/(?:sign in|log in|select login|trust this folder|project you created|Choose the text style|Security notes:|Press Enter to continue)/i.test(screen)) {
      ready = true; break;
    }
    await page.waitForTimeout(500);
  }
  if (!ready) {
    const screen = await page.evaluate(() => window.__nativeSnapshot?.screen || '');
    await writeFile(path.join(root, 'startup-screen.txt'), screen);
    throw new Error('Claude TUI did not reach a ready input prompt; inspect startup-screen.txt and diagnostic captures. No login or non-directory permission was accepted.');
  }
  const prompt = scenario.prompt;
  await page.getByRole('textbox', { name: '发送给 Claude 的消息' }).fill(prompt);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  report.messagesSent = 1;
  await page.waitForFunction(() => {
    const snapshot = window.__nativeSnapshot;
    if (!snapshot) return false;
    if (snapshot.status === 'error' || snapshot.status === 'offline' || snapshot.messages.some(message => message.tools?.length)) return true;
    return snapshot.status === 'idle' && snapshot.messages.some(message =>
      message.role === 'assistant' && message.source === 'jsonl' && message.status === 'complete' && message.text.trim());
  }, undefined, { timeout: 180000 });
  const snapshots = await page.evaluate(() => window.__nativeSnapshots);
  const final = snapshots.at(-1);
  const answers = final.messages.filter(message => message.role === 'assistant');
  assert.equal(answers.length, 1, 'A single prompt must not produce duplicate assistant bubbles');
  const users = final.messages.filter(message => message.role === 'user');
  assert.equal(users.length, 1);
  assert.equal(users[0].text, prompt);
  report.answer = answers[0].text;
  report.validation = validateNativeAnswer(scenario, answers[0], final);
  const previews = snapshots.flatMap(snapshot => snapshot.messages).filter(message => message.role === 'assistant' && message.source === 'preview');
  for (const preview of previews) assert.equal(preview.id, answers[0].id);
  report.bubbleId = answers[0].id;
  report.previewObserved = previews.some(message => message.text.trim());
  report.incidentId = await page.evaluate(() => window.desktop.markDiagnosticIncident('真实 Claude 单轮测试已完成，检查 JSONL 与终端预览合并'));
  report.diagnostics = await page.evaluate(() => window.desktop.diagnosticsInfo());
  assert.equal(report.diagnostics.droppedEvents, 0);
  assert.equal(report.diagnostics.lastError, undefined);
  assert.deepEqual(errors, [], 'Renderer must not report runtime errors');
  await page.screenshot({ path: path.join(root, 'native-desktop.png') });
  report.success = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.error = String(error?.stack || error);
  if (page) {
    report.incidentId = await page.evaluate(note => window.desktop.markDiagnosticIncident(note), `真实 Claude 测试失败：${String(error).slice(0, 1500)}`).catch(() => undefined);
    await page.screenshot({ path: path.join(root, 'native-failure.png') }).catch(() => {});
    const screen = await page.evaluate(() => window.__nativeSnapshot?.screen || '').catch(() => '');
    await writeFile(path.join(root, 'failure-screen.txt'), screen);
  }
  console.error(JSON.stringify({ report: path.join(root, 'report.json'), error: String(error) }));
  process.exitCode = 1;
} finally {
  // Gracefully request exit only in this test-created session. If interrupted,
  // the regular app's policy remains to preserve user tmux sessions.
  if (page && sessionId) {
    await page.evaluate(async id => {
      await window.desktop.sendKey('native-diagnostics', id, 'C-c').catch(() => {});
    }, sessionId).catch(() => {});
  }
  if (paneId && sessionId) {
    const identity = await exec('tmux', ['display-message', '-p', '-t', paneId, '#{session_name}|#{@lectern_session_id}']).catch(() => undefined);
    if (identity) {
      const [name, bound] = identity.stdout.trim().split('|');
      if (bound === sessionId && name.startsWith(`lectern-${sessionId.slice(0, 8)}-`)) {
        await exec('tmux', ['kill-session', '-t', name]).catch(() => {});
      }
    }
  }
  await app?.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Native diagnostic artifacts: ${root}`);
}
