// npm run build && node scripts/subagent-column-e2e.mjs [packaged-executable]
// The subagent column, offline: the demo's live mock session (real tmux, no
// model) gets synthetic records of two background subagents, one finished and
// one running, each with its own transcript under <session>/subagents/. The
// activity card opens the column; it lists both, shows the running one's
// conversation as it grows, the finished one's thinking, tools and report, and a
// SendMessage resume makes the finished one run again with its new messages,
// until interim notifications (waiting on its own background work) end that run.
// The list keeps running ones first, then ended ones, then an earlier one known only
// from its transcript; the one shown stays shown as it moves (screenshot: subagent-column-order.png).
// Then Claude Code 2.1.310+: twelve more subagents whose launch is on a page not loaded; opened
// again, all fifteen are listed with the states of their meta files (subagent-column-listed.png),
// meta changes end and resume them, and once the conversation is closed none of them runs
// (subagent-column-interrupted.png); a live process of the session outside Lectern's panes (its native
// record) makes them run again until it ends.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron, resizeWindow } from './fixtures/electron.mjs';

const results = path.resolve('test-results');
await mkdir(results, { recursive: true });
const userData = await mkdtemp(path.join(tmpdir(), 'lectern-subagents-profile-'));
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: userData, LECTERN_NODE_BINARY: process.execPath, LECTERN_DIAGNOSTIC_CONTENT: '0' };
delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL; delete env.TMUX; delete env.TMUX_PANE;
const exe = process.argv[2];
const done = 'ae2edone0000000001', live = 'ae2elive0000000002', earlier = 'ae2eold00000000003';
const at = offset => new Date(Date.now() - 120_000 + offset * 1000).toISOString();
// Folded thinking: a signature whose purpose field is empty (src/core/thinking.ts).
const signature = Buffer.from([0x12, 4, 0x0a, 2, 0x08, 1]).toString('base64');
let app;
try {
  app = await _electron.launch({ args: exe ? ['--demo'] : ['.', '--demo'], ...(exe && { executablePath: path.resolve(exe) }), env, timeout: 60_000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await resizeWindow(app, page, 1480, 940);
  await page.locator('.message-assistant').first().waitFor();
  await page.waitForFunction(() => document.querySelector('.session-row.active')?.getAttribute('data-session-live') === 'true');
  const sid = await page.locator('.session-row.active').getAttribute('data-session-id');
  const [workspace] = await page.evaluate(() => window.desktop.listWorkspaces());
  const project = path.join(await app.evaluate(() => process.env.CLAUDE_CONFIG_DIR), 'projects', workspace.cwd.replace(/[^a-zA-Z0-9-]/g, '-'));
  const main = path.join(project, `${sid}.jsonl`), subagents = path.join(project, sid, 'subagents');
  await mkdir(subagents, { recursive: true });

  // The main transcript: a turn that launches both in the background, then the first one's notification.
  let parent = [...(await readFile(main, 'utf8')).trim().split('\n')].map(line => JSON.parse(line)).filter(r => r.uuid).at(-1)?.uuid ?? null;
  const record = (type, fields, offset) => { const uuid = randomUUID(); const r = { type, uuid, parentUuid: parent, sessionId: sid, cwd: workspace.cwd, timestamp: at(offset), ...fields }; parent = uuid; return r; };
  const lines = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  const launch = (tool, agent, description) => record('user', { toolUseResult: { isAsync: true, status: 'async_launched', agentId: agent, description },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool, content: `Async agent launched successfully.\nagentId: ${agent}` }] } }, 3);
  const notice = `<task-notification>\n<task-id>${done}</task-id>\n<tool-use-id>toolu_e2e_done</tool-use-id>\n<status>completed</status>\n<summary>Agent "整理测试清单" completed</summary>\n<result>测试清单已整理。</result>\n</task-notification>`;
  await appendFile(main, lines([
    record('user', { origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: '请两个子代理分头检查项目' } }, 1),
    record('assistant', { message: { id: 'msg_e2e_launch', role: 'assistant', model: 'fixture', stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'toolu_e2e_done', name: 'Agent', input: { description: '整理测试清单', prompt: '列出项目里的测试脚本。', subagent_type: 'general-purpose', run_in_background: true } },
      { type: 'tool_use', id: 'toolu_e2e_live', name: 'Agent', input: { description: '检查构建脚本', prompt: '检查构建脚本是否可用。', subagent_type: 'Explore', run_in_background: true } }] } }, 2),
    launch('toolu_e2e_done', done, '整理测试清单'), launch('toolu_e2e_live', live, '检查构建脚本'),
    record('assistant', { message: { id: 'msg_e2e_started', role: 'assistant', model: 'fixture', stop_reason: 'end_turn', content: [{ type: 'text', text: '两个子代理已在后台运行。' }] } }, 4),
    { type: 'queue-operation', operation: 'enqueue', sessionId: sid, timestamp: at(40), content: notice },
    record('user', { origin: { kind: 'task-notification' }, promptSource: 'system', message: { role: 'user', content: notice } }, 40),
  ]));

  // Each subagent's own transcript, with the shapes Claude Code 2.1.300–2.1.330 write.
  const chain = agent => {
    let up = null, n = 0;
    return (type, message, extra = {}) => { const uuid = `${agent}-${++n}`; const r = { parentUuid: up, isSidechain: true, sessionId: sid, agentId: agent, type, uuid, timestamp: at(5 + n), message, ...extra }; up = uuid; return r; };
  };
  const doneRow = chain(done), liveRow = chain(live), earlierRow = chain(earlier);
  // An earlier subagent: its transcript only, launched in history not loaded (nor in this chat at all).
  await writeFile(path.join(subagents, `agent-${earlier}.meta.json`), JSON.stringify({ agentType: 'Explore', description: '早先的检查' }));
  await writeFile(path.join(subagents, `agent-${earlier}.jsonl`), lines([earlierRow('user', { role: 'user', content: '早先检查一遍。' }),
    earlierRow('assistant', { id: 'o1', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '检查完了。' }] })]));
  await writeFile(path.join(subagents, `agent-${done}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: '整理测试清单', toolUseId: 'toolu_e2e_done', finished: true }));
  await writeFile(path.join(subagents, `agent-${live}.meta.json`), JSON.stringify({ agentType: 'Explore', description: '检查构建脚本', toolUseId: 'toolu_e2e_live' }));
  await writeFile(path.join(subagents, `agent-${done}.jsonl`), lines([
    doneRow('user', { role: 'user', content: '列出项目里的测试脚本。' }),
    doneRow('assistant', { id: 'd1', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '先看 package.json 的 scripts。', signature }] }, { thinkingDurationMs: 3000 }),
    doneRow('assistant', { id: 'd1', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: '我先列出测试脚本。' }] }),
    doneRow('assistant', { id: 'd1', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_d_bash', name: 'Bash', input: { command: 'ls scripts', description: '列出脚本' } }] }),
    doneRow('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_d_bash', content: 'e2e.mjs\ntest-all.mjs' }] }, { toolUseResult: { stdout: 'e2e.mjs\ntest-all.mjs' } }),
    doneRow('assistant', { id: 'd2', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '测试清单：e2e.mjs 与 test-all.mjs。' }] }),
  ]));
  const liveFile = path.join(subagents, `agent-${live}.jsonl`);
  await writeFile(liveFile, lines([
    liveRow('user', { role: 'user', content: '检查构建脚本是否可用。' }),
    liveRow('assistant', { id: 'l1', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: '先看看构建脚本。' }] }),
    liveRow('assistant', { id: 'l1', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_l_read', name: 'Read', input: { file_path: path.join(workspace.cwd, 'build.sh') } }] }),
  ]));

  // The activity card: the subagent part lists both; "查看对话" opens the column on that one.
  const card = page.locator('.activity-float');
  /** Collapses the activity card before a screenshot. When it is already a pill there is no button,
   * and waiting for one would only run into the 20-second timeout. */
  const collapseCard = async () => {
    const collapse = page.locator('.activity-float-anchor button[aria-label="收起会话活动"]');
    if (await collapse.count()) await collapse.click().catch(() => {});
  };
  if (!await card.isVisible()) await page.locator('.activity-float-pill').click();
  const section = page.locator('.activity-float-section').filter({ has: page.locator('.activity-float-title', { hasText: '子代理' }) });
  await section.waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.activity-float-dots i[data-state]').length >= 2);
  await section.locator('.activity-float-toggle').click();
  const liveCard = page.locator(`article.activity-card[data-activity-id="toolu_e2e_live"]`);
  assert.equal(await liveCard.getAttribute('data-activity-state'), 'running');
  await liveCard.locator('.activity-open-conversation').click();
  const column = page.locator('[data-task-column]');
  await column.waitFor();
  assert.equal(await column.locator('.task-column-list button[aria-current="true"]').getAttribute('data-agent-id'), live);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-agent-id')), live, 'the column takes the focus on its subagent');
  // Running first, then ended, then the earlier one; each newest first by its latest start.
  const rows = () => column.locator('.task-column-list button[data-kind="agent"]').evaluateAll(rows => rows.map(row => [row.dataset.agentId, row.dataset.state]));
  await page.waitForFunction(id => document.querySelector(`.task-column-list button[data-agent-id="${id}"]`), earlier);
  assert.deepEqual(await rows(), [[live, 'running'], [done, 'completed'], [earlier, 'unobserved']]);
  assert.equal(await column.locator(`.task-column-list button[data-agent-id="${earlier}"] .task-state`).innerText(), '较早');
  const detail = column.locator(`[data-subagent-detail="${live}"]`);
  await detail.locator('article.message-user', { hasText: '检查构建脚本是否可用。' }).waitFor();
  await detail.locator('article.message-assistant', { hasText: '先看看构建脚本。' }).waitFor();
  assert.equal(await detail.locator('details.tool-block[data-tool-name="Read"]').getAttribute('data-tool-state'), 'pending');
  await detail.locator('.stream-label').waitFor();
  // It keeps running: new records appear in the column without reopening it.
  await appendFile(liveFile, lines([
    liveRow('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_l_read', content: '#!/bin/sh\nnpm run build' }] }),
    liveRow('assistant', { id: 'l2', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: '构建脚本调用 npm run build，接着检查依赖。' }] }),
    liveRow('assistant', { id: 'l2', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_l_grep', name: 'Grep', input: { pattern: 'build', path: workspace.cwd } }] }),
  ]));
  await detail.locator('article.message-assistant', { hasText: '接着检查依赖' }).waitFor();
  assert.equal(await detail.locator('details.tool-block[data-tool-name="Read"]').getAttribute('data-tool-state'), 'completed');
  await collapseCard();
  await page.waitForTimeout(500); // messages fade in
  await page.screenshot({ path: path.join(results, 'subagent-column-running.png') });

  // The finished one: folded thinking, the tool with its result and the report.
  await column.locator(`.task-column-list button[data-agent-id="${done}"]`).click();
  const finished = column.locator(`[data-subagent-detail="${done}"]`);
  await finished.locator('article.message-assistant', { hasText: '测试清单：e2e.mjs 与 test-all.mjs。' }).waitFor();
  assert.equal(await finished.getAttribute('data-state'), 'completed');
  await finished.locator('details.thought-row[data-thought]').waitFor({ state: 'attached' });
  assert.equal(await finished.locator('.stream-label').count(), 0, 'a finished subagent is not replying');
  await finished.locator('details.tool-block[data-tool-name="Bash"]').evaluate(el => { for (let node = el; node; node = node.parentElement?.closest('details')) node.open = true; });
  assert.match(await finished.locator('details.tool-block[data-tool-name="Bash"] .tool-output').innerText(), /test-all\.mjs/);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(results, 'subagent-column-finished.png') });

  // SendMessage resumes it: running again, and its new messages show in its column.
  await appendFile(main, lines([
    record('user', { origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: '让测试清单子代理再补充一项' } }, 60),
    record('assistant', { message: { id: 'msg_e2e_send', role: 'assistant', model: 'fixture', stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'toolu_e2e_send', name: 'SendMessage', input: { to: done, summary: '补充', message: '再看看 scripts/cc-matrix。' } }] } }, 61),
    record('user', { toolUseResult: { success: true, message: `Resuming agent ${done.slice(0, 7)}`, resumedAgentId: done, revivedAgentId: done },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_e2e_send', content: `{"success":true,"message":"Resuming agent ${done.slice(0, 7)}"}` }] } }, 62),
  ]));
  await appendFile(path.join(subagents, `agent-${done}.jsonl`), lines([
    doneRow('user', { role: 'user', content: 'The coordinator sent a message while you were working:\n再看看 scripts/cc-matrix。\n\nAddress this before completing your current task.' }, { isMeta: true, origin: { kind: 'coordinator' } }),
    doneRow('assistant', { id: 'd3', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: 'cc-matrix 里还有 run.mjs。' }] }),
  ]));
  await page.waitForFunction(id => document.querySelector(`.task-column-list button[data-agent-id="${id}"]`)?.dataset.state === 'running', done);
  // Its latest run began after the other one's launch: it moves to the top, still shown.
  assert.deepEqual(await rows(), [[done, 'running'], [live, 'running'], [earlier, 'unobserved']]);
  const current = () => column.locator('.task-column-list button[aria-current="true"]').getAttribute('data-agent-id');
  assert.equal(await current(), done, 'the one shown stays shown when it moves');
  // The activity card lists its subagents in the same order.
  const cardRows = async () => {
    if (!await card.isVisible()) await page.locator('.activity-float-pill').click();
    if (!await section.locator('article.activity-card').count()) await section.locator('.activity-float-toggle').click();
    return section.locator('article.activity-card').evaluateAll(cards => cards.map(card => [card.dataset.activityId, card.dataset.activityState]));
  };
  assert.deepEqual(await cardRows(), [['toolu_e2e_done', 'running'], ['toolu_e2e_live', 'running']]);
  await finished.locator('article.message-user', { hasText: '再看看 scripts/cc-matrix。' }).waitFor();
  await finished.locator('article.message-assistant', { hasText: 'cc-matrix 里还有 run.mjs。' }).waitFor();
  assert.equal(await finished.getAttribute('data-state'), 'running');
  assert.equal(await finished.locator('article.message-user', { hasText: 'The coordinator sent' }).count(), 0, 'the native wrapper is not shown');

  // The resumed run stops while its own background work runs (Claude Code 2.1.329):
  // only interim notifications follow, and its meta file says finished. It has ended.
  const waiting = tool => `<task-notification>\n<task-id>${done}</task-id>\n${tool ? `<tool-use-id>${tool}</tool-use-id>\n` : ''}<status>completed</status>\n<summary>Agent "整理测试清单" is waiting on its own background work</summary>\n<note>This agent stopped with background work of its own still running. It may resume on its own when that work completes or reports, and the same task-id notifies again if it does; the result below may be interim.</note>\n<result>补充完毕。</result>\n</task-notification>`;
  await writeFile(path.join(subagents, `agent-${done}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: '整理测试清单', toolUseId: 'toolu_e2e_done', finished: true }));
  await appendFile(main, lines([
    { type: 'queue-operation', operation: 'enqueue', sessionId: sid, timestamp: at(70), content: waiting('toolu_e2e_send') },
    { type: 'queue-operation', operation: 'enqueue', sessionId: sid, timestamp: at(71), content: waiting() },
    record('user', { origin: { kind: 'task-notification' }, promptSource: 'system', message: { role: 'user', content: waiting('toolu_e2e_send') } }, 72),
  ]));
  await page.waitForFunction(id => document.querySelector(`.task-column-list button[data-agent-id="${id}"]`)?.dataset.state === 'completed', done);
  assert.equal(await finished.getAttribute('data-state'), 'completed');
  // Ended again: below the running one and above the earlier one, still shown; the card follows.
  assert.deepEqual(await rows(), [[live, 'running'], [done, 'completed'], [earlier, 'unobserved']]);
  assert.equal(await current(), done);
  assert.deepEqual(await cardRows(), [['toolu_e2e_live', 'running'], ['toolu_e2e_done', 'completed']]);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(results, 'subagent-column-order.png') });
  await collapseCard();
  const facts = await finished.locator('.subagent-detail-head small').innerText();
  assert.match(facts, /已续接 1 次/);
  await page.waitForTimeout(1500);
  assert.equal(await finished.locator('.subagent-detail-head small').innerText(), facts, 'an ended run no longer counts time');
  assert.match(await column.locator('.task-column-bar .activity-tally').innerText(), /1 运行中 · 1 完成/);

  // Closing the column leaves the chat as it was.
  await column.locator('.task-column-bar button').click();
  await column.waitFor({ state: 'detached' });

  // Claude Code 2.1.310+ (records carry the version; meta files have isBuiltIn and `finished`):
  // twelve more subagents, launched in a turn that more than a page of later turns pushes out
  // of the first page. Opened again, the card and the column list all fifteen with the states
  // their meta files give, without loading older pages; nothing is "earlier".
  const many = Array.from({ length: 12 }, (_, i) => `ae2emeta${String(i).padStart(10, '0')}`);
  const v = { version: '2.1.330' };
  const metaFile = (agent, fields) => writeFile(path.join(subagents, `agent-${agent}.meta.json`),
    JSON.stringify({ agentType: 'general-purpose', isBuiltIn: true, spawnDepth: 1, requestShape: 'background', ...fields }));
  await appendFile(main, lines([
    record('user', { ...v, origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: '请十二个子代理分头检查各个目录' } }, 80),
    record('assistant', { ...v, message: { id: 'msg_e2e_many', role: 'assistant', model: 'fixture', stop_reason: 'tool_use', content: many.map((agent, i) =>
      ({ type: 'tool_use', id: `toolu_e2e_many${i}`, name: 'Agent', input: { description: `检查目录 ${i}`, prompt: `检查第 ${i} 个目录。`, subagent_type: 'general-purpose', run_in_background: true } })) } }, 81),
    ...many.map((agent, i) => record('user', { ...v, toolUseResult: { isAsync: true, status: 'async_launched', agentId: agent, description: `检查目录 ${i}` },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_e2e_many${i}`, content: `Async agent launched successfully.\nagentId: ${agent}` }] } }, 82)),
    // More than the first page (128 KiB) of later turns.
    ...Array.from({ length: 60 }, (_, i) => [
      record('user', { ...v, origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: `Filler question ${i}` } }, 83),
      record('assistant', { ...v, message: { id: `msg_e2e_filler${i}`, role: 'assistant', model: 'fixture', stop_reason: 'end_turn', content: [{ type: 'text', text: `Filler answer ${i}. ` + 'lorem ipsum '.repeat(250) }] } }, 83)]).flat(),
  ]));
  for (const [i, agent] of many.entries()) {
    const row = chain(agent);
    await writeFile(path.join(subagents, `agent-${agent}.jsonl`), lines([{ ...row('user', { role: 'user', content: `检查第 ${i} 个目录。` }), timestamp: at(81 + i) }]));
    // Seven ended (one stopped by the user), five still running.
    await metaFile(agent, { description: `检查目录 ${i}`, toolUseId: `toolu_e2e_many${i}`, ...(i < 7 && { finished: true }), ...(i === 6 && { stoppedByUser: true }) });
  }
  await metaFile(done, { description: '整理测试清单', toolUseId: 'toolu_e2e_done', finished: true });
  await metaFile(live, { description: '检查构建脚本', toolUseId: 'toolu_e2e_live' });
  await metaFile(earlier, { agentType: 'Explore', description: '早先的检查', finished: true });
  await page.reload();
  await page.locator('.message-assistant', { hasText: 'Filler answer 59' }).waitFor();
  await page.waitForFunction(() => document.querySelector('.session-row.active')?.getAttribute('data-session-live') === 'true');
  const expected = [...many.slice(7).reverse().map(agent => [agent, 'running']), [live, 'running'], [many[6], 'stopped'],
    ...many.slice(0, 6).reverse().map(agent => [agent, 'completed']), [done, 'completed'], [earlier, 'completed']];
  if (!await card.isVisible()) await page.locator('.activity-float-pill').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.activity-float-title')].some(title => title.textContent === '子代理'));
  await page.waitForFunction(() => [...document.querySelectorAll('.activity-float-section')].some(part => /6 运行中 · 9 完成/.test(part.textContent)));
  assert.equal(await page.locator('.message-user', { hasText: '请十二个子代理分头检查各个目录' }).count(), 0, 'their launch is on a page not loaded');
  await section.locator('.activity-float-toggle').click();
  assert.deepEqual(await cardRows(), expected.map(([agent, state]) => [agent === done ? 'toolu_e2e_done' : agent === live ? 'toolu_e2e_live' : agent === earlier ? `agent:${earlier}`
    : `toolu_e2e_many${many.indexOf(agent)}`, state]), 'the card lists them all, running first, newest first');
  await section.locator('.activity-open-conversation').first().click();
  await column.waitFor();
  assert.deepEqual(await rows(), expected, 'the column lists the same');
  assert.deepEqual(await column.locator('.task-column-list .task-state').allInnerTexts(), expected.map(([, state]) => ({ running: '运行中', stopped: '已停止', completed: '已完成' })[state]));
  assert.equal(await page.locator('.message-user', { hasText: '请十二个子代理分头检查各个目录' }).count(), 0, 'still not loaded');
  await collapseCard();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(results, 'subagent-column-listed.png') });
  // Only the meta files change: one ends, an ended one is resumed (finished cleared).
  await metaFile(many[7], { description: '检查目录 7', toolUseId: 'toolu_e2e_many7', finished: true });
  await page.waitForFunction(id => document.querySelector(`.task-column-list button[data-agent-id="${id}"]`)?.dataset.state === 'completed', many[7]);
  await metaFile(many[0], { description: '检查目录 0', toolUseId: 'toolu_e2e_many0', revivedAt: Date.now() });
  await page.waitForFunction(id => document.querySelector(`.task-column-list button[data-agent-id="${id}"]`)?.dataset.state === 'running', many[0]);
  assert.deepEqual((await rows())[0], [many[0], 'running'], 'resumed last: first');
  // The title bar and the sidebar count the same six running subagents.
  await page.waitForFunction(() => /6 个子代理/.test(document.querySelector('.connection-status')?.getAttribute('title') ?? ''));
  assert.match(await column.locator('.task-group[data-kind="agent"] .activity-tally').innerText(), /6 运行中 · 9 完成/);
  // The process goes (the conversation is closed): none of them runs any more.
  await page.getByRole('button', { name: '关闭当前对话', exact: true }).click();
  const confirm = page.locator('dialog.confirm-action[open]');
  assert.match(await confirm.innerText(), /6 个子代理/);
  await confirm.getByRole('button', { name: '关闭对话', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.session-row.active')?.getAttribute('data-session-live') === 'false', null, { timeout: 30_000 });
  if (!await column.isVisible()) {
    if (!await card.isVisible()) await page.locator('.activity-float-pill').click();
    await section.locator('.activity-open-conversation').first().click();
  }
  await page.waitForFunction(() => !document.querySelector('.task-column-list button[data-kind="agent"][data-state="running"]'));
  const interrupted = (await rows()).filter(([, state]) => state === 'interrupted').map(([agent]) => agent).sort();
  assert.deepEqual(interrupted, [live, many[0], ...many.slice(8)].sort(), 'those that ran are interrupted');
  assert.match(await column.locator('.task-group[data-kind="agent"] .activity-tally').innerText(), /^15 结束（6 中断）$/);
  assert.equal(await page.locator('.connection-status').getAttribute('title'), null, 'no longer running in the background');
  await column.locator(`.task-column-list button[data-agent-id="${live}"]`).click();
  assert.equal(await column.locator(`[data-subagent-detail="${live}"] .subagent-detail-state`).innerText(), '已中断');
  // Its last call never got a result and never will: interrupted, not in progress.
  const leftOver = column.locator(`[data-subagent-detail="${live}"] details.tool-block[data-tool-name="Grep"]`);
  await page.waitForFunction(id => document.querySelector(`[data-subagent-detail="${id}"] details.tool-block[data-tool-name="Grep"]`)?.dataset.toolState === 'interrupted', live);
  assert.equal(await leftOver.locator('summary .tool-state').innerText(), '已中断');
  assert.equal(await column.locator(`[data-subagent-detail="${live}"] [data-tool-state="pending"]`).count(), 0);
  await collapseCard();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(results, 'subagent-column-interrupted.png') });
  // The session runs on outside Lectern's panes (a terminal of its own): its native record names a live
  // process (here a stand-in with the record Claude Code would write). Running again; interrupted once it ends.
  const outside = spawn('sleep', ['300'], { stdio: 'ignore' });
  try {
    const start = process.platform === 'linux' ? (await readFile(`/proc/${outside.pid}/stat`, 'utf8')).replace(/^.*\) /s, '').split(' ')[19]
      : execFileSync('ps', ['-p', String(outside.pid), '-o', 'lstart='], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).toString().trim();
    await mkdir(path.join(await app.evaluate(() => process.env.CLAUDE_CONFIG_DIR), 'sessions'), { recursive: true });
    await writeFile(path.join(await app.evaluate(() => process.env.CLAUDE_CONFIG_DIR), 'sessions', `${outside.pid}.json`), JSON.stringify({ pid: outside.pid, sessionId: sid, cwd: workspace.cwd,
      procStart: start, startedAt: Date.now() - 600_000, kind: 'interactive', entrypoint: 'cli', status: 'busy' }));
    await page.waitForFunction(id => document.querySelector(`.task-column-list button[data-agent-id="${id}"]`)?.dataset.state === 'running', live, { timeout: 30_000 });
    assert.deepEqual((await rows()).filter(([, state]) => state === 'running').map(([agent]) => agent).sort(), interrupted, 'the same ones run again');
    assert.equal(await page.locator('.session-row.active').getAttribute('data-session-live'), 'false', 'not a Lectern pane');
  } finally { outside.kill(); }
  await page.waitForFunction(id => document.querySelector(`.task-column-list button[data-agent-id="${id}"]`)?.dataset.state === 'interrupted', live, { timeout: 30_000 });
  assert.equal(await page.locator('.task-column-list button[data-kind="agent"][data-state="running"]').count(), 0, 'its process ended: none runs');
  assert.deepEqual(errors, []);
  console.log('PASS: the activity card opens the subagent column; it follows a running subagent live, shows a finished one with thinking, tools and report, a resumed one runs again with its new messages, and interim notifications end that run.');
  console.log('PASS (2.1.310+): opened again, all fifteen subagents are listed with their meta-file states without older pages; meta changes end and resume them; closing the conversation leaves none running.');
  console.log(`Screenshots: ${['running', 'finished', 'order', 'listed', 'interrupted'].map(name => path.join(results, `subagent-column-${name}.png`)).join(', ')}`);
} catch (error) {
  const page = app?.windows()[0];
  if (page) await page.screenshot({ path: path.join(results, 'subagent-column-failure.png') }).catch(() => {});
  throw error;
} finally {
  await app?.close();
  await rm(userData, { recursive: true, force: true });
}
