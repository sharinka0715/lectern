// npm run build && node scripts/cache-ttl-e2e.mjs [packaged-executable]
// Settings → Session's prompt-cache lifetimes reach the Claude Code that Lectern starts
// (installed Claude Code, isolated CLAUDE_CONFIG_DIR and tmux, the matrix's loopback fake
// API; no real model request). One choice with four values: the default (Lectern sets
// nothing), both 5 minutes, both 1 hour, main conversation 1 hour with the other requests
// 5 minutes. For each a new chat asks the model to start a subagent; the `cache_control`
// markers of the main conversation's and the subagent's requests must carry the expected
// `ttl`, the status bar's cache chip must show the main conversation's lifetime (statusLine
// `prompt_cache`), and the chat's Claude process must have exactly the preset's variables in
// its --settings (none for the default). The user's own settings first turn on
// ENABLE_PROMPT_CACHING_1H, so Claude Code's default is 1 hour for both: the default must
// leave it at that, "both 5 minutes" must take effect against it; then they drop it, so the
// default is the API key's 5 minutes and "both 1 hour" must take effect against that.
// Screenshots of the Session page in Chinese and English go to test-results/cache-ttl/.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';
import { startFakeApi } from './cc-matrix/fake-api.mjs';
import { LOCAL_AUTO_MODE_CHECK } from './fixtures/auto-mode-check.mjs';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lectern-cache-ttl-')));
const profile = path.join(root, 'profile'), config = path.join(root, 'claude'), cwd = path.join(root, 'work');
const shots = path.resolve('test-results', 'cache-ttl');
const key = 'sk-ant-cache-ttl-e2e-0000';
const api = await startFakeApi({ logFile: path.join(root, 'fake-api.jsonl') });
// The main conversation starts one subagent, then answers; the subagent answers at once.
api.script('ttl', ({ step }) => step === 0
  ? { blocks: [{ type: 'tool_use', name: 'Agent', input: { description: 'Cache helper', prompt: 'Report at once ccm:ttl-child', subagent_type: 'general-purpose' } }] }
  : { text: 'Cache check finished.' });
api.script('ttl-child', () => ({ text: 'Child finished.' }));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const tmuxEnv = { ...process.env, TMUX_TMPDIR: root };
delete tmuxEnv.TMUX; delete tmuxEnv.TMUX_PANE;
let app, page;
try {
  await Promise.all([profile, config, cwd, shots].map(dir => mkdir(dir, { recursive: true })));
  await writeFile(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [cwd]: { hasTrustDialogAccepted: true } }, customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] } }));
  /** The user's own settings; with `hour`, ENABLE_PROMPT_CACHING_1H makes 1 hour Claude Code's default. */
  const userSettings = hour => writeFile(path.join(config, 'settings.json'), JSON.stringify({
    env: { ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: api.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', ...(hour && { ENABLE_PROMPT_CACHING_1H: '1' }) } }));
  await userSettings(true);
  await writeFile(path.join(profile, 'workspaces.json'), JSON.stringify([{ id: 'cache', name: '缓存', kind: 'local', cwd, claudeDir: config }]));
  // The Agent call is one auto mode checks: locally here (the fake API is a gateway).
  const env = { ...process.env, ...LOCAL_AUTO_MODE_CHECK, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: profile, TMUX_TMPDIR: root, LECTERN_DIAGNOSTIC_CONTENT: '0', LECTERN_LOG_DIR: path.join(root, 'diagnostics') };
  delete env.LECTERN_DEV_URL; delete env.ELECTRON_RUN_AS_NODE; delete env.TMUX; delete env.TMUX_PANE;
  // The developer's own cache variables would decide the lifetimes for every chat.
  for (const name of ['FORCE_PROMPT_CACHING_5M', 'ENABLE_PROMPT_CACHING_1H', 'CLAUDE_CODE_PROMPT_CACHE_TTL', 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', 'DISABLE_PROMPT_CACHING']) delete env[name];
  const exe = process.argv[2];
  app = await _electron.launch({ args: exe ? [] : ['.'], ...(exe && { executablePath: path.resolve(exe) }), env });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  const tmuxOut = args => execFileSync('tmux', args, { env: tmuxEnv, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  /** Lectern's panes: [pane id, pid of the Claude process it runs]. */
  const lecternPanes = () => {
    try { return tmuxOut(['list-panes', '-a', '-F', '#{pane_id} #{pane_pid} #{session_name}']).split('\n').filter(line => / lectern-/.test(line)).map(line => line.split(' ')); } catch { return []; }
  };
  const pane = () => {
    try {
      const id = lecternPanes().at(-1)?.[0];
      return id ? tmuxOut(['capture-pane', '-p', '-t', id]) : '(no pane)';
    } catch { return '(no tmux)'; }
  };

  const settings = page.getByRole('dialog', { name: '设置' });
  const select = settings.getByRole('combobox', { name: '提示缓存时长' });
  const openSession = async () => {
    await page.getByRole('button', { name: '界面与连接设置' }).click();
    await settings.waitFor();
    await settings.locator('nav').getByRole('button', { name: '会话', exact: true }).click();
    await select.waitFor();
  };
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('lectern.desktop.preferences.v1') ?? '{}').promptCacheTtlPreset);
  const choose = async preset => {
    await openSession();
    await select.selectOption(preset);
    assert.equal(await stored(), preset, 'the choice is saved on this computer');
    await page.keyboard.press('Escape');
    await settings.waitFor({ state: 'detached' });
  };

  console.log('stage: settings page');
  await openSession();
  assert.equal(await select.inputValue(), 'default', 'the default to begin with');
  assert.deepEqual(await select.locator('option').evaluateAll(options => options.map(o => o.value)), ['default', 'both-5m', 'both-1h', 'main-1h-other-5m']);
  assert.deepEqual(await select.locator('option').allInnerTexts(),
    ['默认（由 Claude Code 决定）', '主对话 5 分钟，其他请求 5 分钟', '主对话 1 小时，其他请求 1 小时', '主对话 1 小时，其他请求 5 分钟']);
  for (const text of ['选默认时 Lectern 不做设置', '按你用的是订阅还是 API 决定', 'Claude 订阅的套餐额度内为 1 小时', '其他请求都是 5 分钟', '普通输入的 2 倍', 'FORCE_PROMPT_CACHING_5M=1', '已在运行的对话不变']) {
    await settings.getByText(text, { exact: false }).waitFor();
  }
  await select.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, 'settings-session-zh.png') });
  await page.keyboard.press('Escape');
  await settings.waitFor({ state: 'detached' });

  const input = page.getByRole('textbox', { name: '发送给 Claude 的消息' });
  /** A new chat that starts a subagent; the cache lifetimes its requests asked for, and the
   * cache variables Lectern put in its Claude process's --settings (null: not set). */
  const chat = async label => {
    const known = new Set(lecternPanes().map(([id]) => id));
    await page.getByRole('button', { name: '在 缓存 新建对话' }).click();
    await page.waitForFunction(() => !document.querySelector('textarea[aria-label="发送给 Claude 的消息"]')?.matches(':disabled, [aria-disabled="true"]'));
    const before = api.requests.length;
    await input.fill(`${label} ccm:ttl`);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const mine = () => api.requests.slice(before);
    // Done once the subagent has answered and the main conversation has answered after it.
    for (const end = Date.now() + 90_000; ; await delay(250)) {
      const rows = mine(), child = rows.find(r => r.script === 'ttl-child' && r.done);
      if (child && rows.some(r => r.script === 'ttl' && r.id > child.id && r.done)) break;
      if (Date.now() > end) { console.error('PANE\n' + pane()); console.error(JSON.stringify(rows.map(r => [r.kind, r.script, r.step, r.cacheTtl]))); throw new Error(`${label}: no subagent round trip`); }
    }
    // Which conversation a request belongs to goes by its script (2.1.330 offers subagents Agent too).
    const ttls = script => [...new Set(mine().filter(r => r.script === script).flatMap(r => r.cacheTtl))].sort();
    const fresh = lecternPanes().filter(([id]) => !known.has(id));
    assert.equal(fresh.length, 1, `${label}: one new pane`);
    // The pane runs `exec claude …`, so its pid is Claude Code's; -ww: the whole command line.
    const args = execFileSync('ps', ['-ww', '-o', 'args=', '-p', fresh[0][1]]).toString();
    assert.match(args, /--settings /, `${label}: Claude Code's command line`);
    const variable = name => new RegExp(`"${name}":"([^"]*)"`).exec(args)?.[1] ?? null;
    const launched = { main: variable('CLAUDE_CODE_PROMPT_CACHE_TTL'), other: variable('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL') };
    return { main: ttls('ttl'), subagent: ttls('ttl-child'), launched };
  };
  const unset = { main: null, other: null };
  /** The status bar's cache chip: its lifetime (hover card) and the time left it counts down. */
  const chip = async ttl => {
    const cache = page.locator('.composer-context .telemetry-cache');
    await page.waitForFunction(ttl => document.querySelector('.composer-context .telemetry-cache')?.getAttribute('data-tip-detail')?.includes(`前缀有效期 ${ttl}`), ttl, { timeout: 30000 })
      .catch(async error => { console.error('CHIP', await cache.getAttribute('data-tip-detail').catch(() => '')); throw error; });
    // "59:58", or "1时0分" for a full hour.
    const text = await cache.innerText(), clock = /(\d+):\d\d/.exec(text), hours = /(\d+)时(\d+)分/.exec(text);
    assert.ok(clock || hours, `a countdown on the chip: ${text}`);
    return clock ? Number(clock[1]) : Number(hours[1]) * 60 + Number(hours[2]);
  };

  const hour = async () => assert.ok(await chip('1h') >= 50, 'about an hour left');
  const minutes = async () => assert.ok(await chip('5m') <= 5, 'at most five minutes left');

  console.log('stage: default, user settings with ENABLE_PROMPT_CACHING_1H');
  // Lectern sets nothing: the user's own ENABLE_PROMPT_CACHING_1H decides (1 hour for both).
  assert.deepEqual(await chat('默认缓存'), { main: ['1h'], subagent: ['1h'], launched: unset });
  await hour();

  console.log('stage: both 5 minutes');
  await choose('both-5m');
  assert.deepEqual(await chat('都用五分钟'), { main: ['5m'], subagent: ['5m'], launched: { main: '5m', other: '5m' } });
  await minutes();

  console.log('stage: main 1 hour, others 5 minutes');
  await choose('main-1h-other-5m');
  assert.deepEqual(await chat('主对话一小时'), { main: ['1h'], subagent: ['5m'], launched: { main: '1h', other: '5m' } });
  await hour();

  console.log('stage: restore defaults, user settings without ENABLE_PROMPT_CACHING_1H');
  await openSession();
  await settings.getByRole('button', { name: '恢复默认', exact: true }).click();
  assert.equal(await select.inputValue(), 'default');
  assert.equal(await stored(), 'default');
  await page.keyboard.press('Escape');
  await settings.waitFor({ state: 'detached' });
  await userSettings(false);
  // Lectern still sets nothing; with an API key Claude Code's own default is 5 minutes for both.
  assert.deepEqual(await chat('默认五分钟'), { main: ['5m'], subagent: ['5m'], launched: unset });
  await minutes();

  console.log('stage: both 1 hour');
  await choose('both-1h');
  assert.deepEqual(await chat('都用一小时'), { main: ['1h'], subagent: ['1h'], launched: { main: '1h', other: '1h' } });
  await hour();

  console.log('stage: English page');
  await openSession();
  await settings.locator('nav').getByRole('button', { name: '外观', exact: true }).click();
  await settings.getByRole('combobox', { name: '界面语言' }).selectOption('en');
  await page.waitForFunction(() => document.documentElement.lang === 'en-US');
  const english = page.getByRole('dialog', { name: 'Settings' });
  await english.locator('nav').getByRole('button', { name: 'Session', exact: true }).click();
  const englishSelect = english.getByRole('combobox', { name: 'Prompt cache lifetimes' });
  assert.equal(await englishSelect.inputValue(), 'both-1h');
  assert.deepEqual(await englishSelect.locator('option').allInnerTexts(), ['Default (Claude Code decides)',
    'Main conversation 5 minutes, other requests 5 minutes', 'Main conversation 1 hour, other requests 1 hour', 'Main conversation 1 hour, other requests 5 minutes']);
  for (const text of ['With Default, Lectern sets nothing', 'subscription or the API', 'FORCE_PROMPT_CACHING_5M=1']) await english.getByText(text, { exact: false }).waitFor();
  await englishSelect.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, 'settings-session-en.png') });
  const version = /Claude Code v(\d+\.\d+\.\d+)/.exec(pane())?.[1];
  console.log(JSON.stringify({ ok: true, claude: version, requests: api.requests.length }));
} catch (error) {
  if (page) await Promise.race([page.screenshot({ path: path.join(shots, 'failure.png') }).catch(() => {}), delay(5000)]);
  throw error;
} finally {
  await app?.close().catch(() => {});
  try { execFileSync('tmux', ['kill-server'], { env: tmuxEnv, stdio: 'ignore' }); } catch {}
  await api.close();
  for (let i = 0; i < 5; i++) { try { await rm(root, { recursive: true, force: true }); break; } catch { await delay(300); } }
}
