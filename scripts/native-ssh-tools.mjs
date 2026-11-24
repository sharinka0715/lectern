// Real, opt-in Claude Code tools test. The model creates/edits all source files;
// this harness only creates its empty workspace, drives the GUI and reads evidence.
import assert from 'node:assert/strict';
import { _electron } from './fixtures/electron.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { openConversation, startConversation } from './fixtures/sidebar-folders.mjs';

const sourcePath = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
if (sourcePath) assert.ok(sourcePath.startsWith(path.resolve('test-results') + '/native-ssh-tools-') && sourcePath.endsWith('/report.json'));
const source = sourcePath ? JSON.parse(await readFile(sourcePath, 'utf8')) : undefined;
if (source) {
  assert.equal(source.turns?.length, 2, 'Only verify a source with both coding turns already complete');
  assert.match(source.sessionId, /^[a-f0-9-]{36}$/);
}
const exec = promisify(execFile), host = source?.host || process.env.LECTERN_SSH_HOST;
assert.ok(host, 'Set LECTERN_SSH_HOST to an SSH alias for the test machine');
assert.match(host, /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9_][A-Za-z0-9_.-]*$/);
const q = value => `'${value.replace(/'/g, `'"'"'`)}'`;
const remote = async command => (await exec('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', host, `sh -c ${q(command)}`], { timeout: 30000, maxBuffer: 24 * 1024 * 1024 })).stdout;
const root = path.resolve('test-results', `native-ssh-tools-${Date.now()}`);
await mkdir(root, { recursive: true });
const cwd = source?.cwd || (await remote('mktemp -d /tmp/lectern-tools-XXXXXX')).trim();
assert.match(cwd, /^\/tmp\/lectern-tools-[A-Za-z0-9]+$/);
const report = { success: false, root, host, cwd, sourceReport: sourcePath, inheritedRequests: source ? 2 : 0, requests: 0, phases: [], turns: source?.turns || [], tools: [], uiTools: [] };
const workspaceId = 'ssh-tools', workspaceName = `${host} · 代码工具测试`, owned = [];
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: path.join(root, 'profile'), LECTERN_LOG_DIR: path.join(root, 'diagnostics'), LECTERN_DIAGNOSTIC_CONTENT: '1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL;
const digest = value => createHash('sha256').update(value).digest('hex');
let app, page, sid = source?.sessionId, finalMessages;
const prompts = source ? source.turns.map(turn => turn.prompt) : [
  `请在当前空目录 ${cwd} 做一个很小的 Python 数字统计练习，同时验证工具通道。只操作当前目录，不访问其他项目，不联网、不安装依赖、不用子代理。\n先用 Bash 执行一次 python3 -c "import sys; print('示例输入错误：数值列表不能为空', file=sys.stderr); sys.exit(3)"。这是故意验证错误输出的预期失败，不要修复或重试这条命令，继续后面的正常任务。\n用 Write 工具创建 stats.py，定义 summarize(values)，返回字典 count、total、mean；空列表 mean 为 None，其余返回算术平均值。再用 Write 创建 test_stats.py，用标准库 unittest 测试 [1,2,3]、[-2,0,5] 和 [] 三种输入。用 Read 工具读取这两个文件检查，再用 Bash 执行 python3 -m unittest -v。请使用真正的 Write/Read/Bash 工具，不要用 shell heredoc 代替文件工具；最后用中文简述程序和测试结果。`,
  `继续改进刚才的统计程序。请先用 Glob 查找当前目录的 *.py 文件，再用 Grep 定位 summarize 定义与 mean 的测试；用 Read 查看相关代码。然后通过 Edit 工具给结果增加 minimum 和 maximum 两项，空列表时两者均为 None；调整现有测试，并补充 [7] 与 [-5,-1] 两种情况。最后用 Bash 运行 python3 -m unittest -v，再运行 python3 -c "from stats import summarize; print(summarize([3, 1, 4]))" 展示实际输出。这里需要验证独立的 Glob/Grep/Read/Edit/Bash 工具，请不要全用 shell 替代，也不要用 Write 覆盖文件来代替 Edit。仍只操作当前目录、不联网、不安装任何依赖。完成后用中文简要说明。`,
];
async function checkpoint(phase) {
  report.phases.push({ phase, at: new Date().toISOString() });
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ phase, root, requests: report.requests }));
}
async function inventory() { return (await remote("tmux list-panes -a -F '#{pane_id}|#{session_name}|#{@lectern_session_id}|#{pane_current_command}'")).trim().split('\n'); }
async function stopOwned(session) {
  const [pane, name, bound] = (await remote(`tmux display-message -p -t ${q(session.paneId)} '#{pane_id}|#{session_name}|#{@lectern_session_id}'`).catch(() => '')).trim().split('|');
  if (pane === session.paneId && bound === session.sessionId && name.startsWith(`lectern-${bound.slice(0, 8)}-`)) await remote(`tmux kill-pane -t ${q(pane)}`);
}
async function ready() {
  await page.waitForFunction(sid => window.__snapshot?.sessionId === sid && window.__snapshot.status === 'idle' && window.__snapshot.navigationStatus === 'idle' && !window.__snapshot.settingBusy && !window.__snapshot.trustBusy, sid, { timeout: 60000 });
}
async function chooseSonnet() {
  await ready();
  const menu = await page.evaluate(({ workspaceId, sid }) => window.desktop.getSessionSetting(workspaceId, sid, 'model'), { workspaceId, sid });
  assert.equal(menu.complete, true);
  const target = menu.options.find(o => /sonnet/i.test(o.label) && !/opus|default/i.test(o.label));
  assert.ok(target, 'Only an explicitly observed Sonnet option may be selected');
  if (!target.current) {
    await ready();
    await page.locator('button[data-setting-kind="model"]').click();
    const uiMenu = page.locator('[data-setting-menu="model"]');
    await uiMenu.getByRole('option').filter({ has: page.getByText(target.label, { exact: true }) }).click({ timeout: 120000 });
    await uiMenu.waitFor({ state: 'hidden', timeout: 120000 });
  }
  await ready();
  const verified = await page.evaluate(({ workspaceId, sid }) => window.desktop.getSessionSetting(workspaceId, sid, 'model'), { workspaceId, sid });
  assert.equal(verified.options.find(o => o.current)?.label, target.label);
  report.model = { label: target.label, description: target.description, verified: true };
  await checkpoint('native-sonnet-verified');
}
function contentText(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('\n\n') : '';
}
async function captureTranscript() {
  if (!sid || !page) return;
  const discovery = await page.evaluate(id => window.desktop.discover(id), workspaceId);
  const transcriptPath = discovery.sessions.find(s => s.id === sid)?.path;
  if (!transcriptPath) return;
  const raw = await remote(`cat ${q(transcriptPath)}`);
  await writeFile(path.join(root, 'remote-transcript.jsonl'), raw);
  report.transcriptPath = transcriptPath;
  report.transcript = { bytes: Buffer.byteLength(raw), sha256: digest(raw) };
  return raw.trim().split('\n').map(JSON.parse).filter(r => !r.isSidechain && !r.isMeta && r.sessionId === sid);
}
try {
  report.initialPanes = await inventory();
  assert.ok((await remote('command -v python3')).trim(), 'Use existing Python only');
  app = await _electron.launch({ args: ['.'], env, timeout: 60000 });
  page = await app.firstWindow(); page.setDefaultTimeout(45000);
  const rendererErrors = []; page.on('pageerror', error => rendererErrors.push(String(error)));
  await page.waitForFunction(() => !!window.desktop);
  await page.evaluate(({ workspaceId, workspaceName, host, cwd }) => window.desktop.saveWorkspace({ id: workspaceId, name: workspaceName, kind: 'ssh', host, cwd }), { workspaceId, workspaceName, host, cwd });
  await page.reload(); await page.waitForFunction(() => !!window.desktop);
  await page.exposeFunction('__toolProgress', value => console.log(JSON.stringify(value)));
  await page.evaluate(() => {
    window.__snapshots = []; window.__toolStates = new Map();
    window.desktop.onSnapshot(snapshot => {
      window.__snapshot = snapshot; window.__snapshots.push(snapshot);
      for (const tool of snapshot.messages.flatMap(m => m.tools || [])) {
        const state = tool.isError ? 'error' : tool.result !== undefined ? 'completed' : 'pending';
        if (window.__toolStates.get(tool.id) !== state) {
          window.__toolStates.set(tool.id, state);
          void window.__toolProgress({ tool: tool.name, id: tool.id, state });
        }
      }
    });
  });
  if (source) {
    const discovery = await page.evaluate(id => window.desktop.discover(id), workspaceId);
    assert.ok(discovery.sessions.some(s => s.id === sid && s.path && !s.paneId), 'Only reopen the inactive test-owned UUID');
    await openConversation(page, workspaceId, sid);
    await page.waitForFunction(sid => window.__snapshot?.sessionId === sid && window.__snapshot.status === 'idle' && !window.__snapshot.paneId, sid);
    const inherited = await page.evaluate(() => window.__snapshot.messages);
    assert.equal(inherited.length, 4);
    const inheritedAnswers = inherited.filter(m => m.role === 'assistant');
    const expectedAnswers = source.turns.map(t => t.answer);
    assert.deepEqual(inheritedAnswers.map((answer, i) => ({
      ...answer, tools: answer.tools.map((tool, j) => {
        // Old reports predate native edit patches. Compare every field their format recorded.
        const expected = expectedAnswers[i].tools[j];
        return Object.fromEntries(Object.keys(expected).map(key => [key, tool[key]]));
      }),
    })), expectedAnswers);
    await page.getByRole('button', { name: '续接会话', exact: true }).click();
  } else {
    // 新建对话 only opens a draft whose first message would start Claude Code with the default
    // model; start the pane without a message (no request) and open it from the sidebar.
    await startConversation(page, workspaceId);
  }
  await page.waitForFunction(() => !!window.__snapshot?.paneId);
  const session = await page.evaluate(() => window.__snapshot); owned.push(session); sid = session.sessionId; report.sessionId = sid;
  await page.waitForFunction(() => window.__snapshot?.directoryTrust || window.__snapshot?.navigationStatus === 'idle');
  if (await page.evaluate(() => !!window.__snapshot.directoryTrust)) {
    assert.equal(await page.evaluate(() => window.__snapshot.directoryTrust.cwd), cwd);
    await page.locator('button[data-trust-decision="trust"]').click();
    report.directoryTrustExplicit = true;
  }
  if (source) { await ready(); report.model = source.model; await checkpoint('inherited-tool-history-verified'); }
  else await chooseSonnet();
  for (let index = source ? prompts.length : 0; index < prompts.length; index++) {
    await ready();
    await page.getByRole('textbox', { name: '发送给 Claude 的消息' }).fill(prompts[index]);
    await page.getByRole('button', { name: '发送消息', exact: true }).click(); report.requests++;
    await checkpoint(`tools-turn-${index + 1}-sent`);
    await page.waitForFunction(({ sid, count }) => {
      const s = window.__snapshot;
      if (s?.sessionId !== sid) return false;
      // A tool's expected nonzero exit is not a failed model turn.
      if (s.error || s.status === 'offline' || s.directoryTrust) return true;
      const answers = s.messages.filter(m => m.role === 'assistant');
      return s.status === 'idle' && s.navigationStatus === 'idle' && answers.length === count && answers.at(-1).source === 'jsonl' && answers.at(-1).status === 'complete' && answers.at(-1).tools.length > 0 && answers.at(-1).tools.every(t => t.result !== undefined);
    }, { sid, count: index + 1 }, { timeout: 240000 });
    const s = await page.evaluate(() => window.__snapshot);
    assert.equal(s.error, undefined); assert.equal(s.status, 'idle');
    const answers = s.messages.filter(m => m.role === 'assistant');
    assert.equal(answers.length, index + 1);
    assert.equal(s.messages.filter(m => m.role === 'user').length, index + 1, 'Tool results must not become extra human-message bubbles');
    const answer = answers.at(-1);
    for (const prior of report.turns) assert.deepEqual(answers.find(m => m.id === prior.answer.id), prior.answer);
    report.turns.push({ prompt: prompts[index], answer });
    await page.screenshot({ path: path.join(root, `tools-turn-${index + 1}.png`) });
    await checkpoint(`tools-turn-${index + 1}-complete`);
  }
  finalMessages = await page.evaluate(() => window.__snapshot.messages);
  const records = await captureTranscript(); assert.ok(records);
  const calls = new Map(), results = new Map();
  for (const r of records) for (const block of Array.isArray(r.message?.content) ? r.message.content : []) {
    if (r.type === 'assistant' && block.type === 'tool_use') calls.set(block.id, { id: block.id, name: block.name, input: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}, null, 2) });
    if (r.type === 'user' && block.type === 'tool_result') {
      const result = { result: contentText(block.content), isError: block.is_error === true };
      const patch = r.toolUseResult?.structuredPatch;
      if (!result.isError && r.message.content.filter(item => item.type === 'tool_result').length === 1 && Array.isArray(patch) && patch.length) {
        result.editPatch = patch.map(({ oldStart, oldLines, newStart, newLines, lines }) => ({ oldStart, oldLines, newStart, newLines, lines }));
      }
      results.set(block.tool_use_id, result);
    }
  }
  report.requestedModels = [...new Set(records.filter(r => r.type === 'assistant').map(r => r.message?.model).filter(Boolean))];
  assert.ok(report.requestedModels.length && report.requestedModels.every(m => /sonnet|haiku/i.test(m) && !/opus/i.test(m)));
  report.tools = [...calls.values()].map(call => ({ ...call, ...results.get(call.id) }));
  const displayedTools = finalMessages.flatMap(m => m.tools);
  assert.equal(displayedTools.length, report.tools.length);
  assert.equal(new Set(displayedTools.map(t => t.id)).size, displayedTools.length);
  for (const group of await page.locator('.tool-group').all()) {
    assert.equal(await group.evaluate(node => node.open), false);
    await group.locator(':scope > summary').click();
  }
  for (const expected of report.tools) {
    assert.ok(results.has(expected.id), 'Every observed call has an authoritative result');
    const { textOffset, ...displayed } = displayedTools.find(t => t.id === expected.id);
    assert.ok(Number.isInteger(textOffset) && textOffset >= 0);
    assert.deepEqual(displayed, expected, 'Tool input, result and error flag match raw JSONL');
    assert.match(expected.id, /^[A-Za-z0-9_-]+$/);
    const block = page.locator(`.tool-block[data-tool-id="${expected.id}"]`);
    assert.equal(await block.count(), 1);
    const state = expected.isError ? 'error' : 'completed';
    assert.equal(await block.getAttribute('data-tool-name'), expected.name);
    assert.equal(await block.getAttribute('data-tool-state'), state);
    const diffExpected = expected.name === 'Edit' || expected.name === 'MultiEdit' || expected.name === 'NotebookEdit' ||
      (expected.name === 'Write' && !!expected.editPatch);
    assert.equal(await block.evaluate(node => node.open), false, 'Each call starts collapsed, including Edit');
    await block.locator('summary').click();
    if (diffExpected) {
      const diff = block.getByRole('region', { name: '编辑差异' });
      const args = JSON.parse(expected.input);
      assert.equal(await diff.locator('header button').textContent(), args.file_path ?? args.notebook_path);
      if (expected.editPatch) {
        assert.equal(await diff.getAttribute('data-diff-source'), 'native');
        const more = diff.locator('.edit-diff-more');
        while (await more.count()) await more.click();
        assert.deepEqual(await diff.locator('.edit-diff-line code').allTextContents(), expected.editPatch.flatMap(hunk => hunk.lines));
      }
    } else {
      // Arguments are shown as their readable fields (command, file, pattern…), not as JSON.
      const view = await block.locator('.tool-detail').innerText(), args = JSON.parse(expected.input);
      for (const value of [args.command, args.file_path, args.pattern, args.url, args.query].filter(v => typeof v === 'string'))
        assert.ok(view.includes(value), `${expected.name} shows ${value}`);
    }
    if (expected.result?.trim()) assert.equal(await block.locator('.tool-output pre').textContent(), expected.result);
    report.uiTools.push({ id: expected.id, name: expected.name, state, inputView: diffExpected ? 'diff' : 'fields', resultExact: true });
    if (expected.isError || expected.name === 'Edit') await block.locator('.tool-detail').scrollIntoViewIfNeeded();
    if (expected.isError) await page.screenshot({ path: path.join(root, 'expected-tool-error.png') });
    if (expected.name === 'Edit') await page.screenshot({ path: path.join(root, 'edit-tool-details.png') });
    await block.locator('summary').click();
  }
  report.toolNames = [...new Set(report.tools.map(t => t.name))].sort();
  for (const name of ['Bash', 'Edit', 'Read', 'Write']) assert.ok(report.toolNames.includes(name), `Native ${name} tool was exercised`);
  report.requestedButNotObservedTools = ['Glob', 'Grep'].filter(name => !report.toolNames.includes(name));
  // Native tool availability differs across versions. Report observed tools;
  // never call Bash search evidence a successful independent Glob/Grep call.
  assert.equal(report.tools.filter(t => t.isError).length, 1, 'Only the explicitly requested sample failure is expected');
  assert.match(report.tools.find(t => t.isError).result, /示例输入错误/);
  for (const prompt of prompts) assert.equal(records.filter(r => r.type === 'user' && contentText(r.message?.content) === prompt).length, 1);
  const snapshots = await page.evaluate(() => window.__snapshots);
  report.observedPendingTools = [...new Set(snapshots.flatMap(s => s.messages.flatMap(m => m.tools.filter(t => t.result === undefined).map(t => t.id))))];
  for (const s of snapshots.filter(s => s.sessionId === sid)) assert.ok(s.messages.filter(m => m.role === 'user').length <= prompts.length);
  await checkpoint('all-tools-and-dom-match-raw-jsonl');

  // Read model-created files and execute independent standard-library checks.
  const files = {};
  for (const name of ['stats.py', 'test_stats.py']) {
    files[name] = await remote(`cat ${q(`${cwd}/${name}`)}`);
    await writeFile(path.join(root, name), files[name]);
  }
  report.generatedFiles = Object.entries(files).map(([name, content]) => ({ name, bytes: Buffer.byteLength(content), sha256: digest(content) }));
  const check = "from stats import summarize; assert summarize([]) == dict(count=0,total=0,mean=None,minimum=None,maximum=None); assert summarize([3,1,4]) == dict(count=3,total=8,mean=8/3,minimum=1,maximum=4); assert summarize([-5,-1]) == dict(count=2,total=-6,mean=-3,minimum=-5,maximum=-1); print('Independent function checks passed')";
  report.independentExecution = await remote(`cd ${q(cwd)} && python3 -m unittest -v 2>&1 && python3 -c ${q(check)}`);
  assert.match(report.independentExecution, /\bOK\b/); assert.match(report.independentExecution, /Independent function checks passed/);

  await stopOwned(session);
  await page.waitForFunction(() => window.__snapshot?.status === 'idle' && !window.__snapshot.paneId);
  await page.getByRole('button', { name: '续接会话', exact: true }).click();
  await page.waitForFunction(() => !!window.__snapshot?.paneId);
  owned.push(await page.evaluate(() => window.__snapshot));
  await ready();
  const resumed = await page.evaluate(() => window.__snapshot);
  assert.equal(digest(JSON.stringify(resumed.messages)), digest(JSON.stringify(finalMessages)), 'Resume preserves all message and tool fields');
  report.resume = { sessionId: sid, allMessageAndToolFieldsPreserved: true, tools: report.tools.length };
  await page.screenshot({ path: path.join(root, 'tools-resumed.png') });
  report.diagnostics = await page.evaluate(() => window.desktop.diagnosticsInfo());
  assert.equal(report.diagnostics.droppedEvents, 0); assert.equal(report.diagnostics.lastError, undefined); assert.deepEqual(rendererErrors, []);
  report.success = true; await checkpoint('tools-test-complete');
} catch (error) {
  report.error = String(error?.stack || error).slice(0, 12000); process.exitCode = 1;
  if (page) {
    await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
    await writeFile(path.join(root, 'failure-screen.txt'), await page.evaluate(() => window.__snapshot?.viewport || window.__snapshot?.screen || '').catch(() => ''));
    report.incidentId = await page.evaluate(note => window.desktop.markDiagnosticIncident(note), report.error.slice(0, 1800)).catch(() => undefined);
  }
} finally {
  await captureTranscript().catch(error => { report.transcriptCaptureError = String(error); });
  if (page) {
    const discovery = await page.evaluate(id => window.desktop.discover(id), workspaceId).catch(() => undefined);
    for (const pane of discovery?.panes || []) if (pane.cwd === cwd && pane.managed && pane.sessionId) owned.push({ paneId: pane.id, sessionId: pane.sessionId });
  }
  for (const session of owned) await stopOwned(session).catch(() => {});
  await app?.close();
  report.finalPanes = await inventory().catch(() => []);
  if (JSON.stringify(report.initialPanes) !== JSON.stringify(report.finalPanes)) { report.success = false; report.paneInventoryChanged = true; process.exitCode = 1; }
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ root, success: report.success, requests: report.requests, toolNames: report.toolNames, error: report.error?.slice(0, 3000) }, null, 2));
}
