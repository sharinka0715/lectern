// npm run build && node scripts/foreground-shell-e2e.mjs [packaged-executable]
// Installed Claude Code with an isolated CLAUDE_CONFIG_DIR and tmux, talking to a
// loopback mock model that asks for one slow foreground Bash command. No real model.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from './fixtures/electron.mjs';
import { answerAutoModeCheck, isAutoModeCheck, LOCAL_AUTO_MODE_CHECK } from './fixtures/auto-mode-check.mjs';

const command = 'for i in 1 2 3 4 5 6; do echo fg-line-$i; sleep 1; done';
let turn = 0, localChecks = 0;
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  let body; try { body = JSON.parse(raw); } catch {}
  if (req.method === 'POST' && isAutoModeCheck(body)) { localChecks++; return answerAutoModeCheck(res, body); }
  if (req.method !== 'POST' || !body?.stream) return res.writeHead(500).end('{}');
  const tool = turn++ === 0 && body.tools?.some(t => t.name === 'Bash');
  const send = (type, fields = {}) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  send('message_start', { message: { id: `msg_fg_${turn}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } });
  send('content_block_start', { index: 0, content_block: tool ? { type: 'tool_use', id: 'toolu_fg', name: 'Bash', input: {} } : { type: 'text', text: '' } });
  send('content_block_delta', { index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify({ command, description: 'Print six lines slowly' }) } : { type: 'text_delta', text: '命令已完成。' } });
  send('content_block_stop', { index: 0 });
  send('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } }); send('message_stop'); res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lectern-fg-')));
const profile = path.join(root, 'profile'), config = path.join(root, 'claude'), cwd = path.join(root, 'work');
let app;
try {
  await Promise.all([profile, config, cwd].map(dir => mkdir(dir, { recursive: true })));
  await writeFile(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [cwd]: { hasTrustDialogAccepted: true } }, customApiKeyResponses: { approved: ['fg-e2e'] } }));
  await writeFile(path.join(config, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash'], defaultMode: 'acceptEdits' },
    env: { ANTHROPIC_API_KEY: 'fg-e2e', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' } }));
  await writeFile(path.join(profile, 'workspaces.json'), JSON.stringify([{ id: 'fg', name: '前台命令', kind: 'local', cwd, claudeDir: config }]));
  // Auto mode's check runs locally (answered by the loopback model), not on the server, which
  // this loopback "gateway" cannot run; the variable reaches Claude Code through the app and tmux.
  const env = { ...process.env, ...LOCAL_AUTO_MODE_CHECK, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: profile, TMUX_TMPDIR: root, LECTERN_DIAGNOSTIC_CONTENT: '0' };
  delete env.LECTERN_DEV_URL; delete env.ELECTRON_RUN_AS_NODE; delete env.TMUX;
  const exe = process.argv[2];
  app = await _electron.launch({ args: exe ? [] : ['.'], ...(exe && { executablePath: path.resolve(exe) }), env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  // A new chat: Claude Code starts with its first message, which waits for any startup prompt.
  await page.getByRole('button', { name: '在 前台命令 新建对话' }).click();
  const input = page.getByRole('textbox', { name: '发送给 Claude 的消息' });
  await input.fill('运行慢命令');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  // The app starts the session in auto mode (Bash is allowed here anyway) and gets
  // past any auto-mode prompt itself; wait until the model was asked.
  for (let i = 0; i < 80 && turn === 0; i++) await new Promise(r => setTimeout(r, 250));
  await page.waitForFunction(() => document.querySelector('.tool-live') || !document.querySelector('.first-message-bar')).catch(async error => {
    await page.screenshot({ path: path.join(tmpdir(), 'lectern-fg-e2e.png') });
    console.error('STATE', JSON.stringify(await page.evaluate(() => ({ row: document.querySelector('.session-row.active')?.getAttribute('data-status'),
      main: document.querySelector('.main-area')?.innerText.slice(-600) }))));
    const tmux = (...a) => execFileSync('tmux', a, { env: { ...process.env, TMUX_TMPDIR: root } }).toString();
    for (const pane of tmux('list-panes', '-a', '-F', '#{pane_id}').trim().split('\n')) console.error('PANE', pane, '\n' + tmux('capture-pane', '-p', '-t', pane).split('\n').filter(l => l.trim()).slice(-16).join('\n'));
    throw error;
  });
  const live = page.locator('.tool-live[data-live-tool="toolu_fg"]');
  await live.waitFor();
  await page.locator('.tool-live[data-live-state="running"]').waitFor();
  assert.match(await live.innerText(), /正在运行/);
  assert.match(await live.innerText(), /Print six lines slowly/, 'the description Claude Code shows is shown too');
  await page.waitForFunction(() => /已输出 \d+ 行/.test(document.querySelector('.tool-live')?.textContent ?? ''), null, { timeout: 15000 }).catch(() => {});
  const lines = /已输出 (\d+) 行/.exec(await live.innerText())?.[1];
  const panel = page.locator('.activity-float');
  if (!await panel.count()) await page.getByRole('button', { name: '查看会话活动' }).click();
  await panel.waitFor();
  assert.equal(await panel.getByRole('button', { name: /^终端/ }).count(), 0, 'a foreground command is not a background task');
  await page.locator('.message-assistant').getByText('命令已完成。').waitFor().catch(async error => {
    console.error('MESSAGES', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.message')].map(m => m.innerText.slice(0, 200)))));
    const tmux = (...a) => execFileSync('tmux', a, { env: { ...process.env, TMUX_TMPDIR: root } }).toString();
    for (const pane of tmux('list-panes', '-a', '-F', '#{pane_id}').trim().split('\n')) console.error('PANE', pane, '\n' + tmux('capture-pane', '-p', '-t', pane).split('\n').filter(l => l.trim()).slice(-12).join('\n'));
    throw error;
  });
  await live.waitFor({ state: 'detached' });
  console.log(JSON.stringify({ ok: true, liveRow: true, description: true, screenLineCount: lines ?? null, panelExcluded: true, localChecks }));
} finally {
  await app?.close().catch(() => {});
  try { execFileSync('tmux', ['kill-server'], { env: { ...process.env, TMUX_TMPDIR: root } }); } catch {}
  server.close();
  // Claude may still be writing its config while it exits.
  for (let i = 0; i < 5; i++) { try { await rm(root, { recursive: true, force: true }); break; } catch { await new Promise(r => setTimeout(r, 300)); } }
}
