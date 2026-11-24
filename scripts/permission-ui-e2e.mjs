// npm run build && node scripts/permission-ui-e2e.mjs [packaged-executable]
// Installed Claude Code with an isolated CLAUDE_CONFIG_DIR, tmux and a loopback
// mock model that asks for tools needing permission. No real model requests.
// With LECTERN_E2E_DIALOG_HOOKS=1 (permission-hooks-e2e) Settings → Session's recording hooks are on:
// the cards then show each call's whole input from its PermissionRequest hook; a dialog Claude Code
// asks without one ("… so this one needs your approval") is read off the screen as before.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from './fixtures/electron.mjs';
import { DIALOG_HOOKS, hookStatus, setDialogHooks } from './fixtures/dialog-hooks.mjs';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lectern-perm-ui-')));
const profile = path.join(root, 'profile'), config = path.join(root, 'claude'), cwd = path.join(root, 'work');
// A second folder whose sessions stay in auto mode, with its own Claude configuration.
const autoConfig = path.join(root, 'claude-auto'), autoCwd = path.join(root, 'work-auto');
// One tool call per prompt, chosen by the prompt text; afterwards plain text.
const plans = {
  '运行命令': { name: 'Bash', input: { command: 'echo hello > greeting.txt', description: 'Write a greeting file' } },
  '写个文件': { name: 'Write', input: { file_path: path.join(cwd, 'new.md'), content: '# New\n' } },
  '清理构建': { name: 'Bash', input: { command: 'rm -rf build', description: 'Remove the build directory' } },
  // Pipelines go to auto mode's safety check, which this loopback "gateway" does not run.
  '检查不了': { name: 'Bash', input: { command: "seq -w 1 3 | sed 's/$/ unchecked/' | tee unchecked.txt", description: 'Write an unchecked file' } },
  '再检查一次': { name: 'Bash', input: { command: "seq -w 1 3 | sed 's/$/ again/' | tee again.txt", description: 'Write another unchecked file' } },
};
let calls = 0;
const served = new Set();
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  let body; try { body = JSON.parse(raw); } catch {}
  if (req.method !== 'POST' || !body?.stream) return res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  // Claude Code may append a system-role reminder after the user's message.
  const last = [...(body.messages ?? [])].reverse().find(message => message.role === 'user');
  const text = typeof last?.content === 'string' ? last.content : (last?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  // Each scripted call is made once; its follow-up request gets plain text.
  const entry = Object.entries(plans).find(([key]) => text.includes(key) && !served.has(key));
  if (entry) served.add(entry[0]);
  const plan = entry?.[1];
  const send = (type, fields = {}) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  send('message_start', { message: { id: `msg_perm_${++calls}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } });
  send('content_block_start', { index: 0, content_block: plan ? { type: 'tool_use', id: `toolu_perm_${calls}`, name: plan.name, input: {} } : { type: 'text', text: '' } });
  send('content_block_delta', { index: 0, delta: plan ? { type: 'input_json_delta', partial_json: JSON.stringify(plan.input) } : { type: 'text_delta', text: '工具已处理。' } });
  send('content_block_stop', { index: 0 });
  send('message_delta', { delta: { stop_reason: plan ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } }); send('message_stop'); res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let app;
try {
  await Promise.all([profile, config, cwd, path.join(cwd, 'build'), autoConfig, autoCwd].map(dir => mkdir(dir, { recursive: true })));
  await writeFile(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [cwd]: { hasTrustDialogAccepted: true } }, customApiKeyResponses: { approved: ['perm-e2e'] } }));
  // The app starts sessions in auto mode, which would run these tools without asking.
  // This user has turned auto mode off (Claude Code's documented opt-out), so the
  // session falls back to manual mode and every tool asks.
  await writeFile(path.join(config, 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'default', disableAutoMode: 'disable' },
    env: { ANTHROPIC_API_KEY: 'perm-e2e', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' } }));
  // Auto mode stays on there. Lectern leaves auto mode's check on the server, which this
  // third-party endpoint does not run, so Claude Code 2.1.321+ asks "Auto mode can't check
  // actions in this session" in the app's own new chats there (steps 4 and 5).
  await writeFile(path.join(autoConfig, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [autoCwd]: { hasTrustDialogAccepted: true } }, customApiKeyResponses: { approved: ['perm-e2e'] } }));
  await writeFile(path.join(autoConfig, 'settings.json'), JSON.stringify({
    env: { ANTHROPIC_API_KEY: 'perm-e2e', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' } }));
  await writeFile(path.join(profile, 'workspaces.json'), JSON.stringify([{ id: 'perm', name: '权限确认', kind: 'local', cwd, claudeDir: config },
    { id: 'auto', name: '自动检查', kind: 'local', cwd: autoCwd, claudeDir: autoConfig }]));
  const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: profile, TMUX_TMPDIR: root, LECTERN_DIAGNOSTIC_CONTENT: '0', ...DIALOG_HOOKS && { TMPDIR: root } };
  delete env.LECTERN_DEV_URL; delete env.ELECTRON_RUN_AS_NODE; delete env.TMUX;
  // Lectern's default: nothing moves auto mode's check off the server (manual mode in the first folder has none).
  delete env.CLAUDE_CODE_AUTO_MODE_SERVER;
  const exe = process.argv[2];
  app = await _electron.launch({ args: exe ? [] : ['.'], ...(exe && { executablePath: path.resolve(exe) }), env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  if (DIALOG_HOOKS) await setDialogHooks(page, true);
  // A new chat: Claude Code starts with its first message (sent in step 1).
  await page.getByRole('button', { name: '在 权限确认 新建对话' }).click();
  const tmux = (...a) => { try { return execFileSync('tmux', a, { env: { ...process.env, TMUX_TMPDIR: root }, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { return ''; } };
  const paneId = () => tmux('list-panes', '-a', '-F', '#{pane_id} #{session_name}').split('\n').find(line => / lectern-/.test(line))?.split(' ')[0];
  // Watch the pane until the permission card shows: the auto-mode prompt must never block.
  const dismissStartupPrompt = async () => {
    let since;
    for (let i = 0; i < 160; i++) {
      const pane = paneId(), screen = pane ? tmux('capture-pane', '-p', '-t', pane) : '';
      // The app has to get past this prompt itself; the test never answers it.
      if (!/Make auto mode your default/.test(screen)) since = undefined;
      else if (Date.now() - (since ??= Date.now()) > 10_000) throw new Error('the auto-mode prompt blocks the first message');
      if (await page.locator('section.permission-card:not([data-leaving])').count()) return;
      await new Promise(r => setTimeout(r, 250));
    }
  };
  const input = page.getByRole('textbox', { name: '发送给 Claude 的消息' });
  const ready = () => page.waitForFunction(() => !document.querySelector('textarea[aria-label="发送给 Claude 的消息"]')?.matches(':disabled, [aria-disabled="true"]'));
  const card = page.locator('section.permission-card:not([data-leaving])');
  const ask = async prompt => {
    await ready();
    await input.fill(prompt);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await card.waitFor().catch(async error => {
      const pane = paneId();
      console.error('PANE\n' + (pane ? tmux('capture-pane', '-p', '-t', pane) : '(none)').split('\n').filter(l => l.trim()).slice(-24).join('\n'));
      console.error('STATE', JSON.stringify(await page.evaluate(() => ({ status: document.querySelector('.session-row.active')?.getAttribute('data-status'),
        banner: document.querySelector('.waiting-banner')?.textContent, messages: [...document.querySelectorAll('.message')].map(m => m.textContent.slice(0, 120)) }))));
      throw error;
    });
    assert.equal(await page.locator('.waiting-banner').count(), 0, 'the card replaces the "view the terminal" notice');
    return card;
  };
  const finished = async () => {
    await card.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelector('.session-row.active')?.getAttribute('data-status') === 'idle', null, { timeout: 30000 });
  };

  // 1. Yes: the command runs.
  await Promise.all([ask('运行命令'), dismissStartupPrompt()]);
  // Auto mode is off for this user, so the session asks in manual mode.
  assert.equal(await page.locator('.session-execution-mode').getAttribute('data-execution-mode'), 'default');
  assert.match(await card.innerText(), /Bash command/);
  // With the hooks the card shows the call's whole input (its PermissionRequest) in place of the dialog's box.
  assert.match(await card.locator(DIALOG_HOOKS ? '.permission-call[data-permission-hook-tool="Bash"]' : '.permission-content').innerText(), /echo hello > greeting\.txt/);
  if (DIALOG_HOOKS) { await mkdir('test-results', { recursive: true }); await card.screenshot({ path: path.join('test-results', 'permission-hooks-card.png') }); }
  const labels = await card.locator('[data-permission-option] strong').allInnerTexts();
  console.error('BASH OPTIONS', JSON.stringify(labels));
  assert.equal(labels[0], 'Yes');
  assert.match(labels.at(-1), /^No\b/);
  await card.locator('[data-permission-option="1"]').click();
  await finished();
  assert.equal((await readFile(path.join(cwd, 'greeting.txt'), 'utf8')).trim(), 'hello');

  // 2. No: the file is not created and the composer takes guidance.
  await ask('写个文件');
  assert.match(await card.innerText(), /Create file/);
  assert.match(await card.innerText(), /Do you want to create new\.md\?/);
  if (DIALOG_HOOKS) assert.match(await card.locator('.permission-call[data-permission-hook-tool="Write"]').innerText(), /# New/);
  const writeLabels = await card.locator('[data-permission-option] strong').allInnerTexts();
  console.error('WRITE OPTIONS', JSON.stringify(writeLabels));
  await card.locator(`[data-permission-option="${writeLabels.length}"]`).click();
  await finished();
  assert.equal(existsSync(path.join(cwd, 'new.md')), false);
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '发送给 Claude 的消息');

  // 3. Esc on the card cancels: nothing is removed.
  await ask('清理构建');
  await card.locator('[data-permission-option="1"]').focus();
  await page.keyboard.press('Escape');
  await finished();
  assert.equal(existsSync(path.join(cwd, 'build')), true);
  const pane = paneId();
  assert.match(tmux('capture-pane', '-p', '-t', pane), /Interrupted · What should Claude do instead\?/);

  // Claude Code's interruption markers are not user messages; the replies say so instead.
  const users = await page.locator('.message-user').allInnerTexts();
  assert.ok(!users.some(text => text.includes('[Request interrupted')), JSON.stringify(users));
  // Both refusals end their reply as interrupted once the transcript has the markers.
  await page.waitForFunction(() => document.querySelectorAll('.message-interrupted').length >= 2, null, { timeout: 15000 }).catch(async error => {
    console.error('MESSAGES', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.message')].map(m => [m.className, m.textContent.slice(0, 100)]))));
    throw error;
  });
  // The transcript records the decisions as Claude Code wrote them.
  const projects = path.join(config, 'projects');
  const jsonl = execFileSync('sh', ['-c', `cat "${projects}"/*/*.jsonl`]).toString();
  assert.equal((jsonl.match(/User rejected tool use/g) ?? []).length, 2);

  // 4. "Auto mode can't check actions in this session": a card, never answered by Lectern.
  const unavailable = page.locator('section.permission-card:not([data-leaving])[data-permission-kind="auto-mode-unavailable"]');
  const dumpPanes = async () => {
    for (const pane of tmux('list-panes', '-a', '-F', '#{pane_id} #{session_name}').split('\n').filter(line => / lectern-/.test(line)).map(line => line.split(' ')[0]))
      console.error(`PANE ${pane}\n` + tmux('capture-pane', '-p', '-t', pane).split('\n').filter(l => l.trim()).slice(-30).join('\n'));
    console.error('ROWS', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.session-row')].map(row => [row.getAttribute('data-session-id'), row.textContent.slice(0, 60)]))));
  };
  const startAuto = async prompt => {
    // A new chat the app starts in that folder, with Lectern's own launch settings.
    await page.getByRole('button', { name: '在 自动检查 新建对话' }).click();
    await ready();
    await input.fill(prompt);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await unavailable.waitFor({ timeout: 60000 }).catch(async error => {
      await dumpPanes();
      console.error('STATE', JSON.stringify(await page.evaluate(() => ({ status: document.querySelector('.session-row.active')?.getAttribute('data-status'),
        cards: [...document.querySelectorAll('section.question-card')].map(c => c.textContent.slice(0, 200)), placeholder: document.querySelector('form.composer textarea')?.getAttribute('placeholder') }))));
      throw error;
    });
    const id = await page.locator('.session-row.active').getAttribute('data-session-id');
    return tmux('list-panes', '-a', '-F', '#{pane_id} #{session_name}').split('\n').find(line => line.includes(` lectern-${id.slice(0, 8)}`))?.split(' ')[0];
  };
  // Before 2.1.321, Claude Code shows its classifier billing notice here instead (the matrix covers it).
  const version = /(\d+)\.(\d+)\.(\d+)/.exec(execFileSync('claude', ['--version']).toString())?.slice(1).map(Number) ?? [0, 0, 0];
  const asksUnavailable = version[0] * 1e6 + version[1] * 1e3 + version[2] >= 2_001_321;
  if (!asksUnavailable) console.log(`NOTE: Claude Code ${version.join('.')} shows the classifier billing notice instead of "Auto mode can't check actions"; steps 4 and 5 skipped`);
  if (asksUnavailable) {
    const ownPane = await startAuto('检查不了');
    assert.equal(await page.locator('.session-execution-mode').getAttribute('data-execution-mode'), 'auto');
    const text = await unavailable.innerText();
    assert.match(text, /auto mode 无法检查操作/);
    assert.match(text, /Auto mode can't check actions in this session/);
    assert.match(text, /You can stay in auto mode and approve each action that needs the check yourself\./);
    assert.deepEqual(await unavailable.locator('[data-permission-option] strong').allInnerTexts(), ['留在 auto mode', '改用 accept edits 模式并停止本轮']);
    assert.deepEqual(await unavailable.locator('.question-mark').allInnerTexts(), ['Enter', '⇧Tab']);
    assert.equal(await unavailable.locator('.question-option[aria-pressed="true"]').count(), 0, 'nothing is preselected');
    await mkdir('test-results', { recursive: true });
    await unavailable.screenshot({ path: path.join('test-results', 'permission-auto-mode-unavailable.png') });
    // Digits pick nothing here (the native dialog has no numbers), and nothing answers by itself.
    await unavailable.locator('[data-permission-option="1"]').focus();
    await page.keyboard.press('1');
    await page.waitForTimeout(1500);
    assert.equal(await unavailable.count(), 1);
    assert.match(tmux('capture-pane', '-p', '-t', ownPane), /Enter to stay in auto mode/);
    await unavailable.locator('[data-permission-option="1"]').click();
    await unavailable.waitFor({ state: 'detached' });
    // Staying: this action now asks like any tool, "No" focused first; approve it.
    await card.waitFor();
    assert.match(await card.innerText(), /Auto mode can't check actions in this session, so this one needs your approval/);
    // Claude Code asks this one without a PermissionRequest: the screen alone, as without hooks.
    assert.equal(await card.locator('.permission-call').count(), 0, 'no hook data for a dialog without its hook');
    assert.deepEqual(await card.locator('[data-permission-option] strong').allInnerTexts(), ['No', 'Yes']);
    assert.equal(await card.locator('[data-permission-option="1"]').getAttribute('aria-pressed'), 'true');
    await card.locator('[data-permission-option="2"]').click();
    await finished();
    assert.match(await readFile(path.join(autoCwd, 'unchecked.txt'), 'utf8'), /^1 unchecked$/m);

    // 5. Leaving for accept edits mode stops the turn; the waiting action never runs.
    await startAuto('再检查一次');
    await unavailable.locator('[data-permission-option="2"]').click();
    await unavailable.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelector('.session-execution-mode')?.getAttribute('data-execution-mode') === 'acceptEdits', null, { timeout: 30000 });
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '发送给 Claude 的消息', null, { timeout: 30000 });
    assert.equal(existsSync(path.join(autoCwd, 'again.txt')), false);
  }
  const hooks = DIALOG_HOOKS ? (await hookStatus(page, 'active', 20_000, path.join('test-results', 'settings-dialog-hooks.png'))).state : undefined;
  if (DIALOG_HOOKS) assert.equal(hooks, 'active');
  console.log(JSON.stringify({ ok: true, approved: true, rejected: true, cancelled: true, autoModeUnavailable: asksUnavailable ? { stayed: true, left: true } : 'skipped', hooks }));
} finally {
  await app?.close().catch(() => {});
  try { execFileSync('tmux', ['kill-server'], { env: { ...process.env, TMUX_TMPDIR: root } }); } catch {}
  server.close();
  for (let i = 0; i < 5; i++) { try { await rm(root, { recursive: true, force: true }); break; } catch { await new Promise(r => setTimeout(r, 300)); } }
}
