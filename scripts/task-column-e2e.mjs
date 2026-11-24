// npm run build && node scripts/task-column-e2e.mjs [packaged-executable]
// The task column for background shells and monitors, offline: the demo's live mock
// session (real tmux, no model) gets synthetic records of two background shells and a
// monitor, with output files laid out as Claude Code 2.1.300–2.1.330 write them
// (<tmp>/claude-<uid>/<slug>/<session>/tasks/<task id>.output; CLAUDE_CODE_TMPDIR points
// <tmp> at a private folder). The activity card's "查看详情" opens the column: the full
// command and the output, appended while it runs; a shell that redirected into a file
// shows that file; a monitor shows its events; Chinese and English labels; light and dark.
// The activity card opens by itself only where it fits beside the conversation column, and
// every tally in its section headers and in the column shows whole, in one pane and in
// splits (screenshots: test-results/activity-card-*.png). The records carry Claude Code 2.1.330:
// the session's subagent folder lists three subagents launched before this transcript, which the
// card and the column show with the states of their meta files (running, done, stopped).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from './fixtures/electron.mjs';

const results = path.resolve('test-results');
await mkdir(results, { recursive: true });
const userData = await mkdtemp(path.join(tmpdir(), 'lectern-tasks-profile-'));
const taskTmp = await realpath(await mkdtemp(path.join(tmpdir(), 'lectern-tasks-tmp-')));
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: userData, LECTERN_NODE_BINARY: process.execPath, LECTERN_DIAGNOSTIC_CONTENT: '0', CLAUDE_CODE_TMPDIR: taskTmp };
delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL; delete env.TMUX; delete env.TMUX_PANE;
const exe = process.argv[2];
const at = offset => new Date(Date.now() - 60_000 + offset * 1000).toISOString();
const ids = { build: 'bbuild0001', train: 'btrain0001', watch: 'bwatch0001', long: 'blong00001' };

/** Run in the page: each tally ("2 running · 1 done") as laid out, under the name beside it.
 * A part's own text box must lie within the tally's box, which clips; a separator counts as
 * shown unless it lies wholly outside that box. */
function layoutOfTallies(tallies) {
  return tallies.map(tally => {
    const clip = tally.getBoundingClientRect(), frame = tally.closest('.activity-float, .task-column').getBoundingClientRect();
    const name = tally.parentElement.closest('.activity-float-toggle, h3, .task-column-bar').querySelector('.activity-float-title, .task-group-label, .task-column-title');
    const parts = [...tally.querySelectorAll('.activity-tally-part')].map(part => {
      const text = [...part.childNodes].find(node => node.nodeType === Node.TEXT_NODE), range = document.createRange();
      range.selectNodeContents(text);
      const box = range.getBoundingClientRect(), slot = part.querySelector('.activity-tally-separator'), separator = slot?.getBoundingClientRect();
      // The dot itself, for the space on either side of it.
      const dot = slot && document.createRange();
      if (dot) { const node = slot.firstChild; dot.setStart(node, node.textContent.indexOf('·')); dot.setEnd(node, node.textContent.indexOf('·') + 1); }
      return { text: text.textContent, inside: box.left >= clip.left - 0.5 && box.right <= clip.right + 0.5, top: Math.round(box.top),
        left: box.left, right: box.right, dot: dot && { left: dot.getBoundingClientRect().left, right: dot.getBoundingClientRect().right },
        separator: !separator ? 'none' : separator.right <= clip.left + 0.5 || separator.left >= clip.right - 0.5 ? 'clipped' : 'shown' };
    });
    return { name: name.textContent, nameWhole: name.scrollWidth <= name.clientWidth, align: tally.dataset.align, width: Math.round(clip.width),
      below: clip.top >= name.getBoundingClientRect().bottom - 1,
      lines: new Set(parts.map(part => part.top)).size, within: clip.left >= frame.left - 0.5 && clip.right <= frame.right + 0.5, parts };
  });
}
/** Every tally in `scope` shows each count whole, parts wrapping whole onto more lines; a
 * separator shows only between two parts on one line; the name beside it is whole. */
async function checkTallies(scope, expected, where) {
  const tallies = await scope.locator('.activity-tally').evaluateAll(layoutOfTallies);
  assert.deepEqual(Object.fromEntries(tallies.map(tally => [tally.name, tally.parts.map(part => part.text)])), expected, `${where}: the tallies`);
  for (const tally of tallies) {
    const detail = `${where}, ${tally.name}: ${JSON.stringify(tally)}`;
    assert.ok(tally.nameWhole && tally.within, `${detail}: the name is whole and the tally within its frame`);
    tally.parts.forEach((part, index) => {
      assert.ok(part.inside, `${detail}: "${part.text}" is not cut`);
      const neighbour = tally.parts[tally.align === 'end' ? index + 1 : index - 1];
      if (part.separator !== 'none') assert.equal(part.separator === 'shown', neighbour.top === part.top, `${detail}: separators only between parts on one line`);
      if (part.separator !== 'shown') return;
      // A shown dot sits midway between the two counts (its glyph box may be a full em wide).
      const [before, after] = tally.align === 'end' ? [part, neighbour] : [neighbour, part];
      const gaps = [part.dot.left - before.right, after.left - part.dot.right];
      assert.ok(gaps.every(gap => gap >= -0.5) && Math.abs(gaps[0] - gaps[1]) <= 1.5, `${detail}: the dot is centred between the counts (${gaps})`);
    });
  }
  // Logged as "name width/lines", with "↓" where the tally sits on its own line below the name.
  return tallies.map(tally => `${tally.name} ${tally.width}px/${tally.lines}${tally.below ? '↓' : ''}`).join(', ');
}
let app;
try {
  app = await _electron.launch({ args: exe ? ['--demo'] : ['.', '--demo'], ...(exe && { executablePath: path.resolve(exe) }), env, timeout: 60_000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1480, 940));
  await page.locator('.message-assistant').first().waitFor();
  await page.waitForFunction(() => document.querySelector('.session-row.active')?.getAttribute('data-session-live') === 'true');
  const sid = await page.locator('.session-row.active').getAttribute('data-session-id');
  const [workspace] = await page.evaluate(() => window.desktop.listWorkspaces());
  const slug = workspace.cwd.replace(/[^a-zA-Z0-9-]/g, '-');
  const main = path.join(workspace.claudeDir, 'projects', slug, `${sid}.jsonl`);
  const tasks = path.join(taskTmp, `claude-${process.getuid()}`, slug, sid, 'tasks');
  await mkdir(tasks, { recursive: true, mode: 0o700 });
  const output = name => path.join(tasks, `${ids[name]}.output`);
  const trainLog = path.join(workspace.cwd, 'logs', 'train.log');
  await mkdir(path.dirname(trainLog), { recursive: true });

  // The main transcript: one turn starts two background shells and a monitor.
  let parent = [...(await readFile(main, 'utf8')).trim().split('\n')].map(line => JSON.parse(line)).filter(r => r.uuid).at(-1)?.uuid ?? null;
  const record = (type, fields, offset) => { const uuid = randomUUID(); const r = { type, uuid, parentUuid: parent, sessionId: sid, cwd: workspace.cwd, version: '2.1.330', timestamp: at(offset), ...fields }; parent = uuid; return r; };
  const lines = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const result = (id, toolUseResult, text) => record('user', { toolUseResult, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } }, 3);
  const notice = (task, toolId, status, summary) => `<task-notification>\n<task-id>${task}</task-id>\n<tool-use-id>${toolId}</tool-use-id>\n<output-file>${output('build')}</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;
  const buildCommand = 'npm run build \\\n  --workspace app \\\n  -- --verbose';
  await writeFile(output('build'), 'step 1: compile\nstep 2: bundle\n', { mode: 0o600 });
  await writeFile(output('train'), '', { mode: 0o600 });
  await writeFile(output('watch'), 'server ready on :3000\n', { mode: 0o600 });
  // About 1 MB: four times the first window (256 KiB).
  await writeFile(output('long'), Array.from({ length: 100_000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n\n[exited with code 0]\n', { mode: 0o600 });
  await writeFile(trainLog, 'epoch 1 loss 0.91\n');
  await appendFile(main, lines([
    record('user', { origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: '在后台构建、训练并监听日志' } }, 1),
    record('assistant', { message: { id: 'msg_tasks', role: 'assistant', model: 'fixture', stop_reason: 'tool_use', content: [
      tool('toolu_build', 'Bash', { command: buildCommand, description: '构建前端', run_in_background: true }),
      tool('toolu_train', 'Bash', { command: 'cd logs && ../train.sh > train.log 2>&1', description: '训练模型', run_in_background: true }),
      tool('toolu_watch', 'Monitor', { command: 'tail -f server.log', description: '监听服务日志', timeout_ms: 300000 }),
      tool('toolu_long', 'Bash', { command: 'seq -f "line %g" 1 100000', description: '打印长输出', run_in_background: true })] } }, 2),
    result('toolu_build', { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: ids.build }, `Command running in background with ID: ${ids.build}.`),
    result('toolu_train', { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: ids.train }, `Command running in background with ID: ${ids.train}.`),
    result('toolu_watch', { taskId: ids.watch, timeoutMs: 300000, persistent: false }, `Monitor started (task ${ids.watch}, expires in 5m).`),
    result('toolu_long', { stdout: '', stderr: '', backgroundTaskId: ids.long }, `Command running in background with ID: ${ids.long}.`),
    record('assistant', { message: { id: 'msg_tasks_started', role: 'assistant', model: 'fixture', stop_reason: 'end_turn', content: [{ type: 'text', text: '三个任务已在后台运行。' }] } }, 4),
  ]));

  // Subagents whose launch is not in the transcript: their folder (Claude Code 2.1.310+) lists them.
  const subagents = path.join(workspace.claudeDir, 'projects', slug, sid, 'subagents');
  await mkdir(subagents, { recursive: true });
  const agents = { review: ['aereview000000001', '审查改动', {}], docs: ['aedocs0000000002', '整理文档', { finished: true }], lint: ['aelint0000000003', '检查格式', { finished: true, stoppedByUser: true }] };
  for (const [name, [agent, description, state]] of Object.entries(agents)) {
    await writeFile(path.join(subagents, `agent-${agent}.jsonl`), JSON.stringify({ parentUuid: null, isSidechain: true, sessionId: sid, agentId: agent, type: 'user', uuid: `${agent}-1`,
      timestamp: at({ review: -30, docs: -20, lint: -10 }[name]), message: { role: 'user', content: description } }) + '\n');
    await writeFile(path.join(subagents, `agent-${agent}.meta.json`), JSON.stringify({ agentType: 'general-purpose', isBuiltIn: true, description, toolUseId: `toolu_${name}`, ...state }));
  }

  // Without a choice the card opens by itself only where it fits beside the conversation
  // column (its width and inset come from the CSS): with the sidebar hidden, a window 40 px
  // wider than the column plus two cards and insets has room for it, 40 px narrower does not.
  const fit = () => page.evaluate(() => {
    const anchor = document.querySelector('.activity-float-anchor'), area = anchor.parentElement, style = getComputedStyle(anchor);
    const column = area.querySelector('.conversation').getBoundingClientRect(), shown = document.querySelector('.activity-float')?.getBoundingClientRect();
    const width = parseFloat(style.getPropertyValue('--activity-float-width'));
    return { width, room: area.getBoundingClientRect().right - parseFloat(style.right) - column.right, columnRight: column.right, card: shown?.toJSON() };
  });
  const windowWidth = async width => {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]?.setContentSize(width, 940), width);
    await page.waitForFunction(width => innerWidth === width, width);
  };
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  const needed = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--conversation-width'))) + 2 * (336 + 14);
  for (const [width, roomy] of [[needed + 40, true], [needed - 40, false]]) {
    await windowWidth(width);
    await page.locator(roomy ? '.activity-float' : '.activity-float-pill').waitFor();
    const state = await fit();
    assert.equal(state.width, 336, 'the card is 336 px wide');
    assert.equal(state.room >= state.width, roomy, `at ${width} px the card ${roomy ? 'fits' : 'does not fit'} beside the column: ${JSON.stringify(state)}`);
    if (!roomy) continue;
    assert.ok(state.card.left >= state.columnRight - 1 && Math.abs(state.card.width - state.width) < 1, `the card opens beside the column: ${JSON.stringify(state)}`);
    // The file preview takes the room: the card folds, and opens again when the preview closes.
    await page.getByRole('button', { name: '浏览工作目录', exact: true }).first().click();
    await page.locator('.artifact-drawer').waitFor();
    await page.locator('.activity-float-pill').waitFor();
    assert.ok((await fit()).room < 336, 'with the preview open the card has no room');
    await page.getByRole('button', { name: '关闭文件预览', exact: true }).click();
    await page.locator('.activity-float').waitFor();
  }
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  await windowWidth(1480);

  // The activity card: Chinese names for the kinds; "查看详情" opens the column on the build.
  const card = page.locator('.activity-float');
  if (!await card.isVisible()) await page.locator('.activity-float-pill').click();
  const section = name => page.locator('.activity-float-section').filter({ has: page.locator('.activity-float-title', { hasText: new RegExp(`^${name}$`) }) });
  await section('终端').waitFor();
  await section('监控').waitFor();
  await section('子代理').waitFor();
  await section('终端').locator('.activity-float-toggle').click();
  const buildCard = page.locator('article.activity-card[data-activity-id="toolu_build"]');
  assert.equal(await buildCard.locator('.activity-title small').innerText(), '终端');
  await buildCard.locator('.activity-open-conversation').click();
  const column = page.locator('[data-task-column]');
  await column.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-task-key')), 'toolu_build', 'the column takes the focus on its entry');
  assert.deepEqual(await column.locator('.task-group').evaluateAll(groups => groups.map(group => [group.dataset.kind, group.querySelector('h3')?.firstChild?.nextSibling?.textContent])),
    [['agent', '子代理'], ['shell', '终端'], ['monitor', '监控']]);
  // Rows of a group as [key, state], top to bottom. All launched by one message (one start
  // time) and all running: card order, the last launched first.
  const rows = kind => column.locator(`.task-column-list button[data-kind="${kind}"]`).evaluateAll(buttons => buttons.map(row => [row.dataset.taskKey, row.dataset.state]));
  assert.deepEqual(await rows('shell'), [['toolu_long', 'running'], ['toolu_train', 'running'], ['toolu_build', 'running']]);
  // All three subagents, without loading older history, with their meta files' states.
  assert.deepEqual(await rows('agent'), [['toolu_review', 'running'], ['toolu_lint', 'stopped'], ['toolu_docs', 'completed']]);
  const detail = column.locator('[data-task-detail="toolu_build"]');
  await detail.locator('.task-output', { hasText: 'step 2: bundle' }).waitFor();
  assert.equal(await detail.locator('.task-command').innerText(), buildCommand, 'the whole command, line breaks kept');
  assert.ok(await detail.locator('.task-command .sh-command').count() > 0, 'the command is coloured');
  assert.match(await detail.locator('.subagent-detail-head small').innerText(), /终端 · 开始于 .* · 耗时 /);
  assert.equal(await detail.getAttribute('data-source'), 'task');
  // It keeps running: new output is appended without reopening the column.
  await appendFile(output('build'), 'step 3: \x1b[32mminify\x1b[0m\n');
  await detail.locator('.task-output', { hasText: 'step 3: minify' }).waitFor();

  // The training shell printed nothing itself: the file its command wrote to is the output,
  // relative to the cd before it, and followed while it grows.
  await column.locator('.task-column-list button[data-task-key="toolu_train"]').click();
  const train = column.locator('[data-task-detail="toolu_train"]');
  await train.locator('.task-output', { hasText: 'epoch 1 loss 0.91' }).waitFor();
  assert.equal(await train.getAttribute('data-source'), 'file:0');
  assert.equal(await train.locator('[data-redirect-path]').getAttribute('data-redirect-path'), trainLog);
  assert.match(await train.locator('.task-source-note').first().innerText(), /任务本身没有输出，输出来自/);
  await appendFile(trainLog, 'epoch 2 loss 0.42\n');
  await train.locator('.task-output', { hasText: 'epoch 2 loss 0.42' }).waitFor();
  // Its own (empty) output is one click away.
  await train.locator('.task-sources button[data-source-key="task"]').click();
  await page.waitForFunction(() => document.querySelector('[data-task-detail="toolu_train"]')?.dataset.source === 'task');
  assert.equal(await train.locator('.task-output').innerText(), '（没有输出）');
  await train.locator('.task-sources button[data-source-key="file:0"]').click();
  await train.locator('.task-output', { hasText: 'epoch 2' }).waitFor();

  // The monitor: its own output file.
  await column.locator('.task-column-list button[data-task-key="toolu_watch"]').click();
  const watch = column.locator('[data-task-detail="toolu_watch"]');
  await watch.locator('.task-output', { hasText: 'server ready on :3000' }).waitFor();
  assert.match(await watch.locator('.subagent-detail-head small').innerText(), /监控 · .* · 时限 5 分 0 秒/);

  // A long output: its end first, the omitted part named; earlier output on request.
  await column.locator('.task-column-list button[data-task-key="toolu_long"]').click();
  const long = column.locator('[data-task-detail="toolu_long"]');
  await long.locator('.task-output', { hasText: 'line 100000' }).waitFor();
  const omitted = long.locator('.task-output-frame .task-detail-label small');
  assert.match(await omitted.innerText(), /^已省略前面 \d+ KB$/);
  const before = await omitted.innerText();
  assert.match(await long.locator('.task-output').innerText(), /^line \d+\n/, 'the first shown line is whole');
  await long.locator('.task-output-frame button', { hasText: '显示更早的输出' }).click();
  await page.waitForFunction(text => document.querySelector('[data-task-detail="toolu_long"] .task-output-frame .task-detail-label small')?.textContent !== text, before);
  // 512 KiB a step: about 1 MB takes two more.
  for (let step = 0; step < 4 && await omitted.count(); step++) {
    const shown = await omitted.innerText();
    await long.locator('.task-output-frame button', { hasText: '显示更早的输出' }).click();
    await page.waitForFunction(text => document.querySelector('[data-task-detail="toolu_long"] .task-output-frame .task-detail-label small')?.textContent !== text, shown);
  }
  await long.locator('.task-output-frame button', { hasText: '显示更早的输出' }).waitFor({ state: 'detached' });
  assert.equal(await omitted.count(), 0, 'all of it is read now');
  assert.match(await long.locator('.task-output').innerText(), /^line 1\nline 2\n/);

  // The build ends: Claude Code appends "[exited with code 0]" and notifies; the state and
  // exit code show in the header, not in the output.
  await column.locator('.task-column-list button[data-task-key="toolu_build"]').click();
  await appendFile(output('build'), 'done\n\n[exited with code 0]\n');
  const done = notice(ids.build, 'toolu_build', 'completed', 'Background command "构建前端" completed (exit code 0)');
  await appendFile(main, lines([{ type: 'queue-operation', operation: 'enqueue', sessionId: sid, timestamp: at(30), content: done },
    record('user', { origin: { kind: 'task-notification' }, promptSource: 'system', message: { role: 'user', content: done } }, 30)]));
  await page.waitForFunction(() => document.querySelector('[data-task-detail="toolu_build"]')?.dataset.state === 'completed');
  await detail.locator('[data-exit-code="0"]').waitFor();
  await detail.locator('.task-output', { hasText: /done\s*$/ }).waitFor();
  assert.ok(!(await detail.locator('.task-output').innerText()).includes('[exited'), 'the native trailer is not output');
  // The long one fails: the shells' tally is now the longest, "1 running · 2 ended (1 failed)".
  // It is shown when it fails: it moves below the running one and stays shown.
  await column.locator('.task-column-list button[data-task-key="toolu_long"]').click();
  await long.locator('.task-output', { hasText: 'line 100000' }).waitFor();
  const failed = notice(ids.long, 'toolu_long', 'failed', 'Background command "打印长输出" failed with exit code 1');
  await appendFile(main, lines([{ type: 'queue-operation', operation: 'enqueue', sessionId: sid, timestamp: at(31), content: failed },
    record('user', { origin: { kind: 'task-notification' }, promptSource: 'system', message: { role: 'user', content: failed } }, 31)]));
  await column.locator('.task-column-list button[data-task-key="toolu_long"][data-state="failed"]').waitFor();
  assert.deepEqual(await rows('shell'), [['toolu_train', 'running'], ['toolu_long', 'failed'], ['toolu_build', 'completed']], 'running before ended');
  assert.equal(await column.locator('.task-column-list button[aria-current="true"]').getAttribute('data-task-key'), 'toolu_long', 'the one shown stays shown when it moves');
  await page.waitForFunction(() => document.querySelector('[data-task-detail="toolu_long"]')?.dataset.state === 'failed');
  await column.locator('.task-column-list button[data-task-key="toolu_build"]').click();
  await detail.locator('.task-output', { hasText: /done\s*$/ }).waitFor();
  const tallies = {
    zh: { '子代理': ['1 运行中', '2 完成'], '终端': ['1 运行中', '2 结束（1 失败）'], '监控': ['1 运行中'] },
    en: { Subagents: ['1 running', '2 done'], 'Background shells': ['1 running', '2 ended (1 failed)'], Monitors: ['1 running'] },
  };
  await card.waitFor();
  console.log(`tallies, zh, column open: card ${await checkTallies(card, tallies.zh, 'card, zh')}; column ${
    await checkTallies(column, { '后台任务': ['3 运行中', '4 结束（1 失败）'], ...tallies.zh }, 'column, zh')}`);
  await page.locator('.activity-float-anchor button[aria-label="收起会话活动"]').click().catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(results, 'task-column-light.png') });
  // Playwright pins the page's colour scheme: the dark theme is emulated (the default theme follows the system).
  await column.locator('.task-column-list button[data-task-key="toolu_train"]').click();
  await train.locator('.task-output', { hasText: 'epoch 2' }).waitFor();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(results, 'task-column-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });

  // English: shell and monitor keep their names (the language switches in place).
  await page.evaluate(() => window.desktop.setLocalePreference('en'));
  await column.locator('.task-column-bar span', { hasText: 'Background tasks' }).waitFor();
  assert.deepEqual(await column.locator('.task-group h3').evaluateAll(heads => heads.map(head => head.firstChild?.nextSibling?.textContent)), ['Subagents', 'Background shells', 'Monitors']);
  await train.locator('.task-detail-label span', { hasText: 'Command' }).waitFor();
  assert.match(await train.locator('.task-source-note').first().innerText(), /The task printed nothing itself\. Output from/);
  if (!await card.isVisible()) await page.locator('.activity-float-pill').click();
  await section('Background shells').waitFor();
  await section('Monitors').waitFor();
  assert.equal(await page.locator('article.activity-card[data-activity-id="toolu_build"] .activity-title small').innerText(), 'Shell');
  console.log(`tallies, en, column open: card ${await checkTallies(card, tallies.en, 'card, en')}; column ${
    await checkTallies(column, { 'Background tasks': ['3 running', '4 ended (1 failed)'], ...tallies.en }, 'column, en')}`);
  await page.screenshot({ path: path.join(results, 'task-column-en.png') });
  await page.evaluate(() => window.desktop.setLocalePreference('zh-CN'));
  await column.locator('.task-column-bar span', { hasText: '后台任务' }).waitFor();

  // Closing the column leaves the chat as it was.
  await column.locator('.task-column-bar button').click();
  await column.waitFor({ state: 'detached' });

  // The card by itself, in one pane, in a split and in the narrowest split (a narrower card),
  // in both languages: every section header shows its whole tally. Screenshots in both themes.
  const shots = [];
  const layouts = async (layout, schemes = ['light', 'dark']) => {
    for (const locale of ['zh-CN', 'en']) {
      const lang = locale === 'en' ? 'en' : 'zh';
      await page.evaluate(locale => window.desktop.setLocalePreference(locale), locale);
      await section(lang === 'en' ? 'Background shells' : '终端').waitFor();
      const width = await card.evaluate(node => Math.round(node.getBoundingClientRect().width));
      console.log(`tallies, ${lang}, ${layout} (card ${width}px): ${await checkTallies(card, tallies[lang], `card, ${lang}, ${layout}`)}`);
      for (const scheme of schemes) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(300);
        shots.push(path.join(results, `activity-card-${layout}-${lang}-${scheme}.png`));
        await page.screenshot({ path: shots.at(-1) });
      }
      await page.emulateMedia({ colorScheme: 'light' });
      if (layout !== 'single') continue;
      shots.push(path.join(results, `activity-card-alone-${lang}.png`));
      await card.screenshot({ path: shots.at(-1) });
    }
    await page.evaluate(() => window.desktop.setLocalePreference('zh-CN'));
    await section('终端').waitFor();
  };
  const expand = async () => {
    await page.waitForTimeout(500);
    if (!await card.isVisible()) await page.locator('.activity-float-pill').click();
    await card.waitFor();
  };
  await expand();
  await layouts('single');
  await page.getByRole('button', { name: '并排打开对话', exact: true }).click();
  await page.locator('.split-workspace.divided[data-direction="columns"]').waitFor();
  await expand();
  await layouts('split');
  // The narrowest side-by-side split (770 px; narrower stacks the panes): each pane is under 520 px.
  const sidebarWidth = await page.locator('.sidebar').evaluate(node => node.getBoundingClientRect().width);
  await windowWidth(Math.ceil(sidebarWidth) + 790);
  await page.locator('.split-workspace.divided[data-direction="columns"]').waitFor();
  await expand();
  assert.equal(await card.evaluate(node => Math.round(node.getBoundingClientRect().width)), 312, 'a pane under 520 px has the narrower card');
  await layouts('narrow-split', ['light']);
  assert.deepEqual(errors, []);
  console.log('PASS: "查看详情" opens the task column; a running shell shows its full command and appended output, a shell that redirected into a file shows that file, a monitor its output; the exit code comes from the native trailer; Chinese 终端/监控 and English Shell/Monitor labels.');
  console.log(`Screenshots: ${['light', 'dark', 'en'].map(name => path.join(results, `task-column-${name}.png`)).concat(shots).join(', ')}`);
} catch (error) {
  const page = app?.windows()[0];
  if (page) await page.screenshot({ path: path.join(results, 'task-column-failure.png') }).catch(() => {});
  throw error;
} finally {
  await app?.close();
  await rm(userData, { recursive: true, force: true });
  await rm(taskTmp, { recursive: true, force: true });
}
