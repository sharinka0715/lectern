// node scripts/saved-history-ui-e2e.mjs [packaged-executable]
// Saved conversations only: temporary JSONL histories in one local folder. No Claude process,
// no remote, no model request. One launch for three parts; each prints "PASS <part>", and a
// failure names its part (formerly task-notice-ui-e2e, archive-ui-e2e and transcript-render-e2e):
//   notice   a background task notification folds to one line in the command rows' style and
//            without a grey surface; the keyboard opens its full text and file reference, the mouse
//            folds it again; the notice sits between the call and the reply it triggers
//            (screenshot test-results/task-notice-expanded.png)
//   archive  archiving a conversation from the sidebar leaves its file untouched, survives a reload
//            and is restored from Settings → 回收站
//   render   progress notes (narration thinking) show as text, other thinking folds like Claude
//            Code's "Thought for Ns", sed -i edits show as diffs, and the activity panel lists
//            background shells but not foreground ones
import { createPrivateTmux } from './fixtures/private-tmux.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from './fixtures/electron.mjs';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lectern-saved-history-')));
const privateServer = createPrivateTmux(root);
const profile = path.join(root, 'profile'), config = path.join(root, 'claude'), cwd = path.join(root, 'work');
const project = path.join(config, 'projects', cwd.replace(/[^a-z0-9-]/gi, '-'));
/** Runs one part; a failure names it. */
async function part(name, run) {
  try { await run(); } catch (error) { error.message = `[${name}] ${error.message}`; throw error; }
}

// ── notice: prose and a tool call, then a task notification that triggers more prose ──
const noticeChat = { sid: randomUUID(), title: '后台检查已完成', filename: 'result.txt' };
noticeChat.detail = `共检查 3 个文件。\n结果见 ${noticeChat.filename}`;
function noticeHistory() {
  const { sid, title, detail } = noticeChat;
  let parentUuid = null;
  function row(type, content, extra = {}) {
    const uuid = randomUUID();
    const r = { type, cwd, sessionId: sid, uuid, parentUuid, timestamp: new Date().toISOString(), ...extra,
      message: { role: type, content, ...(type === 'assistant' && { id: uuid }) } };
    parentUuid = uuid;
    return JSON.stringify(r);
  }
  return [row('user', '检查项目文件'),
    row('assistant', '开始检查文件。'),
    row('assistant', [{ type: 'tool_use', id: 'check', name: 'Bash', input: { command: 'ls' } }]),
    row('user', [{ type: 'tool_result', tool_use_id: 'check', content: '已启动检查' }]),
    row('user', `<task-notification>\n<summary>${title}</summary>\n<result>${detail}</result>\n</task-notification>`, { origin: { kind: 'task-notification' } }),
    row('assistant', '已收到检查结果。')].join('\n') + '\n';
}

// ── archive: two finished conversations, one to keep and one to archive ──
const kept = randomUUID(), archived = randomUUID();
const archiveHistory = (sid, prompt) => [
  { type: 'user', uuid: `${sid}-u`, parentUuid: null, message: { role: 'user', content: prompt } },
  { type: 'assistant', uuid: `${sid}-a`, parentUuid: `${sid}-u`, message: { id: `${sid}-m`, role: 'assistant', content: [{ type: 'text', text: '好的。' }], stop_reason: 'end_turn' } },
].map(r => JSON.stringify({ ...r, cwd, sessionId: sid, timestamp: new Date().toISOString() })).join('\n') + '\n';

// ── render: narration and folded thinking, a sed -i edit, a foreground and a background shell ──
const render = { sid: randomUUID() };
// A thinking signature names its purpose (protobuf field 2 → 1 → 8), as Claude Code reads it.
function signature(purpose) {
  const field = (number, bytes) => { const out = []; for (let n of [number * 8 + 2, bytes.length]) { while (n > 127) { out.push((n % 128) | 128); n = Math.floor(n / 128); } out.push(n); } return [...out, ...bytes]; };
  return Buffer.from(field(2, field(1, field(8, [...Buffer.from(purpose)])))).toString('base64');
}
function renderHistory() {
  const { sid } = render;
  let parentUuid = null;
  function row(type, content, extra = {}, messageId) {
    const uuid = randomUUID();
    const r = { type, cwd, sessionId: sid, uuid, parentUuid, timestamp: new Date().toISOString(), version: '2.1.328', ...extra,
      message: { role: type, content, ...(type === 'assistant' && { id: messageId ?? uuid, stop_reason: null }) } };
    parentUuid = uuid;
    return JSON.stringify(r);
  }
  const updates = { thinkingDisplay: 'updates' };
  return [row('user', '把按钮改成红色'),
    row('assistant', [{ type: 'thinking', thinking: '先改样式，再启动开发服务器。\n\n', signature: signature('narration') }], updates, 'm1'),
    row('assistant', [{ type: 'tool_use', id: 'sed1', name: 'Bash', input: { command: "sed -i '' -e 's/color: blue/color: red/g' app.css", description: 'Recolor' } }], updates, 'm1'),
    row('user', [{ type: 'tool_result', tool_use_id: 'sed1', content: '' }]),
    row('assistant', [{ type: 'thinking', thinking: 'Private chain of thought.', signature: signature('thinking') }], { ...updates, thinkingDurationMs: 8300 }, 'm2'),
    row('assistant', [{ type: 'tool_use', id: 'fg1', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }], updates, 'm2'),
    row('user', [{ type: 'tool_result', tool_use_id: 'fg1', content: 'ok' }]),
    row('assistant', [{ type: 'tool_use', id: 'bg1', name: 'Bash', input: { command: 'npm run dev', run_in_background: true } }], updates, 'm3'),
    row('user', [{ type: 'tool_result', tool_use_id: 'bg1', content: 'Command running in background with ID: b1' }], { toolUseResult: { backgroundTaskId: 'b1' } }),
    row('assistant', [{ type: 'text', text: '已改成红色。' }], updates, 'm4')].join('\n') + '\n';
}

let app;
try {
  await Promise.all([profile, cwd, project].map(dir => mkdir(dir, { recursive: true })));
  await writeFile(path.join(profile, 'workspaces.json'), JSON.stringify([{ id: 'fixture', name: '历史记录检查', kind: 'local', cwd }]));
  await writeFile(path.join(cwd, noticeChat.filename), '验证文件引用');
  await writeFile(path.join(cwd, 'app.css'), '.button { color: blue; }\n');
  await writeFile(path.join(project, `${noticeChat.sid}.jsonl`), noticeHistory());
  await writeFile(path.join(project, `${kept}.jsonl`), archiveHistory(kept, '保留这条'));
  await writeFile(path.join(project, `${archived}.jsonl`), archiveHistory(archived, '归档这条'));
  const archivedBefore = await readFile(path.join(project, `${archived}.jsonl`), 'utf8');
  await writeFile(path.join(project, `${render.sid}.jsonl`), renderHistory());
  const env = { ...privateServer.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: profile, CLAUDE_CONFIG_DIR: config, LECTERN_DIAGNOSTIC_CONTENT: '0' };
  delete env.LECTERN_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
  const exe = process.argv[2];
  app = await _electron.launch({ args: exe ? [] : ['.'], ...(exe && { executablePath: path.resolve(exe) }), env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);

  await part('notice', async () => {
    const { sid, title, filename, detail } = noticeChat;
    await page.locator(`[data-session-id="${sid}"]`).first().click();
    const notice = page.locator('.message details').filter({ has: page.locator('summary', { hasText: '后台任务通知' }) });
    const summary = notice.locator(':scope > summary');
    const tool = page.locator('[data-tool-id="check"]');
    const style = el => { const s = getComputedStyle(el); return [s.fontSize, s.padding, s.lineHeight, s.color]; };
    const surface = el => { const s = getComputedStyle(el); return [s.backgroundColor, s.borderTopWidth]; };
    await summary.waitFor();
    const reply = page.locator('.message-assistant .message-content');
    const order = await reply.locator(':scope > .markdown, :scope > [data-tool-id], :scope > .task-notice').evaluateAll(nodes =>
      nodes.map(el => el.getAttribute('data-tool-id') ?? el.querySelector('.activity-subject')?.textContent ?? el.textContent.trim()));
    assert.deepEqual(order, ['开始检查文件。', 'check', title, '已收到检查结果。']);
    assert.equal(await notice.evaluate(el => el.open), false);
    assert.ok((await summary.innerText()).includes(title), '折叠时应能看到具体任务摘要');
    assert.deepEqual(await summary.evaluate(style), await tool.locator('summary').evaluate(style));
    assert.deepEqual(await notice.evaluate(surface), ['rgba(0, 0, 0, 0)', '0px']);
    await summary.focus(); await page.keyboard.press('Enter');
    const body = notice.locator('.task-notice-content');
    await body.waitFor();
    assert.deepEqual(await body.evaluate(surface), ['rgba(0, 0, 0, 0)', '0px']);
    assert.equal(await body.innerText(), `${title}\n\n${detail}`);
    await body.getByRole('button', { name: filename, exact: true }).waitFor();
    await mkdir('test-results', { recursive: true });
    await notice.locator('xpath=ancestor::article[1]').screenshot({ path: 'test-results/task-notice-expanded.png' });
    await summary.click(); await body.waitFor({ state: 'detached' });
    assert.equal(await notice.evaluate(el => el.open), false);
    console.log('PASS notice：通知位于工具调用和后续正文之间，默认单行收起，沿用命令行样式，可展开全文和文件引用。');
  });

  await part('archive', async () => {
    const row = sid => page.locator(`.session-row[data-session-id="${sid}"]`);
    await row(archived).click();
    await page.locator('.message-assistant').getByText('好的。').waitFor();
    await row(archived).click({ button: 'right' });
    await page.locator('.context-menu:popover-open').getByRole('menuitem', { name: '归档对话' }).click();
    await row(archived).waitFor({ state: 'detached' });
    await row(kept).waitFor();
    await page.locator('.context-toast').getByText(/已归档/).waitFor();
    assert.equal(await readFile(path.join(project, `${archived}.jsonl`), 'utf8'), archivedBefore, 'the conversation file is untouched');
    // Survives a reload, then comes back from Settings → 回收站.
    await page.reload();
    await row(kept).waitFor();
    assert.equal(await row(archived).count(), 0);
    await page.getByRole('button', { name: '界面与连接设置' }).click();
    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    await settings.getByRole('button', { name: '回收站' }).click();
    const entry = settings.locator(`[data-archived-session="${archived}"]`);
    assert.match(await entry.innerText(), /归档这条|新对话|对话/);
    await entry.getByRole('button', { name: /^恢复/ }).click();
    await settings.locator('[data-trash-empty]').waitFor();
    await settings.getByRole('button', { name: '关闭设置' }).click();
    await row(archived).waitFor();
    console.log('PASS archive: ' + JSON.stringify({ archived, fileUntouched: true, restored: true }));
  });

  // Last: it switches the reply detail setting to individual rows.
  await part('render', async () => {
    const { sid } = render;
    await page.locator(`[data-session-id="${sid}"]`).first().click();
    const reply = page.locator('.message-assistant').last();
    await reply.getByText('已改成红色。').waitFor();
    assert.ok((await reply.innerText()).includes('先改样式，再启动开发服务器。'), 'progress notes are shown');
    assert.ok(!(await reply.innerText()).includes('Private chain of thought'), 'other thinking is folded by default');
    // Compact: the thought joins the neighbouring operations' summary, like "Thought for 8s, …".
    const group = reply.locator('.activity-group').filter({ hasText: '思考 8 秒' });
    assert.match(await group.locator(':scope > summary').innerText(), /思考 8 秒/);
    await group.locator(':scope > summary').click();
    const folded = group.locator('[data-thought]');
    assert.match(await folded.locator('summary').innerText(), /思考\s*8 秒/);
    await folded.locator('summary').click();
    await folded.getByText('Private chain of thought.').waitFor();
    // Individual rows: the sed command is an edit of app.css with its substitution.
    await page.evaluate(() => { const key = 'lectern.desktop.preferences.v1'; const p = JSON.parse(localStorage.getItem(key) ?? '{}'); localStorage.setItem(key, JSON.stringify({ ...p, replyDetail: 'individual' })); });
    await page.reload();
    await page.locator(`[data-session-id="${sid}"]`).first().click();
    // Individual rows: the thought is its own folded row.
    await page.locator('.message-assistant').last().getByText('已改成红色。').waitFor();
    const thought = page.locator('.message-assistant [data-thought]');
    assert.equal(await thought.count(), 1);
    assert.equal(await thought.evaluate(node => node.open), false);
    assert.ok(!(await page.locator('.message-assistant').last().innerText()).includes('Private chain of thought'));
    const sed = page.locator('[data-tool-id="sed1"]');
    await sed.locator('summary').click();
    const diff = sed.locator('.edit-diff');
    await diff.waitFor();
    assert.match(await diff.innerText(), /按 sed 命令还原的修改/);
    assert.equal(await diff.locator('.edit-diff-line.removed code').innerText(), '-color: blue');
    assert.equal(await diff.locator('.edit-diff-line.added code').innerText(), '+color: red');
    // The activity card floats over the chat; it may already be open, and lists a kind once that part is opened.
    const panel = page.locator('.activity-float');
    if (!await panel.count()) await page.getByRole('button', { name: '查看会话活动' }).click();
    await panel.waitFor();
    await panel.getByRole('button', { name: /^终端/ }).click();
    assert.deepEqual(await panel.locator('[data-activity-id]').evaluateAll(cards => cards.map(card => card.getAttribute('data-activity-id'))), ['bg1'],
      'only the background shell is a task in the panel');
    console.log('PASS render: ' + JSON.stringify({ progressNotes: true, foldedThought: true, sedDiff: true, panel: ['bg1'] }));
  });
} finally { await app?.close(); privateServer.killAll(); await rm(root, { recursive: true, force: true }); }
