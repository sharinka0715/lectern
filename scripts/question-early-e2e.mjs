// npm run build && node scripts/question-early-e2e.mjs [packaged-executable]
// AskUserQuestion before the transcript has the call, as a card (installed Claude Code, isolated
// CLAUDE_CONFIG_DIR and tmux, a loopback model; no real model request). The loopback model streams
// like a real one: a reply text, then the call, then a while before the end of the stream (a
// gateway's late end of stream). Claude Code 2.1.300–2.1.330 then write the reply and the call only
// once the question is answered (scripts/cc-matrix/probe-question-order.mjs); a user behind a gateway
// got only a "Claude is waiting" banner for it. One question answered with a choice, then two
// questions (a choice, two checked boxes, the review and submit); each answer must reach its call.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lectern-question-early-')));
const profile = path.join(root, 'profile'), config = path.join(root, 'claude'), cwd = path.join(root, 'work');
const drink = { header: '饮品', question: '午餐时喝什么？', multiSelect: false, options: [{ label: '茶', description: '热饮' }, { label: '果汁', description: '冷饮' }] };
const snacks = { header: '点心', question: '要准备哪些点心？', multiSelect: true, options: [{ label: '点心 A', description: '甜味' }, { label: '点心 B', description: '咸味' }] };
// Prompt → the questions, and the call's id.
const plans = { '先问一个问题': [[drink], 'toolu_question_one'], '再问两个问题': [[{ ...drink, header: '饮料', question: '下午喝什么？' }, snacks], 'toolu_question_two'] };
const served = new Set();
let calls = 0;
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  let body; try { body = JSON.parse(raw); } catch {}
  if (req.method !== 'POST' || !body) return res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  if (!body.stream) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'msg_side', type: 'message', role: 'assistant', model: body.model,
    content: [{ type: 'text', text: 'Question check' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 } }));
  const last = [...(body.messages ?? [])].reverse().find(message => message.role === 'user');
  const text = typeof last?.content === 'string' ? last.content : (last?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const entry = Object.entries(plans).find(([key]) => text.includes(key) && !served.has(key));
  if (entry) served.add(entry[0]);
  const send = (type, fields = {}) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  send('message_start', { message: { id: `msg_question_${++calls}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } });
  send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: entry ? '开始之前先问清楚。' : '好的，记下了。' } });
  send('content_block_stop', { index: 0 });
  if (entry) {
    await pause(200);
    send('content_block_start', { index: 1, content_block: { type: 'tool_use', id: entry[1][1], name: 'AskUserQuestion', input: {} } });
    send('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ questions: entry[1][0] }) } });
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
  await writeFile(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [cwd]: { hasTrustDialogAccepted: true } }, customApiKeyResponses: { approved: ['question-e2e'] } }));
  await writeFile(path.join(config, 'settings.json'), JSON.stringify({
    env: { ANTHROPIC_API_KEY: 'question-e2e', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' } }));
  await writeFile(path.join(profile, 'workspaces.json'), JSON.stringify([{ id: 'gateway', name: '网关', kind: 'local', cwd, claudeDir: config }]));
  const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: profile, TMUX_TMPDIR: root, LECTERN_DIAGNOSTIC_CONTENT: '0', LECTERN_LOG_DIR: path.join(root, 'diagnostics') };
  delete env.LECTERN_DEV_URL; delete env.ELECTRON_RUN_AS_NODE; delete env.TMUX;
  const exe = process.argv[2];
  app = await _electron.launch({ args: exe ? [] : ['.'], ...(exe && { executablePath: path.resolve(exe) }), env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  const tmux = (...a) => { try { return execFileSync('tmux', a, { env: { ...process.env, TMUX_TMPDIR: root }, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { return ''; } };
  const paneId = () => tmux('list-panes', '-a', '-F', '#{pane_id} #{session_name}').split('\n').find(line => / lectern-/.test(line))?.split(' ')[0];
  const records = async () => {
    const projects = path.join(config, 'projects');
    const files = existsSync(projects) ? (await Promise.all((await readdir(projects)).map(async dir => (await readdir(path.join(projects, dir))).map(name => path.join(projects, dir, name))))).flat().filter(file => file.endsWith('.jsonl')) : [];
    return (await Promise.all(files.map(file => readFile(file, 'utf8')))).join('').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } });
  };
  const blocks = row => Array.isArray(row.message?.content) ? row.message.content : [];
  const callIn = (rows, id) => rows.some(row => blocks(row).some(block => block.type === 'tool_use' && block.id === id));
  /** The answers Claude Code recorded for this call, once its result is in the transcript. */
  const answers = async id => {
    for (const end = Date.now() + 30000; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 200))) {
      const rows = await records();
      const result = rows.find(row => blocks(row).some(block => block.type === 'tool_result' && block.tool_use_id === id));
      if (result) { assert.ok(callIn(rows, id), 'the call is in the transcript with its result'); return result.toolUseResult?.answers; }
    }
    throw new Error(`no result for ${id}`);
  };
  const dump = async () => {
    const pane = paneId();
    console.error('PANE\n' + (pane ? tmux('capture-pane', '-p', '-t', pane) : '(none)').split('\n').filter(l => l.trim()).slice(-24).join('\n'));
    console.error('STATE', JSON.stringify(await page.evaluate(() => ({ banner: document.querySelector('.waiting-banner')?.textContent,
      status: document.querySelector('.session-row.active')?.getAttribute('data-status'), cards: [...document.querySelectorAll('section.question-card, section.permission-card')].map(c => c.textContent.slice(0, 200)) }))));
    const sessions = path.join(config, 'sessions');
    if (existsSync(sessions)) for (const name of await readdir(sessions)) console.error('PRESENCE', name, await readFile(path.join(sessions, name), 'utf8'));
  };
  const input = page.getByRole('textbox', { name: '发送给 Claude 的消息' });
  const card = page.getByRole('region', { name: '原生问答' });
  const row = number => card.locator(`button.question-option[data-question-number="${number}"]`);
  const idle = () => page.waitForFunction(() => document.querySelector('.session-row.active')?.getAttribute('data-status') === 'idle', null, { timeout: 60000 }).catch(async error => { await dump(); throw error; });
  const deferred = [];
  const ask = async (prompt, id) => {
    await page.waitForFunction(() => !document.querySelector('textarea[aria-label="发送给 Claude 的消息"]')?.disabled);
    await input.fill(prompt);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await card.waitFor({ timeout: 60000 }).catch(async error => { await dump(); throw error; });
    // The card replaces the "Claude is waiting … take over in the terminal" banner.
    assert.equal(await page.locator('.waiting-banner').count(), 0);
    // The call this question belongs to is not in the transcript yet: the card must not need it.
    const early = !callIn(await records(), id);
    deferred.push(early);
    if (early) assert.equal(await card.getAttribute('data-question-call'), null, 'a card read off the screen alone names no call');
    else console.log(`NOTE: the call ${id} was in the transcript before its question was answered; the deferred case is not exercised`);
  };

  await page.getByRole('button', { name: '在 网关 新建对话' }).click();
  await ask('先问一个问题', 'toolu_question_one');
  assert.equal(await card.locator('h3').innerText(), drink.question);
  assert.deepEqual((await card.locator('button.question-option strong').allInnerTexts()).slice(0, 2), ['茶', '果汁']);
  await row(2).click();
  await card.waitFor({ state: 'detached' });
  assert.deepEqual(await answers('toolu_question_one'), { [drink.question]: '果汁' });
  await idle();
  // The answer is shown on its call in the chat once Claude Code has written both.
  await page.locator('[data-tool-id="toolu_question_one"]').waitFor();
  await mkdir('test-results', { recursive: true });

  await ask('再问两个问题', 'toolu_question_two');
  const [first, second] = plans['再问两个问题'][0];
  assert.equal(await card.locator('h3').innerText(), first.question);
  await card.screenshot({ path: path.join('test-results', 'question-early-card.png') });
  await row(1).click();
  await card.getByText(second.question, { exact: true }).waitFor();
  for (const number of [1, 2]) {
    await row(number).click();
    await page.waitForFunction(n => document.querySelector(`section.question-card button.question-option[data-question-number="${n}"]`)?.getAttribute('aria-pressed') === 'true', number);
  }
  await card.locator('nav.question-nav button').last().click();
  await card.locator('dl.question-review').waitFor();
  await card.locator('footer.question-actions button.primary-button').first().click();
  await card.waitFor({ state: 'detached' });
  assert.deepEqual(await answers('toolu_question_two'), { [first.question]: '茶', [second.question]: '点心 A, 点心 B' });
  await idle();
  await page.locator('[data-tool-id="toolu_question_two"]').waitFor();
  assert.equal(await card.count(), 0, 'no card for an answered question');
  const ran = /"version":"(\d+\.\d+\.\d+)"/.exec(JSON.stringify(await records()))?.[1];
  console.log(JSON.stringify({ ok: true, claude: ran, deferred }));
} finally {
  await app?.close().catch(() => {});
  try { execFileSync('tmux', ['kill-server'], { env: { ...process.env, TMUX_TMPDIR: root } }); } catch {}
  server.close();
  for (let i = 0; i < 5; i++) { try { await rm(root, { recursive: true, force: true }); break; } catch { await new Promise(r => setTimeout(r, 300)); } }
}
