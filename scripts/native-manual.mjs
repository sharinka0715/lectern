// Explicit opt-in, real native Claude Code over existing SSH/tmux only.
// Initially uses one Sonnet request for AskUserQuestion. Further explicit
// operator text + Enter may send additional requests, counted from final JSONL.
import assert from 'node:assert/strict';
import { _electron } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
const exec = promisify(execFile), host = process.env.LECTERN_SSH_HOST;
assert.ok(host, 'Set LECTERN_SSH_HOST to an SSH alias for the test machine');
assert.match(host, /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9_][A-Za-z0-9_.-]*$/);
const q = value => `'${value.replace(/'/g, `'"'"'`)}'`;
const remote = async command => (await exec('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', host, `sh -c ${q(command)}`], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout;
const root = path.resolve('test-results', `native-manual-${Date.now()}`);
await mkdir(root, { recursive: true });
const cwd = (await remote('mktemp -d /tmp/lectern-manual-XXXXXX')).trim();
assert.match(cwd, /^\/tmp\/lectern-manual-[A-Za-z0-9]+$/);
const report = { success: false, root, host, cwd, requests: 0, checks: [], screens: [], originalPanes: await remote("tmux list-panes -a -F '#{pane_id}|#{@lectern_session_id}|#{pane_current_command}'") };
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: path.join(root, 'profile'), LECTERN_LOG_DIR: path.join(root, 'diagnostics'), LECTERN_LOG_CONTENT: '1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL;
const workspaceId = 'native-manual', name = `${host} · 原生交互测试`;
let app, page, sid, paneId;
const snapshot = () => page.evaluate(() => window.__snapshot);
const frame = async (label) => {
  const s = await snapshot();
  await writeFile(path.join(root, `${label}.txt`), s?.viewport ?? s?.screen ?? '');
  await page.screenshot({ path: path.join(root, `${label}.png`) });
  report.screens.push({ label, status: s?.status, navigationStatus: s?.navigationStatus, messages: s?.messages.length });
  console.log(JSON.stringify({ phase: label, status: s?.status, viewport: s?.viewport }));
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  return s;
};
const waitFrame = async predicate => {
  await page.waitForFunction(predicate, null, { timeout: 60000 });
};
async function take() {
  if (!await page.locator('.terminal-panel').count()) await page.getByTitle('查看终端原屏').click();
  await page.locator('[data-terminal-action="take"]').click();
  await waitFrame(() => !!window.__snapshot?.terminalControl);
}
async function key(key) {
  assert.ok((await snapshot()).terminalControl);
  const mapped = ({ Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', BTab: 'Shift+Tab' })[key] ?? key.replace(/^C-/, 'Control+');
  await page.getByRole('textbox', { name: '原生终端输入' }).press(mapped);
  await page.locator('[data-terminal-pending="0"]').waitFor({ state: 'attached' });
}
async function text(text) {
  const terminal = page.getByRole('textbox', { name: '原生终端输入' });
  await terminal.focus();
  await terminal.evaluate((node, text) => {
    const data = new DataTransfer(); data.setData('text/plain', text);
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
  await page.locator('[data-terminal-pending="0"]').waitFor({ state: 'attached' });
}
async function release() {
  await page.locator('[data-terminal-action="release"]').click();
  await waitFrame(() => !window.__snapshot?.terminalControl);
}
async function ready() {
  await waitFrame(() => window.__snapshot?.navigationStatus === 'idle' && window.__snapshot?.status === 'idle' && !window.__snapshot?.settingBusy && !window.__snapshot?.trustBusy);
}
try {
  app = await _electron.launch({ args: ['.'], env, timeout: 60000 });
  page = await app.firstWindow(); page.setDefaultTimeout(45000);
  await page.waitForFunction(() => !!window.desktop);
  await page.evaluate(({workspaceId,name,host,cwd}) => window.desktop.saveWorkspace({id:workspaceId,name,kind:'ssh',host,cwd}), {workspaceId,name,host,cwd});
  await page.reload(); await page.waitForFunction(() => !!window.desktop);
  await page.evaluate(() => { window.__snapshots = []; window.desktop.onSnapshot(s => { window.__snapshot = s; window.__snapshots.push(s); }); });
  await page.getByRole('button', { name: `在 ${name} 新建对话`, exact:true }).click();
  await waitFrame(() => !!window.__snapshot?.paneId && (!!window.__snapshot.directoryTrust || window.__snapshot.navigationStatus === 'idle'));
  ({ sessionId: sid, paneId } = await snapshot()); report.sessionId = sid; report.paneId = paneId;
  const initial = await frame('startup');
  if (initial.directoryTrust) {
    assert.equal(initial.directoryTrust.cwd, cwd);
    await take();
    const viewport = (await snapshot()).viewport;
    assert.match(viewport, /Yes, I trust this folder/); assert.match(viewport, /No, exit/);
    if (/❯\s*(?:\d+\.\s*)?No, exit/.test(viewport)) await key('Up');
    else assert.match(viewport, /❯\s*(?:\d+\.\s*)?Yes, I trust this folder/);
    await key('Enter');
    await ready(); await release(); report.checks.push('manual-folder-trust');
  }
  await ready();
  const menu = await page.evaluate(({workspaceId,sid}) => window.desktop.getSessionSetting(workspaceId,sid,'model'), {workspaceId,sid});
  const sonnet = menu.options.find(option => /sonnet/i.test(option.label) && !/opus|default/i.test(option.label));
  assert.ok(menu.complete && sonnet);
  await ready();
  if (!sonnet.current) await page.evaluate(({workspaceId,sid,token,option}) => window.desktop.setSessionSetting(workspaceId,sid,token,option), {workspaceId,sid,token:menu.token,option:sonnet.id});
  await ready();
  const verified = await page.evaluate(({workspaceId,sid}) => window.desktop.getSessionSetting(workspaceId,sid,'model'), {workspaceId,sid});
  assert.equal(verified.options.find(option => option.current)?.label, sonnet.label);
  report.model = sonnet.label; report.checks.push('observed-sonnet-only');
  await ready(); await take();
  await text('/help');
  await page.waitForTimeout(600);
  assert.equal((await snapshot()).messages.filter(m => m.role === 'user').length, 0);
  await key('Enter');
  await waitFrame(() => /Help\s+General\s+Commands\s+Custom commands/.test(window.__snapshot?.viewport || ''));
  await frame('help-menu'); await key('Escape'); await ready();
  await text('/permissions'); await key('Enter');
  await waitFrame(() => /Permissions|Allow\s+Ask\s+Deny|permission rules/i.test(window.__snapshot?.viewport || ''));
  await frame('permissions-menu'); await key('Tab'); await page.waitForTimeout(600); await frame('permissions-tab');
  await key('Escape'); await ready();
  await page.getByRole('textbox', { name: '原生终端输入' }).focus();
  await page.keyboard.type('s1;');
  await page.keyboard.insertText('中🧭');
  await waitFrame(() => (window.__snapshot?.viewport || '').includes('s1;中🧭'));
  await frame('literal-characters-draft');
  assert.equal((await snapshot()).messages.filter(m=>m.role==='user').length,0);
  await key('C-u'); await ready(); await release();
  report.checks.push('help-open-close', 'permissions-tab-and-cancel', 'literal-character-unicode-semicolon-no-submit');
  const prompt = '我想给隔壁新搬来的邻居准备一份小礼物。请先调用 AskUserQuestion 工具，让我从「茶叶」「饼干」「盆栽」中多选两项；收到我的选择后，用两句话建议如何包装。先不要替我选择，不要读写文件，也不要运行命令。';
  await page.getByRole('textbox',{name:'发送给 Claude 的消息'}).fill(prompt);
  await page.getByRole('button',{name:'发送消息',exact:true}).click(); report.requests++;
  await waitFrame(() => window.__snapshot?.messages.some(m=>m.tools.some(t=>t.name==='AskUserQuestion')) || window.__snapshot?.status==='waiting' || (window.__snapshot?.status==='idle' && window.__snapshot?.messages.some(m=>m.role==='assistant' && m.status==='complete')));
  await frame('question-or-notice');
  // Leave unknown screens to the operator; a separate continuation can use the
  // recorded exact session/pane. Never infer a generic Yes/Enter approval.
  report.pendingQuestion = true;
  report.checks.push('real-sonnet-request-sent');
  console.log(JSON.stringify({ phase:'operator-review', root, sid, paneId }));
  // Read-only capture and controlled continuation are driven by a local script
  // command file, never a remote helper or server. This harness stays alive.
  const { readFile } = await import('node:fs/promises');
  let sequence = 0;
  while (true) {
    const filename = path.join(root, `step-${sequence}.json`);
    let step;
    try { step = JSON.parse(await readFile(filename, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise(r=>setTimeout(r,300)); continue; }
    sequence++;
    if (step.type === 'take') await take();
    else if (step.type === 'key') await key(step.key);
    else if (step.type === 'text') await text(step.text);
    else if (step.type === 'release') await release();
    else if (step.type === 'finish') {
      await ready();
      const final = await snapshot();
      report.finalMessages = final.messages;
      report.checks.push(...(step.checks || [])); report.pendingQuestion = false;
      const discovery = await page.evaluate(id => window.desktop.discover(id),workspaceId);
      const transcriptPath = discovery.sessions.find(s=>s.id===sid)?.path;
      assert.ok(transcriptPath); report.transcriptPath = transcriptPath;
      const raw = await remote(`cat ${q(transcriptPath)}`);
      await writeFile(path.join(root,'remote-transcript.jsonl'),raw);
      const records = raw.trim().split('\n').map(JSON.parse);
      report.composerRequests = report.requests;
      report.requests = final.messages.filter(m => m.role === 'user').length;
      report.manualTerminalRequests = report.requests - report.composerRequests;
      report.requestedModels = [...new Set(records.filter(r=>r.type==='assistant').map(r=>r.message?.model).filter(Boolean))];
      assert.ok(report.requestedModels.length && report.requestedModels.every(m=>/sonnet|haiku/i.test(m) && !/opus/i.test(m)));
      await frame('completed'); report.success=true; break;
    } else if (step.type !== 'capture') throw new Error('Unsupported harness step');
    await page.waitForTimeout(750); await frame(`step-${sequence}-${step.type}`);
  }
} catch (error) {
  report.error = error.stack || String(error); process.exitCode = 1;
  if (page) await frame('failure').catch(()=>{});
} finally {
  await app?.close();
  if (paneId && sid) {
    const mapping = await remote(`tmux show-options -pqv -t ${q(paneId)} @lectern_session_id`).catch(()=> '');
    if (mapping.trim() === sid) await remote(`tmux kill-pane -t ${q(paneId)}`);
  }
  report.finalPanes = await remote("tmux list-panes -a -F '#{pane_id}|#{@lectern_session_id}|#{pane_current_command}'");
  await writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
