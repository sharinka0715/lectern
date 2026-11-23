// npm run build && node scripts/native-dialog-ui-e2e.mjs [packaged-executable]
// The classifier billing notice through a gateway, as a card (installed Claude Code, isolated
// CLAUDE_CONFIG_DIR and tmux, a loopback model; no real model request). A user behind a gateway
// got only a "dialog open" banner for it with Claude Code 2.1.330: the loopback model streams
// like a real one (a reply text, then the call, then a while before the end of the stream), and
// Claude Code then writes the call to the transcript only once its dialog is answered.
// Claude Code shows this notice where it may fall back to its own, billed safety check: with
// telemetry at its default level, or, as here without any outside connection,
// CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF=1 in its environment (scripts/cc-matrix/probe-classifier-failure.mjs).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';
import { answerAutoModeCheck, isAutoModeCheck } from './fixtures/auto-mode-check.mjs';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lectern-native-dialog-')));
const profile = path.join(root, 'profile'), config = path.join(root, 'claude'), cwd = path.join(root, 'work');
// One reply with a checked call per prompt (a pipeline goes to auto mode's check), then plain text.
const plans = { '先查一下': 'first.txt', '再查一次': 'second.txt' };
const served = new Set();
let calls = 0, checks = 0;
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  let body; try { body = JSON.parse(raw); } catch {}
  if (req.method !== 'POST' || !body) return res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  if (isAutoModeCheck(body)) { checks++; return answerAutoModeCheck(res, body); }
  if (!body.stream) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'msg_side', type: 'message', role: 'assistant', model: body.model,
    content: [{ type: 'text', text: 'Native dialog check' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 } }));
  const last = [...(body.messages ?? [])].reverse().find(message => message.role === 'user');
  const text = typeof last?.content === 'string' ? last.content : (last?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const entry = Object.entries(plans).find(([key]) => text.includes(key) && !served.has(key));
  if (entry) served.add(entry[0]);
  const send = (type, fields = {}) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  send('message_start', { message: { id: `msg_dialog_${++calls}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } });
  send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: entry ? '我先去文档里查一下。' : '查完了。' } });
  send('content_block_stop', { index: 0 });
  if (entry) {
    await pause(200);
    const input = { command: `seq -w 1 3 | sed 's/$/ checked/' | tee ${entry[1]}`, description: 'Searching the docs' };
    send('content_block_start', { index: 1, content_block: { type: 'tool_use', id: `toolu_dialog_${calls}`, name: 'Bash', input: {} } });
    send('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
    send('content_block_stop', { index: 1 });
    // A real stream (a gateway's especially) ends a moment after the call: Claude Code has started it by then.
    await pause(1500);
  }
  send('message_delta', { delta: { stop_reason: entry ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } });
  send('message_stop');
  res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let app;
try {
  await Promise.all([profile, config, cwd].map(dir => mkdir(dir, { recursive: true })));
  await writeFile(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [cwd]: { hasTrustDialogAccepted: true } }, customApiKeyResponses: { approved: ['dialog-e2e'] } }));
  await writeFile(path.join(config, 'settings.json'), JSON.stringify({
    env: { ANTHROPIC_API_KEY: 'dialog-e2e', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' } }));
  await writeFile(path.join(profile, 'workspaces.json'), JSON.stringify([{ id: 'gateway', name: '网关', kind: 'local', cwd, claudeDir: config }]));
  const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: profile, TMUX_TMPDIR: root, LECTERN_DIAGNOSTIC_CONTENT: '0', CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF: '1' };
  delete env.LECTERN_DEV_URL; delete env.ELECTRON_RUN_AS_NODE; delete env.TMUX;
  // Lectern's default: nothing moves auto mode's check off the server.
  delete env.CLAUDE_CODE_AUTO_MODE_SERVER;
  const version = /(\d+)\.(\d+)\.(\d+)/.exec(execFileSync('claude', ['--version']).toString())?.slice(1).map(Number) ?? [0, 0, 0];
  const exe = process.argv[2];
  app = await _electron.launch({ args: exe ? [] : ['.'], ...(exe && { executablePath: path.resolve(exe) }), env });
  // Links open in the system browser; here the main process only records them.
  await app.evaluate(({ shell }) => { globalThis.openedLinks = []; shell.openExternal = async url => { globalThis.openedLinks.push(url); }; });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  const tmux = (...a) => { try { return execFileSync('tmux', a, { env: { ...process.env, TMUX_TMPDIR: root }, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { return ''; } };
  const paneId = () => tmux('list-panes', '-a', '-F', '#{pane_id} #{session_name}').split('\n').find(line => / lectern-/.test(line))?.split(' ')[0];
  const transcript = async () => {
    const projects = path.join(config, 'projects');
    const files = existsSync(projects) ? (await Promise.all((await readdir(projects)).map(async dir => (await readdir(path.join(projects, dir))).map(name => path.join(projects, dir, name))))).flat().filter(file => file.endsWith('.jsonl')) : [];
    return (await Promise.all(files.map(file => readFile(file, 'utf8')))).join('');
  };
  const input = page.getByRole('textbox', { name: '发送给 Claude 的消息' });
  const ready = () => page.waitForFunction(() => !document.querySelector('textarea[aria-label="发送给 Claude 的消息"]')?.matches(':disabled, [aria-disabled="true"]'));
  const card = page.locator('section.permission-card[data-permission-kind="auto-mode-billing"]');
  const unavailable = page.locator('section.permission-card[data-permission-kind="auto-mode-unavailable"]');
  const ask = async prompt => {
    await ready();
    await input.fill(prompt);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await card.or(unavailable).waitFor({ timeout: 60000 }).catch(async error => {
      const pane = paneId();
      console.error('PANE\n' + (pane ? tmux('capture-pane', '-p', '-t', pane) : '(none)').split('\n').filter(l => l.trim()).slice(-24).join('\n'));
      console.error('STATE', JSON.stringify(await page.evaluate(() => ({ banner: document.querySelector('.waiting-banner')?.textContent,
        cards: [...document.querySelectorAll('section.question-card')].map(c => c.textContent.slice(0, 200)) }))));
      throw error;
    });
    // The card replaces the "dialog open … take over in the terminal" banner.
    assert.equal(await page.locator('.waiting-banner').count(), 0);
  };

  const idle = timeout => page.waitForFunction(() => document.querySelector('.session-row.active')?.getAttribute('data-status') === 'idle', null, { timeout }).catch(async error => {
    const pane = paneId();
    console.error('PANE\n' + (pane ? tmux('capture-pane', '-p', '-t', pane) : '(none)').split('\n').filter(l => l.trim()).slice(-16).join('\n'));
    console.error('STATE', JSON.stringify(await page.evaluate(() => ({ status: document.querySelector('.session-row.active')?.getAttribute('data-status'),
      rows: [...document.querySelectorAll('.session-row')].map(row => [row.className, row.getAttribute('data-status')]), banner: document.querySelector('.waiting-banner')?.textContent }))));
    const sessions = path.join(config, 'sessions');
    if (existsSync(sessions)) for (const name of await readdir(sessions)) console.error('PRESENCE', name, await readFile(path.join(sessions, name), 'utf8'));
    throw error;
  });
  await page.getByRole('button', { name: '在 网关 新建对话' }).click();
  await ask('先查一下');
  if (await unavailable.count()) {
    // Releases that cannot fall back to their own check here ask "Auto mode can't check actions" (permission-ui-e2e).
    console.log(`NOTE: Claude Code ${version.join('.')} shows "Auto mode can't check actions" instead of the classifier billing notice; skipped`);
    console.log(JSON.stringify({ ok: true, claude: version.join('.'), skipped: 'auto-mode-unavailable' }));
  } else await billingNotice();
  async function billingNotice() {
    const pane = paneId();
    if (!/We're changing auto mode to no longer charge for classifier requests/.test(tmux('capture-pane', '-p', '-t', pane))) throw new Error('not the billing notice');
    // The call this notice holds is not in the transcript yet: the card must not need it.
    const deferred = !/seq -w 1 3/.test(await transcript());
    if (!deferred) console.log(`NOTE: Claude Code ${version.join('.')} wrote the call before its dialog was answered; the deferred case is not exercised`);
    const text = await card.innerText();
    assert.match(text, /auto mode 计费说明/);
    assert.match(text, /However, this session isn't eligible because your requests go through 127\.0\.0\.1:\d+/);
    assert.deepEqual(await card.locator('.question-option strong').allInnerTexts(), ['继续', '取消']);
    assert.equal(await card.locator('.question-option[aria-pressed="true"]').count(), 0, 'nothing is preselected');
    // The help link opens in the system browser; the dialog stays.
    const link = card.locator('a[href="https://code.claude.com/docs/en/auto-mode-classifier-billing"]');
    await link.click();
    await page.waitForTimeout(300);
    assert.deepEqual(await app.evaluate(() => globalThis.openedLinks), ['https://code.claude.com/docs/en/auto-mode-classifier-billing']);
    assert.equal(await card.count(), 1);
    await mkdir('test-results', { recursive: true });
    await card.screenshot({ path: path.join('test-results', 'native-dialog-billing-card.png') });

    // Cancel (Esc): the turn stops, the call does not run, and nothing is remembered.
    await card.locator('[data-permission-cancel]').click();
    await card.waitFor({ state: 'detached' });
    await idle(30000);
    assert.match(tmux('capture-pane', '-p', '-t', pane), /Interrupted · What should Claude do instead\?/);
    assert.equal(existsSync(path.join(cwd, 'first.txt')), false);
    assert.match(await transcript(), /Request interrupted by user for tool use/);

    // The next checked call brings the notice again; continue (Enter) runs it after Claude Code's own check.
    const before = checks;
    await ask('再查一次');
    await card.locator('[data-permission-option="1"]').click();
    await card.waitFor({ state: 'detached' });
    await idle(60000);
    assert.match(await readFile(path.join(cwd, 'second.txt'), 'utf8'), /^1 checked$/m);
    assert.ok(checks > before, 'checked by Claude Code with a request of its own');
    const remembered = JSON.parse(await readFile(path.join(config, '.claude.json'), 'utf8')).autoModeClassifierBillingNoticeAcknowledgedAt;
    assert.equal(typeof remembered, 'number', 'Claude Code remembers the answer for this gateway');
    // The version that ran in the pane (the app's PATH may differ from this script's).
    const ran = /"version":"(\d+\.\d+\.\d+)"/.exec(await transcript())?.[1];
    console.log(JSON.stringify({ ok: true, claude: ran ?? version.join('.'), deferred, cancelled: true, continued: true }));
  }
} finally {
  await app?.close().catch(() => {});
  try { execFileSync('tmux', ['kill-server'], { env: { ...process.env, TMUX_TMPDIR: root } }); } catch {}
  server.close();
  for (let i = 0; i < 5; i++) { try { await rm(root, { recursive: true, force: true }); break; } catch { await new Promise(r => setTimeout(r, 300)); } }
}
