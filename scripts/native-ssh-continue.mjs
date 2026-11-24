// Opt-in continuation of a test-owned SSH conversation. Inherits one or two
// completed requests, installs nothing, and never selects Opus/Default.
// After `npm run build`: node scripts/native-ssh-continue.mjs test-results/native-ssh-<time>/report.json
// (a report of `npm run test:native:ssh`, or of an earlier continuation). It reconnects to that
// report's real SSH host (keys, tmux, logged-in claude) and sends the remaining 1–2 real model
// requests, so it is manual only: not in package.json or test:all.
import assert from 'node:assert/strict';
import { _electron } from './fixtures/electron.mjs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { selectNativeScenario, validateNativeAnswer } from './native-dialogue.mjs';

const sourcePath = path.resolve(process.argv[2] || '');
const results = path.resolve('test-results');
assert.ok(sourcePath.startsWith(results + '/native-ssh-') && sourcePath.endsWith('/report.json'), 'Pass the source SSH test report.json');
const source = JSON.parse(await readFile(sourcePath, 'utf8'));
assert.match(source.cwd, /^\/tmp\/lectern-ssh-[A-Za-z0-9]+$/);
assert.match(source.sessionId, /^[a-f0-9-]{36}$/);
assert.match(source.host, /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9_][A-Za-z0-9_.-]*$/);
assert.ok(source.transcriptPath?.startsWith('/') && source.transcriptPath.endsWith(`/${source.sessionId}.jsonl`));
const sourceChain = [{ path: sourcePath, report: source }], seenReports = new Set([sourcePath]);
while (sourceChain.at(-1).report.sourceReport) {
  assert.ok(sourceChain.length < 8, 'Source report chain is unexpectedly deep');
  const ancestorPath = path.resolve(sourceChain.at(-1).report.sourceReport);
  assert.ok(ancestorPath.startsWith(results + '/native-ssh-') && ancestorPath.endsWith('/report.json') && !seenReports.has(ancestorPath), 'Invalid or cyclic source report chain');
  const ancestor = JSON.parse(await readFile(ancestorPath, 'utf8'));
  assert.equal(ancestor.sessionId, source.sessionId); assert.equal(ancestor.cwd, source.cwd); assert.equal(ancestor.host, source.host);
  sourceChain.push({ path: ancestorPath, report: ancestor }); seenReports.add(ancestorPath);
}
assert.equal(sourceChain.at(-1).report.scenarioOffset, 3, 'Root conversation must start with the existing rainy-hour turn');
const inheritedConfirmations = sourceChain.flatMap(item => (item.report.cacheConfirmations || []).map(event => ({ sourceReport: item.path, ...event })));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const originalRaw = await readFile(path.join(path.dirname(sourcePath), 'remote-transcript.jsonl'));
assert.equal(originalRaw.length, source.transcript.bytes);
assert.equal(hash(originalRaw), source.transcript.sha256);
const recordsOf = raw => raw.toString('utf8').trim().split('\n').map(JSON.parse);
const textOf = record => typeof record.message?.content === 'string' ? record.message.content
  : (record.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n\n');
const assistantRecords = records => records.filter(record => record.type === 'assistant' && !record.isSidechain && !record.isMeta && record.sessionId === source.sessionId);
const uniqueAssistants = records => [...new Map(assistantRecords(records).map(record => [record.uuid || hash(JSON.stringify(record)), record])).values()];
const sourceRecords = recordsOf(originalRaw), originalAssistants = uniqueAssistants(sourceRecords);
const originalCount = originalAssistants.length;
assert.ok(originalCount === 1 || originalCount === 2, 'Only a one- or two-turn test conversation may be continued; never replay a completed three-turn run');
assert.match(originalAssistants[0].message.model, /haiku/i);
for (const [index, assistant] of originalAssistants.entries()) {
  assert.doesNotMatch(assistant.message.model, /opus/i);
  if (index > 0) assert.match(assistant.message.model, /sonnet/i);
  assert.equal(sourceRecords.filter(record => record.type === 'user' && textOf(record) === selectNativeScenario('native', 3 + index, '').prompt).length, 1);
}

const root = path.resolve('test-results', `native-ssh-continue-${Date.now()}`);
await mkdir(root, { recursive: true });
const exec = promisify(execFile), host = source.host, sid = source.sessionId, cwd = source.cwd;
const q = value => `'${value.replace(/'/g, `'"'"'`)}'`;
const remote = async (command, bytes = false) => (await exec('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', host, `sh -c ${q(command)}`],
  { timeout: 30000, maxBuffer: 24 * 1024 * 1024, encoding: bytes ? 'buffer' : 'utf8' })).stdout;
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: path.join(root, 'profile'), LECTERN_LOG_DIR: path.join(root, 'diagnostics'), LECTERN_DIAGNOSTIC_CONTENT: '1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL;
const report = { success: false, root, host, cwd, sessionId: sid, sourceReport: sourcePath, scenarioOffset: 3,
  plannedNewRequests: 3 - originalCount,
  sourceEvidence: { transcript: source.transcript, existingRequests: originalCount, reportChain: sourceChain.map(item => item.path),
    trustAndOriginalHistoryReport: sourceChain.at(-1).path, cacheConfirmations: inheritedConfirmations },
  requests: 0, phases: [], settings: [], turns: [], resumes: [], trustReconfirmations: [] };
const owned = [], errors = [];
let app, page, workspaceId;
async function checkpoint(phase) {
  report.phases.push({ phase, at: new Date().toISOString() });
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ phase, root, newRequests: report.requests }));
}
async function inventory() { return (await remote("tmux list-panes -a -F '#{pane_id}|#{session_name}|#{@lectern_session_id}|#{pane_current_command}'")).trim().split('\n'); }
async function stopOwned(session) {
  const identity = (await remote(`tmux display-message -p -t ${q(session.paneId)} '#{pane_id}|#{session_name}|#{@lectern_session_id}'`).catch(() => '')).trim().split('|');
  if (identity[0] === session.paneId && identity[2] === sid && identity[1].startsWith(`lectern-${sid.slice(0, 8)}-`)) {
    await remote(`tmux kill-pane -t ${q(session.paneId)}`);
  }
}
async function waitReady() {
  await page.waitForFunction(sid => window.__snapshot?.sessionId === sid && window.__snapshot.navigationStatus === 'idle'
    && window.__snapshot.status === 'idle' && !window.__snapshot.settingBusy && !window.__snapshot.trustBusy, sid, { timeout: 60000 });
}
async function resume(expected, phase) {
  assert.equal((await page.evaluate(() => window.__snapshot)).paneId, undefined, 'Resume only the inactive test-owned UUID');
  await page.getByRole('button', { name: '续接会话', exact: true }).click();
  await page.waitForFunction(sid => window.__snapshot?.sessionId === sid && !!window.__snapshot.paneId, sid);
  const started = await page.evaluate(() => window.__snapshot); owned.push(started);
  await page.waitForFunction(() => window.__snapshot?.directoryTrust || (window.__snapshot?.navigationStatus === 'idle' && window.__snapshot?.status === 'idle'));
  const trust = await page.evaluate(() => window.__snapshot.directoryTrust);
  if (trust) {
    assert.equal(trust.cwd, cwd, 'Only this test-owned temporary directory can be reconfirmed');
    await page.locator('button[data-trust-decision="trust"]').click();
    report.trustReconfirmations.push({ cwd, phase, explicitButton: true });
  }
  await waitReady();
  const ready = await page.evaluate(() => window.__snapshot);
  assert.deepEqual(ready.messages, expected, 'Resume preserves every message ID, exact text, ordering and tool state');
  report.resumes.push({ phase, sessionId: ready.sessionId, paneId: ready.paneId, messages: ready.messages.length, canonicalHistoryPreserved: true });
  await page.screenshot({ path: path.join(root, `${phase}.png`) });
  await checkpoint(phase);
  return ready;
}
async function detachAndResume(active, expected, phase) {
  await stopOwned(active);
  await page.waitForFunction(() => !window.__snapshot?.paneId || window.__snapshot.status === 'offline');
  const inactive = await page.evaluate(id => window.desktop.discover(id), workspaceId);
  assert.ok(inactive.sessions.some(session => session.id === sid && session.path && !session.paneId));
  await page.waitForFunction(() => window.__snapshot?.status === 'idle' && !window.__snapshot.paneId);
  return resume(expected, phase);
}
async function menu(kind) {
  await waitReady();
  return page.evaluate(({ workspaceId, sid, kind }) => window.desktop.getSessionSetting(workspaceId, sid, kind), { workspaceId, sid, kind });
}
async function choose(kind, matches) {
  const observed = await menu(kind);
  assert.equal(observed.complete, true);
  const target = observed.options.find(matches);
  assert.ok(target, `Required native ${kind} option missing`);
  if (kind === 'model') assert.ok(/sonnet/i.test(target.label) && !/opus|default/i.test(target.label));
  if (!target.current) {
    await waitReady();
    await page.locator(`button[data-setting-kind="${kind}"]`).click();
    const selector = page.locator(`[data-setting-menu="${kind}"]`);
    await selector.getByRole('option').filter({ has: page.getByText(target.label, { exact: true }) }).click({ timeout: 120000 });
    await selector.waitFor({ state: 'hidden', timeout: 120000 });
    assert.ok((await page.locator(`button[data-setting-kind="${kind}"]`).innerText()).includes(target.label));
  }
  const verified = await menu(kind);
  assert.equal(verified.options.find(option => option.current)?.label, target.label);
  report.settings.push({ kind, selected: target.label, description: target.description, verified: true });
  await checkpoint(`${kind}: ${target.label}`);
  return target.label;
}
async function dialogue(scenarioIndex, model) {
  await waitReady();
  const scenario = selectNativeScenario('native', scenarioIndex, '');
  const expectedCount = report.turns.length + 1;
  await page.getByRole('textbox', { name: '发送给 Claude 的消息' }).fill(scenario.prompt);
  await page.getByRole('button', { name: '发送消息', exact: true }).click(); report.requests++;
  await checkpoint(`dialogue-${expectedCount}-sent`);
  await page.waitForFunction(({ sid, count }) => {
    const snapshot = window.__snapshot;
    if (snapshot?.sessionId !== sid || snapshot.settingBusy) return false;
    if (['error', 'offline', 'waiting'].includes(snapshot.status) || snapshot.messages.some(message => message.tools?.length)) return true;
    const answers = snapshot.messages.filter(message => message.role === 'assistant');
    return answers.length === count && answers.at(-1).source === 'jsonl' && answers.at(-1).status === 'complete' && snapshot.status === 'idle';
  }, { sid, count: expectedCount }, { timeout: 180000 });
  const final = await page.evaluate(() => window.__snapshot);
  const answers = final.messages.filter(message => message.role === 'assistant');
  const users = final.messages.filter(message => message.role === 'user');
  assert.equal(answers.length, expectedCount); assert.equal(users.length, expectedCount);
  assert.equal(users.at(-1).text, scenario.prompt);
  const answer = answers.at(-1), validation = validateNativeAnswer(scenario, answer, final);
  for (const previous of report.turns) assert.deepEqual(answers.find(message => message.id === previous.answer.id), previous.answer);
  const previews = await page.evaluate(({ sid, index }) => window.__snapshots.filter(snapshot => snapshot.sessionId === sid)
    .map(snapshot => snapshot.messages.filter(message => message.role === 'assistant')[index])
    .filter(message => message?.source === 'preview' && message.text.trim()), { sid, index: expectedCount - 1 });
  for (const preview of previews) assert.equal(preview.id, answer.id, 'Observed preview must reconcile into the same bubble');
  report.turns.push({ scenario, model, answer, validation, inherited: false, previewObserved: previews.length > 0,
    previewFrames: previews.length, previewLengths: [...new Set(previews.map(message => message.text.length))] });
  await page.screenshot({ path: path.join(root, `dialogue-${expectedCount}.png`) });
  await checkpoint(`dialogue-${expectedCount}-canonical`);
}
async function saveTranscript() {
  const raw = await remote(`cat ${q(source.transcriptPath)}`, true);
  await writeFile(path.join(root, 'remote-transcript.jsonl'), raw);
  report.transcriptPath = source.transcriptPath;
  report.transcript = { bytes: raw.length, sha256: hash(raw) };
  const records = recordsOf(raw), assistants = uniqueAssistants(records);
  assert.ok(assistantRecords(records).every(record => typeof record.message?.model === 'string'
    && /haiku|sonnet/i.test(record.message.model) && !/opus/i.test(record.message.model)), 'Every actual assistant record must identify an allowed model');
  report.requestedModels = [...new Set(assistantRecords(records).map(record => record.message?.model).filter(Boolean))];
  assert.ok(report.requestedModels.every(model => /haiku|sonnet/i.test(model) && !/opus/i.test(model)));
  assert.equal(assistantRecords(records).flatMap(record => Array.isArray(record.message?.content) ? record.message.content : []).filter(block => block.type === 'tool_use').length, 0);
  return { records, assistants };
}

try {
  report.initialPanes = await inventory();
  const remoteInitial = await remote(`cat ${q(source.transcriptPath)}`, true);
  assert.deepEqual(uniqueAssistants(recordsOf(remoteInitial)).map(textOf), originalAssistants.map(textOf), 'No new answer may have arrived since the source run');
  report.sourceEvidence.remoteInitialDigest = { bytes: remoteInitial.length, sha256: hash(remoteInitial) };
  app = await _electron.launch({ args: ['.'], env, timeout: 60000 });
  page = await app.firstWindow(); page.setDefaultTimeout(45000); page.on('pageerror', error => errors.push(String(error)));
  await page.waitForFunction(() => !!window.desktop);
  await page.evaluate(() => { window.__snapshots = []; window.desktop.onSnapshot(snapshot => { window.__snapshot = snapshot; window.__snapshots.push(snapshot); }); });
  // Add the machine (saving a new machine closes the settings dialog), then the folder on it.
  await page.getByRole('button', { name: '添加 SSH 机器', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.getByLabel('SSH 主机', { exact: true }).fill(host);
  await settings.getByRole('button', { name: '保存连接' }).click();
  await settings.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: `在 ${host} 添加项目文件夹`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加项目文件夹' }), folderName = `${host} · 继续验证`;
  await dialog.getByLabel('名称', { exact: true }).fill(folderName);
  await dialog.getByLabel('工作目录', { exact: true }).fill(cwd);
  await dialog.getByRole('button', { name: '添加目录', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const saved = await page.evaluate(() => window.desktop.listWorkspaces());
  workspaceId = saved.find(workspace => workspace.kind === 'ssh' && workspace.host === host && workspace.cwd === cwd)?.id;
  assert.ok(workspaceId);
  // Expand the folder in the sidebar (the toggle, not the name: clicking the name opens a draft).
  // A newly added folder lists no saved conversations until "扫描所有对话".
  const folder = page.locator(`.workspace-row[data-workspace-id="${workspaceId}"] .workspace-toggle`);
  if (await folder.getAttribute('aria-expanded') !== 'true') await folder.click();
  await page.getByRole('group', { name: `${folderName} 的会话`, exact: true }).getByRole('button', { name: '扫描所有对话', exact: true }).click();
  const sourceRow = page.locator(`.session-row[data-workspace-id="${workspaceId}"][data-session-id="${sid}"]`);
  await sourceRow.waitFor();
  const discovery = await page.evaluate(id => window.desktop.discover(id), workspaceId);
  const history = discovery.sessions.find(session => session.id === sid);
  assert.ok(history?.path && !history.paneId, 'The source UUID must be an inactive history, not another active terminal');
  await sourceRow.click();
  await page.waitForFunction(sid => window.__snapshot?.sessionId === sid && window.__snapshot.status === 'idle' && !window.__snapshot.paneId, sid);
  const initial = await page.evaluate(() => window.__snapshot);
  assert.equal(initial.messages.length, 2 * originalCount);
  for (let index = 0; index < originalCount; index++) {
    const scenario = selectNativeScenario('native', 3 + index, ''), answer = initial.messages[index * 2 + 1];
    assert.equal(initial.messages[index * 2].text, scenario.prompt);
    assert.equal(answer.text, textOf(originalAssistants[index]));
    const rawUser = sourceRecords.find(record => record.type === 'user' && textOf(record) === scenario.prompt);
    assert.equal(answer.timestamp, rawUser.timestamp ?? originalAssistants[index].timestamp, 'Canonical turn time comes from the same source record on every load');
    const previous = source.turns?.find(turn => turn.scenario.id === scenario.id);
    if (previous) assert.equal(answer.id, previous.answer.id);
    report.turns.push({ scenario, model: originalAssistants[index].message.model, answer,
      validation: validateNativeAnswer(scenario, answer, initial), inherited: true, sourceReport: sourcePath,
      sourcePresentationTimestamp: previous?.answer.timestamp, timestampNormalized: !!previous && previous.answer.timestamp !== answer.timestamp,
      previewObserved: null, note: 'Completed in a source run; this request was not sent again.' });
  }
  await checkpoint(`source-${originalCount}-turn-history-verified`);
  let active = await resume(initial.messages, `inherited-${originalCount}-turn-uuid-resumed`);
  let sonnet = await choose('model', option => /sonnet/i.test(option.label) && !/opus|default/i.test(option.label));
  const effort = await menu('effort'), alternative = effort.options.find(option => !option.current);
  assert.ok(alternative); await choose('effort', option => option.label === alternative.label);
  for (let index = originalCount; index < 3; index++) {
    if (index > originalCount) {
      active = await detachAndResume(active, await page.evaluate(() => window.__snapshot.messages), `${index}-turn-uuid-resumed`);
      sonnet = await choose('model', option => /sonnet/i.test(option.label) && !/opus|default/i.test(option.label));
    }
    await dialogue(3 + index, sonnet);
  }
  // Reopen after the last live reply too: this catches any optimistic/canonical
  // timestamp discrepancy without relaxing the all-fields equality assertion.
  await detachAndResume(active, await page.evaluate(() => window.__snapshot.messages), 'three-turn-final-timestamps-verified');
  const finalRaw = await saveTranscript();
  assert.equal(finalRaw.assistants.length, 3);
  assert.deepEqual(finalRaw.assistants.map(textOf), report.turns.map(turn => turn.answer.text), 'Raw JSONL independently agrees with all three displayed replies');
  for (const turn of report.turns) assert.equal(finalRaw.records.filter(record => record.type === 'user' && textOf(record) === turn.scenario.prompt).length, 1);
  assert.ok(report.requestedModels.some(model => /haiku/i.test(model)) && report.requestedModels.some(model => /sonnet/i.test(model)));
  assert.equal(report.requests, 3 - originalCount); report.totalConversationRequests = 3;
  report.diagnostics = await page.evaluate(() => window.desktop.diagnosticsInfo());
  assert.equal(report.diagnostics.droppedEvents, 0); assert.equal(report.diagnostics.lastError, undefined); assert.deepEqual(errors, []);
  report.success = true; await checkpoint('continuation-complete');
} catch (error) {
  report.error = String(error?.stack || error).slice(0, 18000); report.success = false; process.exitCode = 1;
  if (page) {
    await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
    await writeFile(path.join(root, 'failure-screen.txt'), await page.evaluate(() => window.__snapshot?.viewport || window.__snapshot?.screen || '').catch(() => ''));
    report.incidentId = await page.evaluate(note => window.desktop.markDiagnosticIncident(note), report.error.slice(0, 1800)).catch(() => undefined);
  }
} finally {
  if (!report.transcript) await saveTranscript().catch(error => { report.transcriptCaptureError = String(error); });
  for (const session of owned) await stopOwned(session).catch(() => {});
  await app?.close();
  const files = await readdir(path.join(root, 'diagnostics')).catch(() => []);
  const confirmations = [];
  for (const file of files.filter(name => /^events\.\d+\.jsonl$/.test(name))) {
    for (const line of (await readFile(path.join(root, 'diagnostics', file), 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      try { const entry = JSON.parse(line); if (entry.event === 'settings.cache_confirmation.accept' && entry.context?.sessionId === sid) confirmations.push({ seq: entry.seq, ...entry.data }); } catch {}
    }
  }
  report.cacheConfirmations = confirmations.sort((a, b) => a.seq - b.seq);
  if (report.success && !confirmations.length && !inheritedConfirmations.length) { report.success = false; report.error = 'No current or source evidence records the expected native cache-cost confirmation'; process.exitCode = 1; }
  report.finalPanes = await inventory().catch(() => []);
  if (JSON.stringify(report.initialPanes) !== JSON.stringify(report.finalPanes)) { report.success = false; report.paneInventoryChanged = true; process.exitCode = 1; }
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ root, success: report.success, newRequests: report.requests, sourceReport: sourcePath, error: report.error }, null, 2));
}
