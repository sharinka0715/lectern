// npm run build && node scripts/cache-ttl-e2e.mjs [packaged-executable]
// Settings → Session's prompt-cache lifetimes reach the Claude Code that Lectern starts
// (installed Claude Code, isolated CLAUDE_CONFIG_DIR and tmux, the matrix's loopback fake
// API; no real model request). The user's own settings turn on ENABLE_PROMPT_CACHING_1H, so
// Claude Code's default is 1 hour for both kinds of request: "Claude Code default" must
// leave it at that, "5 minutes" must take effect against it. For each choice a new chat asks
// the model to start a subagent; the `cache_control` markers of the main conversation's and
// the subagent's requests must carry the chosen `ttl`, and the status bar's cache chip must
// show the main conversation's lifetime (statusLine `prompt_cache`). Screenshots of the
// Session page in Chinese and English go to test-results/cache-ttl/.
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
  await writeFile(path.join(config, 'settings.json'), JSON.stringify({
    env: { ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: api.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', ENABLE_PROMPT_CACHING_1H: '1' } }));
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
  const pane = () => {
    try {
      const id = execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{session_name}'], { env: tmuxEnv, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n').filter(line => / lectern-/.test(line)).at(-1)?.split(' ')[0];
      return id ? execFileSync('tmux', ['capture-pane', '-p', '-t', id], { env: tmuxEnv, stdio: ['ignore', 'pipe', 'ignore'] }).toString() : '(no pane)';
    } catch { return '(no tmux)'; }
  };

  const settings = page.getByRole('dialog', { name: '设置' });
  const main = settings.getByRole('combobox', { name: '主对话的提示缓存时长' });
  const other = settings.getByRole('combobox', { name: '子代理等其他请求的缓存时长' });
  const openSession = async () => {
    await page.getByRole('button', { name: '界面与连接设置' }).click();
    await settings.waitFor();
    await settings.locator('nav').getByRole('button', { name: '会话', exact: true }).click();
    await main.waitFor();
  };
  const stored = () => page.evaluate(() => { const p = JSON.parse(localStorage.getItem('lectern.desktop.preferences.v1') ?? '{}'); return [p.promptCacheTtl, p.subagentPromptCacheTtl]; });
  const choose = async (mainTtl, otherTtl) => {
    await openSession();
    await main.selectOption(mainTtl);
    await other.selectOption(otherTtl);
    assert.deepEqual(await stored(), [mainTtl, otherTtl], 'the choice is saved on this computer');
    await page.keyboard.press('Escape');
    await settings.waitFor({ state: 'detached' });
  };

  console.log('stage: settings page');
  await openSession();
  assert.equal(await main.inputValue(), '', 'Claude Code default to begin with');
  assert.equal(await other.inputValue(), '');
  assert.deepEqual(await main.locator('option').allInnerTexts(), ['跟随 Claude Code 默认', '5 分钟', '1 小时']);
  assert.deepEqual(await other.locator('option').allInnerTexts(), ['跟随 Claude Code 默认', '5 分钟', '1 小时']);
  for (const text of ['Claude 订阅在套餐额度内时为 1 小时', '默认都是 5 分钟', 'FORCE_PROMPT_CACHING_5M=1', '已在运行的对话不变']) await settings.getByText(text, { exact: false }).waitFor();
  await other.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, 'settings-session-zh.png') });
  await page.keyboard.press('Escape');
  await settings.waitFor({ state: 'detached' });

  const input = page.getByRole('textbox', { name: '发送给 Claude 的消息' });
  /** A new chat that starts a subagent; the cache lifetimes its requests asked for. */
  const chat = async label => {
    await page.getByRole('button', { name: '在 缓存 新建对话' }).click();
    await page.waitForFunction(() => !document.querySelector('textarea[aria-label="发送给 Claude 的消息"]')?.disabled);
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
    return { main: ttls('ttl'), subagent: ttls('ttl-child') };
  };
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

  console.log('stage: Claude Code default');
  // Nothing injected: the user's own ENABLE_PROMPT_CACHING_1H decides (1 hour for both).
  assert.deepEqual(await chat('默认缓存'), { main: ['1h'], subagent: ['1h'] });
  assert.ok(await chip('1h') >= 50, 'about an hour left');

  console.log('stage: main 5m, others 1h');
  await choose('5m', '1h');
  assert.deepEqual(await chat('主对话五分钟'), { main: ['5m'], subagent: ['1h'] });
  assert.ok(await chip('5m') <= 5, 'at most five minutes left');

  console.log('stage: main 1h, others 5m');
  await choose('1h', '5m');
  assert.deepEqual(await chat('主对话一小时'), { main: ['1h'], subagent: ['5m'] });
  assert.ok(await chip('1h') >= 50, 'about an hour left');

  console.log('stage: restore defaults, English page');
  await openSession();
  await settings.getByRole('button', { name: '恢复默认', exact: true }).click();
  assert.equal(await main.inputValue(), '');
  assert.equal(await other.inputValue(), '');
  assert.deepEqual(await stored(), ['', '']);
  await settings.locator('nav').getByRole('button', { name: '外观', exact: true }).click();
  await settings.getByRole('combobox', { name: '界面语言' }).selectOption('en');
  await page.waitForFunction(() => document.documentElement.lang === 'en-US');
  const english = page.getByRole('dialog', { name: 'Settings' });
  await english.locator('nav').getByRole('button', { name: 'Session', exact: true }).click();
  const englishMain = english.getByRole('combobox', { name: 'Prompt cache lifetime for the main conversation' });
  const englishOther = english.getByRole('combobox', { name: 'Prompt cache lifetime for subagents and other requests' });
  await englishMain.selectOption('1h');
  assert.deepEqual(await englishOther.locator('option').allInnerTexts(), ['Claude Code default', '5 minutes', '1 hour']);
  await englishOther.scrollIntoViewIfNeeded();
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
