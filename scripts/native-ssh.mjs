// Opt-in real SSH/TUI integration. Installs nothing; only test-owned tmux panes
// receive input. Model requests are restricted to observed Haiku/Sonnet choices.
import assert from 'node:assert/strict';
import { _electron } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { selectNativeScenario, validateNativeAnswer } from './native-dialogue.mjs';

const exec = promisify(execFile), host = process.env.LECTERN_SSH_HOST;
assert.ok(host, 'Set LECTERN_SSH_HOST to an SSH alias for the test machine');
assert.match(host, /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9_][A-Za-z0-9_.-]*$/);
const q = value => `'${value.replace(/'/g, `'"'"'`)}'`;
const remote = async command => (await exec('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', host, `sh -c ${q(command)}`], { timeout: 30000, maxBuffer: 24 * 1024 * 1024 })).stdout;
const root = path.resolve('test-results', `native-ssh-${Date.now()}`);
await mkdir(root, { recursive: true });
const cwd = (await remote('mktemp -d /tmp/lectern-ssh-XXXXXX')).trim();
assert.match(cwd, /^\/tmp\/lectern-ssh-[A-Za-z0-9]+$/);
const scenarioOffset = Number(process.env.LECTERN_SSH_SCENARIO_OFFSET ?? Date.now() % 4);
assert.ok(Number.isSafeInteger(scenarioOffset) && scenarioOffset >= 0);
const report = { success: false, host, cwd, root, scenarioOffset, requests: 0, phases: [], history: {}, settings: [], turns: [], resume: {} };
const owned = [], workspaceId = 'ssh-scratch', workspaceName = `${host} · SSH 验证`;
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: path.join(root, 'profile'), LECTERN_LOG_DIR: path.join(root, 'diagnostics'), LECTERN_DIAGNOSTIC_CONTENT: '1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL;
let app, page;
const digest = value => createHash('sha256').update(value).digest('hex');
async function checkpoint(phase) {
  report.phases.push({ phase, at: new Date().toISOString() });
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ phase, root, requests: report.requests }));
}
async function paneIdentity(paneId) {
  return (await remote(`tmux display-message -p -t ${q(paneId)} '#{pane_id}|#{session_name}|#{@lectern_session_id}'`).catch(() => '')).trim().split('|');
}
async function stopOwned(session) {
  const [pane, name, sid] = await paneIdentity(session.paneId);
  if (pane === session.paneId && sid === session.sessionId && name.startsWith(`lectern-${sid.slice(0, 8)}-`)) await remote(`tmux kill-pane -t ${q(pane)}`);
}
async function newSession() {
  const previous = await page.evaluate(() => window.__snapshot?.sessionId);
  await page.getByRole('button', { name: `在 ${workspaceName} 新建对话`, exact: true }).click();
  await page.waitForFunction(({ id, previous }) => window.__snapshot?.workspaceId === id && window.__snapshot.paneId && window.__snapshot.sessionId !== previous, { id: workspaceId, previous });
  const s = await page.evaluate(() => window.__snapshot); owned.push(s); return s;
}
async function waitReady(sid) {
  await page.waitForFunction(sid => window.__snapshot?.sessionId === sid && window.__snapshot.navigationStatus === 'idle' && window.__snapshot.status === 'idle' && !window.__snapshot.settingBusy && !window.__snapshot.trustBusy, sid, { timeout: 60000 });
  await page.getByRole('textbox', { name: '发送给 Claude 的消息' }).waitFor();
}
async function menu(sid, kind) {
  await waitReady(sid);
  return page.evaluate(({ workspaceId, sid, kind }) => window.desktop.getSessionSetting(workspaceId, sid, kind), { workspaceId, sid, kind });
}
async function choose(sid, kind, matches) {
  const observed = await menu(sid, kind);
  assert.equal(observed.complete, true, `Complete native ${kind} choices required`);
  const option = observed.options.find(matches);
  assert.ok(option, `Required ${kind} choice is missing: ${observed.options.map(o => o.label).join(', ')}`);
  if (kind === 'model') assert.ok(/(?:haiku|sonnet)/i.test(option.label) && !/opus|default/i.test(option.label), 'Never commit an Opus or ambiguous Default choice');
  if (!option.current) {
    await waitReady(sid);
    await page.locator(`button[data-setting-kind="${kind}"]`).click();
    const uiMenu = page.locator(`[data-setting-menu="${kind}"]`);
    await uiMenu.getByRole('option').filter({ has: page.getByText(option.label, { exact: true }) }).click({ timeout: 120000 });
    await uiMenu.waitFor({ state: 'hidden', timeout: 120000 });
    assert.ok((await page.locator(`button[data-setting-kind="${kind}"]`).innerText()).includes(option.label), 'GUI displays the verified native selection');
  }
  const applied = option.current ? observed : await menu(sid, kind);
  assert.equal(applied.options.find(o => o.current)?.label, option.label);
  report.settings.push({ kind, options: observed.options.map(o => ({ label: o.label, current: o.current, description: o.description })), selected: option.label, verified: true });
  await checkpoint(`${kind}: ${option.label}`);
  return option.label;
}
async function dialogue(sid, index, model) {
  await waitReady(sid);
  const before = await page.evaluate(() => window.__snapshot);
  const scenario = selectNativeScenario('native', index + scenarioOffset, '');
  const input = page.getByRole('textbox', { name: '发送给 Claude 的消息' });
  await input.fill(scenario.prompt);
  await page.getByRole('button', { name: '发送消息', exact: true }).click(); report.requests++;
  await checkpoint(`dialogue-${index + 1}-sent`);
  await page.waitForFunction(({ sid, count }) => {
    const s = window.__snapshot;
    if (s?.sessionId !== sid || s.settingBusy) return false;
    if (['error', 'offline', 'waiting'].includes(s.status)) return true;
    const answers = s.messages.filter(m => m.role === 'assistant');
    return answers.length === count + 1 && answers.at(-1).source === 'jsonl' && answers.at(-1).status === 'complete' && s.status === 'idle';
  }, { sid, count: before.messages.filter(m => m.role === 'assistant').length }, { timeout: 180000 });
  const final = await page.evaluate(() => window.__snapshot);
  const answers = final.messages.filter(m => m.role === 'assistant');
  assert.equal(answers.length, index + 1, 'Exactly one assistant bubble per native reply');
  assert.equal(final.messages.filter(m => m.role === 'user').length, index + 1);
  const answer = answers.at(-1), validation = validateNativeAnswer(scenario, answer, final);
  for (const previous of report.turns) assert.deepEqual(answers.find(a => a.id === previous.answer.id), previous.answer, 'Completed earlier answers survive later turns/resume');
  const snapshots = await page.evaluate(sid => window.__snapshots.filter(s => s.sessionId === sid), sid);
  const previews = snapshots.map(s => s.messages.filter(m => m.role === 'assistant')[index]).filter(m => m?.source === 'preview' && m.text.trim());
  for (const preview of previews) assert.equal(preview.id, answer.id, 'Every observed preview reconciles in place, never into a new bubble');
  report.turns.push({ scenario, model, answer, validation, previewObserved: previews.length > 0, previewFrames: previews.length, previewLengths: [...new Set(previews.map(m => m.text.length))] });
  // A short reply may be persisted before the next capture. Record that honestly
  // instead of failing and resending a real model request merely to see a preview.
  await page.screenshot({ path: path.join(root, `dialogue-${index + 1}.png`) });
  await checkpoint(`dialogue-${index + 1}-canonical`);
}
try {
  report.initialPanes = (await remote(`tmux list-panes -a -F '#{pane_id}|#{session_name}|#{@lectern_session_id}|#{pane_current_command}'`)).trim().split('\n');
  app = await _electron.launch({ args: ['.'], env, timeout: 60000 });
  page = await app.firstWindow(); page.setDefaultTimeout(45000);
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  await page.waitForFunction(() => !!window.desktop);
  const scan = await page.evaluate(host => window.desktop.discoverHistoryProjects({ kind: 'ssh', host }), host);
  report.history.scan = scan;
  assert.ok(scan.projects.some(p => p.exists && p.sessionCount > 0), 'Discover pre-existing remote histories');
  await page.evaluate(async ({ host, cwd, workspaceId, workspaceName }) => {
    await window.desktop.saveWorkspace({ id: workspaceId, name: workspaceName, kind: 'ssh', host, cwd });
  }, { host, cwd, workspaceId, workspaceName });
  await page.reload(); await page.waitForFunction(() => !!window.desktop);
  await page.evaluate(() => {
    window.__snapshots = [];
    window.desktop.onSnapshot(value => { window.__snapshot = value; window.__snapshots.push(value); });
  });
  // 测试选择已有样本；客户端只通过明确添加的文件夹读取历史。
  for (const project of scan.projects.filter(p => p.exists && p.cwd !== cwd)) {
    await page.getByRole('button', { name: `在 ${host} 添加项目文件夹`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '添加项目文件夹', exact: true });
    await dialog.getByLabel('工作目录', { exact: true }).fill(project.cwd);
    await dialog.getByRole('button', { name: '添加目录', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  }
  await page.screenshot({ path: path.join(root, 'remote-project-folders.png') });
  const imported = await page.evaluate(() => window.desktop.listWorkspaces());
  assert.ok(imported.every(w => w.kind === 'ssh' && w.host === host && !w.claudeDir));
  report.history.importedThroughUI = true;
  report.history.projects = [];
  for (const [i, project] of scan.projects.entries()) {
    if (!project.exists) continue;
    const id = imported.find(w => w.cwd === project.cwd)?.id;
    assert.ok(id, 'Remote history directory imported through GUI');
    const discovery = await page.evaluate(id => window.desktop.discover(id), id);
    assert.equal(discovery.sessions.filter(s => s.path).length, project.sessionCount);
    assert.ok(discovery.sessions.every(s => !s.paneId), 'Pre-existing non-Claude tmux panes must not bind to matching-directory histories');
    report.history.projects.push({ workspaceId: id, cwd: project.cwd, sessions: discovery.sessions.map(s => ({ id: s.id, status: s.status, mapping: s.mapping, path: s.path })), panes: discovery.panes });
  }
  const originalProject = report.history.projects.find(p => !p.cwd.startsWith('/tmp/lectern-ssh-'));
  assert.ok(originalProject, 'Use an original user history, not a previous test artifact');
  const sample = originalProject.sessions.find(s => s.path);
  const beforeHash = digest(await remote(`cat ${q(sample.path)}`));
  await page.evaluate(({ id, sid }) => window.desktop.watchSession(id, sid), { id: originalProject.workspaceId, sid: sample.id });
  await page.waitForFunction(sid => window.__snapshot?.sessionId === sid && window.__snapshot.status === 'idle' && !window.__snapshot.paneId, sample.id);
  const historySnapshot = await page.evaluate(() => window.__snapshot);
  assert.equal(historySnapshot.paneId, undefined);
  assert.ok(historySnapshot.messages.length > 0);
  await page.evaluate(() => window.desktop.unwatchSession());
  assert.equal(digest(await remote(`cat ${q(sample.path)}`)), beforeHash, 'Reading existing history leaves remote JSONL unchanged');
  report.history.readOnlySample = { sessionId: sample.id, messages: historySnapshot.messages.length, sha256: beforeHash, unchanged: true };
  await checkpoint('history-discovered-and-read');

  // Resume one pre-existing, inactive user conversation without sending any
  // model request, then release only the newly created exact-bound pane.
  const folder = page.locator(`.workspace-row[data-workspace-id="${originalProject.workspaceId}"] .workspace-select`);
  if (await folder.getAttribute('aria-expanded') !== 'true') await folder.click();
  await page.locator(`.session-row[data-workspace-id="${originalProject.workspaceId}"][data-session-id="${sample.id}"]`).click();
  await page.waitForFunction(sid => window.__snapshot?.sessionId === sid && !window.__snapshot.paneId, sample.id);
  await page.getByRole('button', { name: '续接会话', exact: true }).click();
  await page.waitForFunction(sid => window.__snapshot?.sessionId === sid && !!window.__snapshot.paneId, sample.id);
  const originalResumed = await page.evaluate(() => window.__snapshot); owned.push(originalResumed);
  await page.waitForFunction(() => window.__snapshot?.directoryTrust || (window.__snapshot?.navigationStatus === 'idle' && window.__snapshot?.status === 'idle'));
  if (await page.evaluate(() => !!window.__snapshot.directoryTrust)) {
    // This test never grants trust to an existing user project automatically.
    await page.locator('button[data-trust-decision="exit"]').click();
    report.history.originalResume = { sessionId: sample.id, directoryTrustRequired: true, newMessagesSent: 0 };
  } else {
    const resumed = await page.evaluate(() => window.__snapshot);
    assert.equal(digest(JSON.stringify(resumed.messages)), digest(JSON.stringify(historySnapshot.messages)), 'Original history must finish draining before canonical resume comparison');
    report.history.originalResume = { sessionId: sample.id, messages: resumed.messages.length, canonicalHistoryPreserved: true, newMessagesSent: 0 };
    await page.screenshot({ path: path.join(root, 'original-history-resumed.png') });
    await stopOwned(originalResumed);
  }
  const afterResumeHash = digest(await remote(`cat ${q(sample.path)}`));
  report.history.originalResume.sourceFileBytesUnchanged = afterResumeHash === beforeHash;
  report.history.originalResume.afterResumeSha256 = afterResumeHash;
  await checkpoint('original-history-resume-checked');

  const rejected = await newSession();
  await page.waitForFunction(() => !!window.__snapshot?.directoryTrust);
  const card = page.locator('section[aria-label="目录信任确认"]'); await card.waitFor();
  const trust = await page.evaluate(() => window.__snapshot.directoryTrust);
  assert.equal(trust.cwd, cwd);
  assert.equal(await page.getByRole('textbox', { name: '发送给 Claude 的消息' }).isDisabled(), true);
  await writeFile(path.join(root, 'trust-viewport.txt'), await page.evaluate(() => window.__snapshot.viewport));
  await page.screenshot({ path: path.join(root, 'trust-confirmation.png') });
  await card.locator('button[data-trust-decision="exit"]').click();
  await page.waitForFunction(() => !document.querySelector('section[aria-label="目录信任确认"]'));
  assert.notEqual((await paneIdentity(rejected.paneId))[0], rejected.paneId);
  const session = await newSession();
  report.sessionId = session.sessionId;
  await page.waitForFunction(() => !!window.__snapshot?.directoryTrust);
  await page.locator('button[data-trust-decision="trust"]').click();
  await waitReady(session.sessionId);
  report.trust = { cwd, rejectSessionId: rejected.sessionId, noExited: true, yesExplicit: true, noAutoAccept: true };
  await checkpoint('directory-trust-no-then-yes');

  const haiku = await choose(session.sessionId, 'model', o => /haiku/i.test(o.label) && !/opus|default/i.test(o.label));
  const effortBefore = await menu(session.sessionId, 'effort');
  const alternative = effortBefore.options.find(o => !o.current);
  assert.ok(alternative, 'Remote effort menu must offer a selectable alternative');
  await choose(session.sessionId, 'effort', o => o.label === alternative.label);
  await dialogue(session.sessionId, 0, haiku);
  const sonnet = await choose(session.sessionId, 'model', o => /sonnet/i.test(o.label) && !/opus|default/i.test(o.label));
  await choose(session.sessionId, 'effort', o => o.label !== alternative.label);
  await dialogue(session.sessionId, 1, sonnet);

  // Truly detach and reopen the original remote UUID with canonical history.
  const beforeResume = await page.evaluate(() => window.__snapshot);
  await stopOwned(session);
  await page.waitForFunction(() => !window.__snapshot?.paneId || window.__snapshot.status === 'offline');
  const inactive = await page.evaluate(id => window.desktop.discover(id), workspaceId);
  const archived = inactive.sessions.find(s => s.id === session.sessionId);
  assert.ok(archived?.path && !archived.paneId);
  await page.getByRole('button', { name: '续接会话', exact: true }).click();
  await page.waitForFunction(sid => window.__snapshot?.sessionId === sid && !!window.__snapshot.paneId, session.sessionId);
  const resumed = await page.evaluate(() => window.__snapshot); owned.push(resumed);
  // Some native versions reconfirm /tmp after process restart.
  await page.waitForFunction(() => window.__snapshot?.directoryTrust || window.__snapshot?.navigationStatus === 'idle');
  if (await page.locator('button[data-trust-decision="trust"]').count()) await page.locator('button[data-trust-decision="trust"]').click();
  await waitReady(session.sessionId);
  const afterResume = await page.evaluate(() => window.__snapshot);
  assert.deepEqual(afterResume.messages, beforeResume.messages, 'Resume preserves canonical UUIDs, text, ordering and tool state');
  report.resume = { originalSessionId: session.sessionId, resumedSessionId: afterResume.sessionId, oldPane: session.paneId, newPane: afterResume.paneId, canonicalHistoryPreserved: true, inactiveHistoryDiscovered: true };
  await page.screenshot({ path: path.join(root, 'resumed-history.png') });
  await checkpoint('remote-uuid-resumed');
  // Read /model again: session-only settings may not persist through a restart.
  const resumedModel = await choose(session.sessionId, 'model', o => /sonnet/i.test(o.label) && !/opus|default/i.test(o.label));
  await dialogue(session.sessionId, 2, resumedModel);

  const finalDiscovery = await page.evaluate(id => window.desktop.discover(id), workspaceId);
  report.transcriptPath = finalDiscovery.sessions.find(s => s.id === session.sessionId)?.path;
  assert.ok(report.transcriptPath);
  const raw = await remote(`cat ${q(report.transcriptPath)}`);
  await writeFile(path.join(root, 'remote-transcript.jsonl'), raw);
  report.transcript = { bytes: Buffer.byteLength(raw), sha256: digest(raw) };
  const records = raw.trim().split('\n').map(line => JSON.parse(line));
  report.requestedModels = [...new Set(records.filter(r => r.type === 'assistant').map(r => r.message?.model).filter(Boolean))];
  assert.ok(report.requestedModels.length >= 2 && report.requestedModels.every(model => /haiku|sonnet/i.test(model) && !/opus/i.test(model)));
  assert.deepEqual(errors, []);
  report.diagnostics = await page.evaluate(() => window.desktop.diagnosticsInfo());
  assert.equal(report.diagnostics.droppedEvents, 0); assert.equal(report.diagnostics.lastError, undefined);
  report.success = true;
  await checkpoint('complete');
} catch (error) {
  report.error = String(error?.stack || error).slice(0, 18000); process.exitCode = 1;
  if (page) {
    await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
    await writeFile(path.join(root, 'failure-screen.txt'), await page.evaluate(() => window.__snapshot?.viewport || window.__snapshot?.screen || '').catch(() => ''));
    report.incidentId = await page.evaluate(note => window.desktop.markDiagnosticIncident(note), report.error.slice(0, 1800)).catch(() => undefined);
  }
} finally {
  if (page) {
    const discovered = await page.evaluate(id => window.desktop.discover(id), workspaceId).catch(() => undefined);
    const transcriptPath = discovered?.sessions.find(s => s.id === report.sessionId)?.path;
    if (transcriptPath && !report.transcriptPath) {
      const raw = await remote(`cat ${q(transcriptPath)}`).catch(() => undefined);
      if (raw !== undefined) {
        await writeFile(path.join(root, 'remote-transcript.jsonl'), raw);
        report.transcriptPath = transcriptPath;
        report.transcript = { bytes: Buffer.byteLength(raw), sha256: digest(raw) };
        const records = raw.trim().split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
        report.requestedModels = [...new Set(records.filter(r => r.type === 'assistant').map(r => r.message?.model).filter(Boolean))];
      }
    }
    for (const pane of discovered?.panes || []) if (pane.cwd === cwd && pane.managed && pane.sessionId) owned.push({ paneId: pane.id, sessionId: pane.sessionId });
  }
  for (const session of owned) await stopOwned(session).catch(() => {});
  await app?.close();
  report.finalPanes = (await remote(`tmux list-panes -a -F '#{pane_id}|#{session_name}|#{@lectern_session_id}|#{pane_current_command}'`).catch(() => '')).trim().split('\n');
  if (JSON.stringify(report.initialPanes) !== JSON.stringify(report.finalPanes)) {
    report.paneInventoryChanged = true; report.success = false; process.exitCode = 1;
  }
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: path.join(root, 'report.json'), success: report.success, requests: report.requests, error: report.error?.slice(0, 3000) }, null, 2));
}
