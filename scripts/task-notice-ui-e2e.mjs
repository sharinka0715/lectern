// 只打开临时 JSONL 历史，不启动 Claude，不连接远端。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lectern-task-notice-')));
const profile = path.join(root, 'profile'), config = path.join(root, 'claude'), cwd = path.join(root, 'work');
const project = path.join(config, 'projects', cwd.replace(/[^a-z0-9-]/gi, '-'));
const sid = randomUUID(), title = '后台检查已完成', filename = 'result.txt';
const detail = `共检查 3 个文件。\n结果见 ${filename}`;
let app;
try {
  await Promise.all([profile, cwd, project].map(dir => mkdir(dir, { recursive: true })));
  await writeFile(path.join(profile, 'workspaces.json'), JSON.stringify([{ id: 'fixture', name: '通知样式', kind: 'local', cwd, claudeDir: config }]));
  await writeFile(path.join(cwd, filename), '验证文件引用');
  let parentUuid = null;
  function row(type, content, extra = {}) {
    const uuid = randomUUID();
    const r = { type, cwd, sessionId: sid, uuid, parentUuid, timestamp: new Date().toISOString(), ...extra,
      message: { role: type, content, ...(type === 'assistant' && { id: uuid }) } };
    parentUuid = uuid;
    return JSON.stringify(r);
  }
  await writeFile(path.join(project, `${sid}.jsonl`), [row('user', '检查项目文件'),
    row('assistant', [{ type: 'tool_use', id: 'check', name: 'Bash', input: { command: 'ls' } }]),
    row('user', [{ type: 'tool_result', tool_use_id: 'check', content: '已启动检查' }]),
    row('user', `<task-notification>\n<summary>${title}</summary>\n<result>${detail}</result>\n</task-notification>`, { origin: { kind: 'task-notification' } }),
    row('assistant', '检查完成。')].join('\n') + '\n');
  const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: profile, CLAUDE_CONFIG_DIR: config, TMUX_TMPDIR: root, LECTERN_DIAGNOSTIC_CONTENT: '0' };
  delete env.LECTERN_DEV_URL; delete env.ELECTRON_RUN_AS_NODE; delete env.TMUX;
  const exe = process.argv[2];
  app = await _electron.launch({ args: exe ? [] : ['.'], ...(exe && { executablePath: path.resolve(exe) }), env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  await page.locator(`[data-session-id="${sid}"]`).first().click();
  const notice = page.locator('.message details').filter({ has: page.locator('summary', { hasText: '后台任务通知' }) });
  const summary = notice.locator(':scope > summary');
  const tool = page.locator('[data-tool-id="check"]');
  const style = el => { const s = getComputedStyle(el); return [s.fontSize, s.padding, s.lineHeight, s.color]; };
  const surface = el => { const s = getComputedStyle(el); return [s.backgroundColor, s.borderTopWidth]; };
  await summary.waitFor();
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
  console.log('通过：通知默认单行收起，摘要沿用命令行字号与间距，无灰底和边框；键盘展开可读全文、可访问文件引用，鼠标可收起。');
} finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
