// node scripts/transcript-render-e2e.mjs [packaged-executable]
// Opens a temporary JSONL history only: no Claude process, no remote, no model request.
// Checks progress notes (narration thinking) as text, other thinking folded like
// Claude Code's "Thought for Ns", sed -i edits as diffs, and that the activity
// panel lists background shells but not foreground ones.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lectern-render-')));
const profile = path.join(root, 'profile'), config = path.join(root, 'claude'), cwd = path.join(root, 'work');
const project = path.join(config, 'projects', cwd.replace(/[^a-z0-9-]/gi, '-'));
const sid = randomUUID();
let app, parentUuid = null;
function row(type, content, extra = {}, messageId) {
  const uuid = randomUUID();
  const r = { type, cwd, sessionId: sid, uuid, parentUuid, timestamp: new Date().toISOString(), version: '2.1.328', ...extra,
    message: { role: type, content, ...(type === 'assistant' && { id: messageId ?? uuid, stop_reason: null }) } };
  parentUuid = uuid;
  return JSON.stringify(r);
}
// A thinking signature names its purpose (protobuf field 2 → 1 → 8), as Claude Code reads it.
function signature(purpose) {
  const field = (number, bytes) => { const out = []; for (let n of [number * 8 + 2, bytes.length]) { while (n > 127) { out.push((n % 128) | 128); n = Math.floor(n / 128); } out.push(n); } return [...out, ...bytes]; };
  return Buffer.from(field(2, field(1, field(8, [...Buffer.from(purpose)])))).toString('base64');
}
try {
  await Promise.all([profile, cwd, project].map(dir => mkdir(dir, { recursive: true })));
  await writeFile(path.join(cwd, 'app.css'), '.button { color: blue; }\n');
  await writeFile(path.join(profile, 'workspaces.json'), JSON.stringify([{ id: 'fixture', name: '渲染检查', kind: 'local', cwd, claudeDir: config }]));
  const updates = { thinkingDisplay: 'updates' };
  await writeFile(path.join(project, `${sid}.jsonl`), [row('user', '把按钮改成红色'),
    row('assistant', [{ type: 'thinking', thinking: '先改样式，再启动开发服务器。\n\n', signature: signature('narration') }], updates, 'm1'),
    row('assistant', [{ type: 'tool_use', id: 'sed1', name: 'Bash', input: { command: "sed -i '' -e 's/color: blue/color: red/g' app.css", description: 'Recolor' } }], updates, 'm1'),
    row('user', [{ type: 'tool_result', tool_use_id: 'sed1', content: '' }]),
    row('assistant', [{ type: 'thinking', thinking: 'Private chain of thought.', signature: signature('thinking') }], { ...updates, thinkingDurationMs: 8300 }, 'm2'),
    row('assistant', [{ type: 'tool_use', id: 'fg1', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }], updates, 'm2'),
    row('user', [{ type: 'tool_result', tool_use_id: 'fg1', content: 'ok' }]),
    row('assistant', [{ type: 'tool_use', id: 'bg1', name: 'Bash', input: { command: 'npm run dev', run_in_background: true } }], updates, 'm3'),
    row('user', [{ type: 'tool_result', tool_use_id: 'bg1', content: 'Command running in background with ID: b1' }], { toolUseResult: { backgroundTaskId: 'b1' } }),
    row('assistant', [{ type: 'text', text: '已改成红色。' }], updates, 'm4')].join('\n') + '\n');
  const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: profile, CLAUDE_CONFIG_DIR: config, TMUX_TMPDIR: root, LECTERN_DIAGNOSTIC_CONTENT: '0' };
  delete env.LECTERN_DEV_URL; delete env.ELECTRON_RUN_AS_NODE; delete env.TMUX;
  const exe = process.argv[2];
  app = await _electron.launch({ args: exe ? [] : ['.'], ...(exe && { executablePath: path.resolve(exe) }), env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
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
  console.log(JSON.stringify({ ok: true, progressNotes: true, foldedThought: true, sedDiff: true, panel: ['bg1'] }));
} finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
