// Quitting while conversations still run (src/main/quit-guard.ts, src/renderer/QuitDialog.tsx).
// Demo mode, mock Claude in a private tmux server, no SSH host and no model request; the
// demo keeps its tmux server after quitting (LECTERN_DEMO_KEEP_TMUX=1) so the test can see
// what was left running, then kills it. Each scenario starts the app again:
//   A  the dialog lists exactly the running panes, by machine, with status; repeated quits do
//      not stack dialogs; Esc cancels; closing the window asks again; "only quit" leaves panes
//   B  English, from the menu's Quit; "remember" makes the next quit silent (C) and shows in
//      Settings → Session, where it is switched back (D)
//   D  "close all": progress, then every Lectern pane is gone, the user's own tmux session stays
//   E  failed closes are listed; Cancel keeps the app, "Quit Anyway" quits and leaves them
//   F  a folder check slower than the deadline does not hold the dialog up; nothing running: no dialog
//   G  without a window (macOS) a window opens for the dialog; SIGTERM quits without asking
//   H  automated runs without LECTERN_QUIT_PROMPT quit as before
// Screenshots: test-results/quit-dialog-{zh,en,closing,failed,many}.png
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, copyFile, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { _electron } from 'playwright';
import { refreshFolderUntil } from './fixtures/sidebar-refresh.mjs';

// tmux only ever runs against the private server directory test-all (or the caller) set up.
if (!process.env.TMUX_TMPDIR) {
  console.error('TMUX_TMPDIR must point at a private tmux directory; run through npm run test:all -- --only build,quit-dialog-e2e');
  process.exit(2);
}
const results = path.resolve('test-results');
await mkdir(results, { recursive: true });
const exe = process.argv[2];
const sshHost = '192.0.2.1';
const tmuxEnv = { ...process.env };
delete tmuxEnv.TMUX; delete tmuxEnv.TMUX_PANE;
const tmux = (socket, ...args) => promisify(execFile)('tmux', ['-L', socket, ...args], { env: tmuxEnv });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanups = [];

/** Lectern's panes in the demo's private tmux server (sessions named lectern-…). */
async function lecternPanes(socket) {
  try {
    const { stdout } = await tmux(socket, 'list-panes', '-a', '-F', '#{session_name}\t#{pane_id}\t#{@lectern_session_id}\t#{pane_dead}');
    return stdout.trim().split('\n').filter(Boolean).map(line => line.split('\t'))
      .filter(([name, , , dead]) => name.startsWith('lectern-') && dead !== '1').map(([, pane, session]) => ({ pane, session }))
      .sort((a, b) => a.pane.localeCompare(b.pane));
  } catch (error) {
    if (/no server running|error connecting|No such file/.test(String(error.stderr ?? error.message))) return [];
    throw error;
  }
}
const tmuxSessions = async socket => (await tmux(socket, 'list-sessions', '-F', '#{session_name}').catch(() => ({ stdout: '' }))).stdout.trim().split('\n').filter(Boolean);

async function launch(name, { locale = 'zh-CN', userData, ssh = false, prompt = true } = {}) {
  const logs = await mkdtemp(path.join(tmpdir(), `lectern-quit-${name}-logs-`));
  const ownProfile = !userData;
  userData ??= await mkdtemp(path.join(tmpdir(), `lectern-quit-${name}-profile-`));
  const env = { ...process.env, LECTERN_LOCALE: locale, LECTERN_USER_DATA: userData, LECTERN_NODE_BINARY: process.execPath, LECTERN_LOG_DIR: logs,
    LECTERN_DIAGNOSTIC_CONTENT: '0', LECTERN_DEMO_KEEP_TMUX: '1', ...(prompt && { LECTERN_QUIT_PROMPT: '1' }), ...(ssh && { LECTERN_DEMO_SSH_HOST: sshHost }) };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'LECTERN_DEV_URL', 'TMUX', 'TMUX_PANE', ...(prompt ? [] : ['LECTERN_QUIT_PROMPT'])]) delete env[key];
  const app = await _electron.launch({ args: exe ? ['--demo'] : ['.', '--demo'], ...(exe && { executablePath: path.resolve(exe) }), env, timeout: 60_000 });
  const child = app.process(), socket = `lectern-demo-${child.pid}`;
  let gone = false;
  const exited = new Promise(resolve => child.once('exit', (code, signal) => { gone = true; resolve({ code, signal }); }));
  const run = { name, app, socket, logs, userData, exited, alive: () => !gone, errors: [] };
  cleanups.push(async () => {
    if (!gone) { child.kill('SIGKILL'); await exited; }
    await tmux(socket, 'kill-server').catch(() => {});
    if (run.demoDir) await rm(run.demoDir, { recursive: true, force: true });
    await rm(logs, { recursive: true, force: true });
    if (ownProfile) await rm(userData, { recursive: true, force: true });
  });
  const page = run.page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => run.errors.push(error.message));
  await page.locator('.message-assistant').first().waitFor();
  await page.waitForFunction(() => document.querySelector('.session-row.active')?.getAttribute('data-session-live') === 'true');
  const workspaces = await page.evaluate(() => window.desktop.listWorkspaces());
  run.workspace = workspaces.find(item => item.id === 'demo-local');
  run.demoDir = path.dirname(run.workspace.cwd);
  run.demoSession = await page.locator('.session-row.active').getAttribute('data-session-id');
  // Nothing answers at sshHost: once the SSH folder's read has failed, quitting lists that machine from
  // what it knows and does not ask it again (A, B); F covers a check that runs into the deadline.
  if (ssh) await page.locator('.workspace-row[data-workspace-id="demo-ssh"][data-status="error"]').waitFor({ state: 'attached', timeout: 30_000 });
  return run;
}

/** A new conversation in the demo folder, named through its own /rename, shown in the sidebar. */
async function addConversation(run, title) {
  const info = await run.page.evaluate(id => window.desktop.createSession(id), run.workspace.id);
  for (let n = 0; n < 100 && !(await tmux(run.socket, 'capture-pane', '-p', '-t', info.paneId)).stdout.includes('offline fixture'); n++) await pause(50);
  await tmux(run.socket, 'send-keys', '-t', info.paneId, '-l', `/rename ${title}`);
  await tmux(run.socket, 'send-keys', '-t', info.paneId, 'Enter');
  // Once the new title is on disk, read the folder now rather than on the sidebar's next 5-second read.
  const transcript = path.join(run.workspace.claudeDir, 'projects', run.workspace.cwd.replace(/[^a-zA-Z0-9-]/g, '-'), `${info.id}.jsonl`);
  for (let n = 0; n < 100 && !(await readFile(transcript, 'utf8').catch(() => '')).includes(JSON.stringify(title)); n++) await pause(50);
  await refreshFolderUntil(run.page, run.workspace.id, run.page.locator(`.session-row[data-session-id="${info.id}"]`, { hasText: title }));
  return info;
}

/** Two background shells and a monitor still running in the demo conversation (synthetic records). */
async function addBackgroundWork(run) {
  const file = path.join(run.workspace.claudeDir, 'projects', run.workspace.cwd.replace(/[^a-zA-Z0-9-]/g, '-'), `${run.demoSession}.jsonl`);
  let parent = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(row => row.uuid).at(-1)?.uuid ?? null;
  const at = new Date().toISOString(), sessionId = run.demoSession, cwd = run.workspace.cwd;
  const record = (type, fields) => { const uuid = randomUUID(), row = { type, uuid, parentUuid: parent, sessionId, cwd, timestamp: at, ...fields }; parent = uuid; return row; };
  const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const result = (id, toolUseResult, text) => record('user', { toolUseResult, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
  const rows = [
    record('user', { origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: 'Build and watch the logs in the background' } }),
    record('assistant', { message: { id: 'msg_quit_tasks', role: 'assistant', model: 'fixture', stop_reason: 'tool_use', content: [
      tool('toolu_q_build', 'Bash', { command: 'npm run build', description: 'build', run_in_background: true }),
      tool('toolu_q_test', 'Bash', { command: 'npm test -- --watch', description: 'tests', run_in_background: true }),
      tool('toolu_q_watch', 'Monitor', { command: 'tail -f server.log', description: 'server log', timeout_ms: 300000 })] } }),
    result('toolu_q_build', { stdout: '', stderr: '', backgroundTaskId: 'bqbuild01' }, 'Command running in background with ID: bqbuild01.'),
    result('toolu_q_test', { stdout: '', stderr: '', backgroundTaskId: 'bqtest001' }, 'Command running in background with ID: bqtest001.'),
    result('toolu_q_watch', { taskId: 'bqwatch01', timeoutMs: 300000, persistent: false }, 'Monitor started (task bqwatch01, expires in 5m).'),
    record('assistant', { message: { id: 'msg_quit_started', role: 'assistant', model: 'fixture', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Running in the background.' }] } }),
  ];
  await appendFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

/** A fresh profile with only the quit preference of `from` (its layout points at another demo). */
async function withQuitSettings(from) {
  const profile = await mkdtemp(path.join(tmpdir(), 'lectern-quit-profile-'));
  cleanups.push(() => rm(profile, { recursive: true, force: true }));
  await copyFile(path.join(from, 'quit-settings.json'), path.join(profile, 'quit-settings.json'));
  return profile;
}
const dialog = page => page.locator('dialog.quit-dialog[open]');
/** The footer's buttons share one line: every button overlaps every other vertically. */
const footerOnOneLine = page => dialog(page).locator('.modal-footer button').evaluateAll(buttons => {
  const boxes = buttons.map(button => button.getBoundingClientRect());
  return Math.max(...boxes.map(box => box.top)) < Math.min(...boxes.map(box => box.bottom));
});
/** A screenshot once the dialog's opening animation is over. */
async function snap(page, name) {
  await dialog(page).evaluate(element => Promise.all(element.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished)));
  await page.screenshot({ path: path.join(results, name) });
}
const quitFromMain = run => run.app.evaluate(({ app }) => { app.quit(); });
const closeWindow = run => run.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
// macOS keeps running without windows: closing the last one never asks (nor quits).
const closingQuits = process.platform !== 'darwin';
const quitFromMenu = run => run.app.evaluate(({ Menu }, mac) => {
  const find = items => { for (const item of items) { if (item.role === 'quit') return item; const inner = item.submenu && find(item.submenu.items); if (inner) return inner; } };
  const quit = find(Menu.getApplicationMenu().items);
  // macOS runs the Quit role natively (click() from script does nothing there): send its action.
  if (mac) Menu.sendActionToFirstResponder('terminate:'); else quit.click();
}, process.platform === 'darwin');
async function exitWithin(run, ms) {
  // The timer is cleared once the app exits: a pending one would keep this script alive for up to `ms`.
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${run.name}: the app did not exit within ${ms} ms`)), ms); });
  try { return await Promise.race([run.exited, late]); } finally { clearTimeout(timer); }
}
/** Rows of the dialog: session, pane, activity, close state. */
const rows = page => dialog(page).locator('.quit-session').evaluateAll(items => items.map(item => ({
  session: item.dataset.sessionId, pane: item.dataset.paneId, activity: item.dataset.activity, background: item.dataset.background === 'true',
  close: item.dataset.close, unconfirmed: item.dataset.unconfirmed === 'true', text: item.innerText })));
async function events(run) {
  const files = (await readdir(run.logs)).filter(file => /^events\.\d+\.jsonl$/.test(file));
  return (await Promise.all(files.map(file => readFile(path.join(run.logs, file), 'utf8'))))
    .flatMap(content => content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))).sort((a, b) => a.seq - b.seq);
}
const proceededBecause = async run => (await events(run)).filter(record => record.event === 'app.quit_proceed').map(record => record.data.why);
/** The dialog lists exactly the panes running in the private tmux server. */
async function assertListsRunning(run) {
  const [listed, panes] = [await rows(run.page), await lecternPanes(run.socket)];
  assert.deepEqual(listed.map(row => [row.pane, row.session]).sort(), panes.map(pane => [pane.pane, pane.session]).sort(),
    `${run.name}: one row per running pane, the same conversation`);
  return listed;
}

try {
  // ── A: the list, repeated quits, Esc, the window's close button, "only quit" ──
  {
    const run = await launch('a', { ssh: true });
    const fix = await addConversation(run, '修复登录页样式'), notes = await addConversation(run, '整理发布说明');
    await addBackgroundWork(run);
    await tmux(run.socket, 'send-keys', '-t', fix.paneId, '-l', '把登录页的按钮改成圆角并补上暗色样式。' + '请逐项说明改动。'.repeat(60));
    await tmux(run.socket, 'send-keys', '-t', fix.paneId, 'Enter');
    for (let n = 0; n < 60 && !(await tmux(run.socket, 'capture-pane', '-p', '-t', fix.paneId)).stdout.includes('esc to interrupt'); n++) await pause(50);
    await run.page.locator('.session-row.active .state-background').waitFor();
    const before = await lecternPanes(run.socket);
    assert.equal(before.length, 3);
    const asked = Date.now();
    await quitFromMain(run);
    await dialog(run.page).waitFor();
    const askedMs = Date.now() - asked;
    assert.ok(askedMs < 3000, `the SSH folder whose read failed is not asked again: no wait for the 3 s deadline (${askedMs} ms)`);
    const listed = await assertListsRunning(run);
    const by = id => listed.find(row => row.session === id);
    assert.equal(by(fix.id).activity, 'working', 'the replying conversation says so');
    assert.match(by(fix.id).text, /修复登录页样式[\s\S]*正在回复/);
    assert.match(by(notes.id).text, /整理发布说明[\s\S]*空闲/);
    assert.equal(by(run.demoSession).background, true);
    assert.match(by(run.demoSession).text, /后台：2 个终端、1 个监控/);
    assert.ok(listed.every(row => !row.unconfirmed));
    assert.deepEqual(await dialog(run.page).locator('.quit-machine-name').allInnerTexts(), ['本地'], 'grouped under the machine, named as in the sidebar');
    assert.deepEqual(await dialog(run.page).locator('.quit-machine-count').allInnerTexts(), ['3 个对话']);
    await dialog(run.page).locator(`.quit-unreachable li[data-machine*="${sshHost}"]`).waitFor();
    assert.match(await dialog(run.page).locator('.quit-unreachable').innerText(), new RegExp(`连不上[\\s\\S]*${sshHost.replace(/\./g, '\\.')}[\\s\\S]*远程项目`));
    assert.equal(await dialog(run.page).locator('h2').innerText(), '3 个对话仍在运行');
    // Cancel has the focus; the list scrolls inside a fixed height.
    assert.equal(await run.page.evaluate(() => document.activeElement?.textContent), '取消');
    const list = await dialog(run.page).locator('.quit-list').evaluate(element => ({ overflow: getComputedStyle(element).overflowY, max: getComputedStyle(element).maxHeight }));
    assert.equal(list.overflow, 'auto');
    assert.notEqual(list.max, 'none');
    await snap(run.page, 'quit-dialog-zh.png');
    assert.ok(await footerOnOneLine(run.page), 'the three choices fit on one line');
    // Quitting again, from the app or the window, only brings the same dialog forward.
    const shown = await dialog(run.page).innerText();
    await quitFromMain(run); if (closingQuits) await closeWindow(run); await quitFromMenu(run);
    await pause(400);
    assert.equal(await run.page.locator('dialog.quit-dialog').count(), 1);
    assert.equal(await dialog(run.page).innerText(), shown);
    assert.ok(run.alive());
    // Esc is Cancel: the app stays, every conversation still runs.
    await run.page.keyboard.press('Escape');
    await dialog(run.page).waitFor({ state: 'detached' });
    await pause(300);
    assert.ok(run.alive(), 'Cancel keeps Lectern');
    assert.equal(await run.page.evaluate(() => 1 + 1), 2);
    assert.deepEqual(await lecternPanes(run.socket), before);
    // Closing the last window (Windows, Linux; on macOS ⌘Q) asks the same; "only quit" leaves every pane running.
    await (closingQuits ? closeWindow(run) : quitFromMenu(run));
    await dialog(run.page).waitFor();
    await assertListsRunning(run);
    await dialog(run.page).getByRole('button', { name: /^只退出 Lectern/ }).click();
    await exitWithin(run, 20_000);
    assert.deepEqual(await lecternPanes(run.socket), before, '"only quit" leaves the conversations running in tmux');
    assert.deepEqual(await proceededBecause(run), ['leave']);
    const requests = (await events(run)).filter(record => record.event === 'app.quit_request').map(record => record.data.reason);
    assert.deepEqual(requests.slice(0, 4), closingQuits ? ['user', 'user', 'window', 'user'] : ['user', 'user', 'user', 'user']);
    assert.deepEqual(run.errors, []);
    console.log(`A: listed ${listed.length} running conversations in ${askedMs} ms; Esc cancelled; "only quit" left ${before.length} panes running`);
  }

  // ── B: English, menu Quit, "remember" ──
  const remembered = await mkdtemp(path.join(tmpdir(), 'lectern-quit-remembered-'));
  cleanups.push(() => rm(remembered, { recursive: true, force: true }));
  {
    const run = await launch('b', { locale: 'en', userData: remembered, ssh: true });
    await addConversation(run, 'Release notes');
    await addConversation(run, 'Flaky test on CI');
    const before = await lecternPanes(run.socket);
    await quitFromMenu(run);
    await dialog(run.page).waitFor();
    await assertListsRunning(run);
    assert.equal(await dialog(run.page).locator('h2').innerText(), '3 conversations are still running');
    for (const name of ['Cancel', 'Close All and Quit']) await dialog(run.page).getByRole('button', { name, exact: true }).waitFor();
    await dialog(run.page).getByRole('button', { name: /^Quit Lectern Only/ }).waitFor();
    await snap(run.page, 'quit-dialog-en.png');
    assert.ok(await footerOnOneLine(run.page), 'the three choices fit on one line in English too');
    await dialog(run.page).getByRole('checkbox', { name: /Remember "Quit Lectern Only"/ }).check();
    await dialog(run.page).getByRole('button', { name: /^Quit Lectern Only/ }).click();
    await exitWithin(run, 20_000);
    assert.deepEqual(await lecternPanes(run.socket), before);
    assert.deepEqual(JSON.parse(await readFile(path.join(remembered, 'quit-settings.json'), 'utf8')), { whenRunning: 'leave' });
    console.log('B: English dialog from the menu; "remember" saved');
  }

  // ── C: remembered: quits without asking; Settings shows the choice ──
  {
    const run = await launch('c', { userData: await withQuitSettings(remembered) });
    await run.page.getByRole('button', { name: '界面与连接设置' }).click();
    const settings = run.page.getByRole('dialog', { name: '设置', exact: true });
    await settings.getByRole('button', { name: '会话', exact: true }).click();
    const choice = settings.getByRole('combobox', { name: '退出时仍有对话在运行' });
    await run.page.waitForFunction(() => !document.querySelector('select[aria-label="退出时仍有对话在运行"]')?.disabled);
    assert.equal(await choice.inputValue(), 'leave');
    await run.page.keyboard.press('Escape');
    const before = await lecternPanes(run.socket);
    assert.equal(before.length, 1);
    await quitFromMain(run);
    await exitWithin(run, 20_000);
    assert.deepEqual(await proceededBecause(run), ['remembered']);
    assert.deepEqual(await lecternPanes(run.socket), before);
    console.log('C: remembered choice quits without the dialog');
  }

  // ── D: switch back to asking; "close all" closes every Lectern pane, the user's own session stays ──
  {
    const run = await launch('d', { userData: await withQuitSettings(remembered) });
    await run.page.getByRole('button', { name: '界面与连接设置' }).click();
    const settings = run.page.getByRole('dialog', { name: '设置', exact: true });
    await settings.getByRole('button', { name: '会话', exact: true }).click();
    await run.page.waitForFunction(() => !document.querySelector('select[aria-label="退出时仍有对话在运行"]')?.disabled);
    await settings.getByRole('combobox', { name: '退出时仍有对话在运行' }).selectOption('ask');
    await run.page.waitForFunction(async () => (await window.desktop.quitPreferences()).whenRunning === 'ask');
    await run.page.keyboard.press('Escape');
    await addConversation(run, '数据清洗');
    await tmux(run.socket, 'new-session', '-d', '-s', 'my-own-shell', 'sleep 600');
    assert.equal((await lecternPanes(run.socket)).length, 2);
    await run.app.evaluate(() => { process.env.LECTERN_DEMO_LATENCY_MS = '400'; });
    await quitFromMain(run);
    await dialog(run.page).waitFor();
    await assertListsRunning(run);
    await dialog(run.page).getByRole('button', { name: '关闭所有对话并退出', exact: true }).click();
    await run.page.locator('dialog.quit-dialog[data-phase="closing"] .quit-session[data-close="closing"]').first().waitFor();
    await snap(run.page, 'quit-dialog-closing.png');
    await exitWithin(run, 60_000);
    assert.deepEqual(await lecternPanes(run.socket), [], '"close all" leaves no Lectern pane');
    assert.deepEqual(await tmuxSessions(run.socket), ['my-own-shell'], 'tmux sessions the user opened are not Lectern conversations');
    assert.deepEqual(await proceededBecause(run), ['closed-all']);
    console.log('D: settings switched back to asking; "close all" closed 2 conversations and quit');
  }

  // ── E: failures are listed; Cancel stays, "Quit Anyway" quits ──
  {
    const run = await launch('e');
    await addConversation(run, '迁移数据库');
    const before = await lecternPanes(run.socket);
    await run.app.evaluate(() => { process.env.LECTERN_DEMO_FAIL_TAG = 'tmux.close_session'; });
    await (closingQuits ? closeWindow(run) : quitFromMain(run));
    await dialog(run.page).waitFor();
    await dialog(run.page).getByRole('button', { name: '关闭所有对话并退出', exact: true }).click();
    await run.page.locator('dialog.quit-dialog[data-phase="failed"]').waitFor({ timeout: 40_000 });
    assert.equal(await dialog(run.page).locator('h2').innerText(), '2 个对话没能关闭');
    const failed = await rows(run.page);
    assert.deepEqual(failed.map(row => row.close), ['failed', 'failed']);
    assert.ok(failed.every(row => /Rehearsed failure: tmux\.close_session/.test(row.text)));
    assert.equal(await run.page.evaluate(() => document.activeElement?.textContent), '取消');
    await snap(run.page, 'quit-dialog-failed.png');
    await dialog(run.page).getByRole('button', { name: '取消', exact: true }).click();
    await dialog(run.page).waitFor({ state: 'detached' });
    await pause(300);
    assert.ok(run.alive(), 'Cancel after failures keeps Lectern');
    assert.deepEqual(await lecternPanes(run.socket), before);
    await quitFromMain(run);
    await dialog(run.page).waitFor();
    await dialog(run.page).getByRole('button', { name: '关闭所有对话并退出', exact: true }).click();
    await run.page.locator('dialog.quit-dialog[data-phase="failed"]').waitFor({ timeout: 40_000 });
    await dialog(run.page).getByRole('button', { name: '仍然退出', exact: true }).click();
    await exitWithin(run, 20_000);
    assert.deepEqual(await lecternPanes(run.socket), before, 'what could not be closed keeps running');
    assert.deepEqual(await proceededBecause(run), ['quit-anyway']);
    console.log('E: failed closes listed; Cancel stayed; "Quit Anyway" quit and left them running');
  }

  // ── F: many conversations (layout only: a list pushed to the window); a check slower than
  //    the deadline; then nothing running: no dialog ──
  {
    const run = await launch('f');
    const machines = [{ kind: 'local' }, { kind: 'ssh', host: 'build.example.com' }, { kind: 'ssh', host: 'gpu.example.com', port: 2222 }];
    const many = Array.from({ length: 30 }, (_, i) => ({ workspaceId: `w${i % 3}`, sessionId: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
      title: i % 7 ? `任务 ${i + 1}：整理第 ${i + 1} 批实验结果并写出对比结论` : '', folder: ['web', 'trainer', 'eval'][i % 3], endpoint: machines[i % 3],
      paneId: `%${i + 1}`, activity: ['working', 'idle', 'waiting'][i % 3], ...(i % 4 === 0 && { background: { shells: 1, agents: i % 8 ? 0 : 2, monitors: 0, workflows: 0 } }) }));
    await run.app.evaluate(({ BrowserWindow }, sessions) => BrowserWindow.getAllWindows()[0].webContents.send('lectern:quit-prompt', { id: -1, phase: 'confirm', sessions, unchecked: [] }), many);
    await dialog(run.page).waitFor();
    const layout = await dialog(run.page).evaluate(element => {
      const list = element.querySelector('.quit-list'), box = element.getBoundingClientRect(), rows = [...element.querySelectorAll('.quit-session')];
      const buttons = [...element.querySelectorAll('.modal-footer button')].map(button => button.getBoundingClientRect());
      return { rows: rows.length, scrolls: list.scrollHeight > list.clientHeight + 20, listHeight: list.clientHeight,
        inWindow: box.top >= 0 && box.bottom <= innerHeight, buttonsOnOneLine: Math.max(...buttons.map(b => b.top)) < Math.min(...buttons.map(b => b.bottom)) };
    });
    const { listHeight, ...shape } = layout;
    assert.deepEqual(shape, { rows: 30, scrolls: true, inWindow: true, buttonsOnOneLine: true }, JSON.stringify(layout));
    assert.ok(listHeight <= 340, `the list keeps a fixed height (${listHeight}px)`);
    assert.deepEqual(await dialog(run.page).locator('.quit-machine-count').allInnerTexts(), ['10 个对话', '10 个对话', '10 个对话']);
    await dialog(run.page).locator('.quit-session').last().scrollIntoViewIfNeeded();
    assert.ok(await dialog(run.page).locator('.quit-session').last().isVisible(), 'the last conversation is reachable by scrolling');
    await dialog(run.page).locator('.quit-list').evaluate(list => { list.scrollTop = 0; });
    await snap(run.page, 'quit-dialog-many.png');
    await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('lectern:quit-prompt', null));
    await dialog(run.page).waitFor({ state: 'detached' });
    await run.app.evaluate(() => { process.env.LECTERN_DEMO_LATENCY_MS = '6000'; });
    const asked = Date.now();
    await quitFromMain(run);
    await dialog(run.page).waitFor({ timeout: 15_000 });
    const askedMs = Date.now() - asked;
    await run.app.evaluate(() => { delete process.env.LECTERN_DEMO_LATENCY_MS; });
    assert.ok(askedMs < 6000, `the folder check gives up after 3 s (${askedMs} ms)`);
    const listed = await rows(run.page);
    assert.deepEqual(listed.map(row => [row.session, row.unconfirmed]), [[run.demoSession, true]], 'what Lectern saw earlier, marked unconfirmed');
    assert.match(await dialog(run.page).locator('.quit-machine[data-unchecked="true"]').innerText(), /无法确认[\s\S]*3 秒内没有回应/);
    await dialog(run.page).getByRole('button', { name: '取消', exact: true }).click();
    await dialog(run.page).waitFor({ state: 'detached' });
    // Close the conversation the usual way; with nothing running, quitting asks nothing.
    await run.page.getByRole('button', { name: '关闭当前对话', exact: true }).click();
    await run.page.locator('dialog.confirm-action[open]').getByRole('button', { name: '关闭对话', exact: true }).click();
    await run.page.waitForFunction(() => document.querySelector('.session-row.active')?.getAttribute('data-session-live') === 'false', null, { timeout: 30_000 });
    assert.deepEqual(await lecternPanes(run.socket), []);
    await quitFromMain(run);
    await exitWithin(run, 15_000);
    assert.deepEqual(await proceededBecause(run), ['none-running']);
    assert.equal((await events(run)).filter(record => record.event === 'app.quit_answer').length, 1, 'only the Cancel above was a dialog');
    console.log(`F: dialog after ${askedMs} ms with an unanswered check; nothing running quit without a dialog`);
  }

  // ── G: no window left (as on macOS): quitting opens one for the dialog; then SIGTERM quits without asking ──
  {
    const run = await launch('g');
    const before = await lecternPanes(run.socket);
    const opened = run.app.waitForEvent('window', { timeout: 30_000 });
    // destroy() skips the close event: the window is gone and the app quits from window-all-closed.
    await run.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].destroy(); });
    // On macOS the app stays without a window; quitting (⌘Q) is what opens one.
    if (!closingQuits) await quitFromMain(run);
    const page = await opened;
    await dialog(page).waitFor({ timeout: 30_000 });
    assert.deepEqual((await rows(page)).map(row => [row.pane, row.session]), before.map(pane => [pane.pane, pane.session]));
    await page.keyboard.press('Escape');
    await dialog(page).waitFor({ state: 'detached' });
    await pause(300);
    assert.ok(run.alive(), 'Cancel keeps Lectern with the new window');
    run.app.process().kill('SIGTERM');
    await exitWithin(run, 20_000);
    assert.deepEqual(await proceededBecause(run), ['signal']);
    assert.deepEqual(await lecternPanes(run.socket), before);
    console.log('G: without a window the dialog opened one; SIGTERM quit without the dialog and left the conversation running');
  }

  // ── H: Playwright runs without LECTERN_QUIT_PROMPT quit as before ──
  {
    const run = await launch('h', { prompt: false });
    await run.app.close();
    await exitWithin(run, 20_000);
    assert.deepEqual(await proceededBecause(run), ['not-asked']);
    console.log('H: automated runs quit without asking');
  }
  console.log('PASS: quit dialog');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup().catch(error => console.error('cleanup:', error.message));
}
