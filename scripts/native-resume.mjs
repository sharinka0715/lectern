// Reopen a successful test-created real Claude conversation. No new model input.
import assert from 'node:assert/strict';
import { _electron } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';

const sourcePath = path.resolve(process.argv[2] || '');
const results = path.resolve('test-results');
if (!sourcePath.startsWith(results + '/native-') || !sourcePath.endsWith('/report.json')) throw new Error('Pass the report.json of an earlier successful test:native run.');
const source = JSON.parse(await readFile(sourcePath, 'utf8'));
assert.equal(source.success, true);
assert.equal(source.workspace, path.join(path.dirname(sourcePath), 'workspace'));
assert.match(source.sessionId, /^[a-f0-9-]{36}$/);
const root = path.join(results, `native-resume-${Date.now()}`);
await mkdir(root, { recursive: true });
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: path.join(root, 'profile'), LECTERN_LOG_DIR: path.join(root, 'diagnostics'), LECTERN_DIAGNOSTIC_CONTENT: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.LECTERN_DEV_URL;
const exec = promisify(execFile);
const report = { sourceReport: sourcePath, sessionId: source.sessionId, workspace: source.workspace, newMessagesSent: 0, success: false };
let app, page, paneId;
try {
  app = await _electron.launch({ args: ['.'], env });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await page.waitForFunction(() => !!window.desktop);
  await page.evaluate(() => window.desktop.onSnapshot(snapshot => { window.__resumeSnapshot = snapshot; }));
  await page.getByRole('button', { name: '发现本机会话', exact: true }).first().click();
  await page.waitForFunction(cwd => [...document.querySelectorAll('.history-project-row')].some(row => row.getAttribute('data-cwd') === cwd), source.workspace);
  const candidates = page.locator('.history-project-row input[type="checkbox"]:enabled');
  for (let i = 0; i < await candidates.count(); i++) await candidates.nth(i).uncheck();
  await page.getByRole('checkbox', { name: `选择 ${source.workspace}`, exact: true }).check();
  await page.getByRole('button', { name: '添加所选历史目录', exact: true }).click();
  await page.waitForFunction(id => window.__resumeSnapshot?.sessionId === id && window.__resumeSnapshot.messages.some(m => m.role === 'assistant' && m.source === 'jsonl'), source.sessionId);
  const before = await page.evaluate(() => window.__resumeSnapshot);
  assert.equal(before.paneId, undefined, 'Only resume an inactive test-owned session');
  const originalAnswer = before.messages.find(message => message.role === 'assistant');
  assert.equal(originalAnswer.text, source.answer);
  assert.equal(originalAnswer.id, source.bubbleId);
  const originalUsers = before.messages.filter(message => message.role === 'user').length;
  const workspaceId = before.workspaceId;
  const history = await page.evaluate(id => window.desktop.discover(id), workspaceId);
  const transcript = history.sessions.find(session => session.id === source.sessionId).path;
  const beforeHash = createHash('sha256').update(await readFile(transcript)).digest('hex');
  await page.waitForTimeout(300);
  assert.equal(createHash('sha256').update(await readFile(transcript)).digest('hex'), beforeHash, 'Viewing must not alter source JSONL');
  await page.getByRole('button', { name: '续接会话', exact: true }).click();
  await page.waitForFunction(() => !!window.__resumeSnapshot?.paneId);
  paneId = await page.evaluate(() => window.__resumeSnapshot.paneId);
  await page.waitForFunction(() => window.__resumeSnapshot?.status === 'idle' && /^\s*❯\s*(?:Try ["“].*)?\s*$/mu.test(window.__resumeSnapshot.screen), undefined, { timeout: 45000 });
  const after = await page.evaluate(() => window.__resumeSnapshot);
  assert.equal(after.sessionId, source.sessionId);
  assert.equal(after.messages.filter(message => message.role === 'user').length, originalUsers);
  assert.equal(after.messages.filter(message => message.role === 'assistant').length, 1);
  assert.equal(after.messages.find(message => message.role === 'assistant').text, originalAnswer.text);
  assert.equal(after.messages.find(message => message.role === 'assistant').id, originalAnswer.id);
  report.originalHistoryPreserved = true;
  report.bubbleId = originalAnswer.id;
  report.paneId = paneId;
  report.incidentId = await page.evaluate(() => window.desktop.markDiagnosticIncident('真实旧会话导入和原 UUID 续接通过；未发送新消息'));
  await page.screenshot({ path: path.join(root, 'resumed-history.png') });
  report.success = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.error = String(error?.stack || error);
  if (page) {
    await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
    await writeFile(path.join(root, 'failure-screen.txt'), await page.evaluate(() => window.__resumeSnapshot?.screen || '').catch(() => ''));
  }
  process.exitCode = 1;
  console.error(String(error));
} finally {
  if (paneId) {
    const identity = await exec('tmux', ['display-message', '-p', '-t', paneId, '#{session_name}|#{@lectern_session_id}']).catch(() => undefined);
    if (identity) {
      const [name, id] = identity.stdout.trim().split('|');
      if (id === source.sessionId && name.startsWith(`lectern-${id.slice(0, 8)}-`)) await exec('tmux', ['kill-session', '-t', name]).catch(() => {});
    }
  }
  await app?.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Native resume artifacts: ${root}`);
}
