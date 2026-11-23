// Permission cards before Claude Code's transcript has the call, with the offline mock Claude
// (scripts/mock-claude.mjs): its dialog comes first and the call seconds later (or only once
// answered), and a new session's first response can be written ahead of its prompt (Claude Code
// 2.1.300/2.1.310). The card is there either way, answers, and stays one card when the call arrives.
// Usage: node scripts/permission-early-e2e.mjs [packaged executable]
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';

const profile = await mkdtemp(path.join(tmpdir(), 'lectern-permission-early-'));
const results = path.resolve('test-results');
await mkdir(results, { recursive: true });
// The call above the dialog blinks every 40 ms (Claude Code: about 600 ms), faster than a read and its
// key: each answer is refused unless the key is guarded on the dialog alone (permissionGuardLines).
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: profile, LECTERN_NODE_BINARY: process.execPath,
  LECTERN_LOG_DIR: path.join(profile, 'diagnostics'), LECTERN_DIAGNOSTIC_CONTENT: '0', LECTERN_MOCK_BLINK_MS: '40' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.LECTERN_DEV_URL;
const exe = process.argv[2];
let app;
try {
  app = await _electron.launch({ env, args: exe ? ['--demo'] : ['.', '--demo'], ...(exe && { executablePath: path.resolve(exe) }) });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(20_000);
  await page.locator('.session-row.active[data-session-live="true"]').waitFor();
  await page.waitForFunction(() => document.querySelector('.session-row.active')?.getAttribute('data-status') === 'idle');
  const { workspace, session } = await page.evaluate(async () => {
    const [workspace] = await window.desktop.listWorkspaces();
    return { workspace, session: (await window.desktop.discover(workspace.id)).sessions[0] };
  });
  const input = page.getByRole('textbox', { name: '发送给 Claude 的消息' });
  const card = page.locator('section.permission-card:not([data-leaving])');
  const send = async text => { await input.fill(text); await page.getByRole('button', { name: '发送消息', exact: true }).click(); };
  const calls = async file => (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(row => row.type === 'assistant' && row.message.content.some(block => block.type === 'tool_use'));
  const idle = () => page.waitForFunction(() => document.querySelector('.session-row.active')?.getAttribute('data-status') === 'idle');
  const owned = () => page.waitForFunction(() => document.querySelector('section.permission-card:not([data-leaving])')?.dataset.permissionCall?.startsWith('toolu_mock_'), null, { timeout: 15_000 });

  // 1. The dialog first, its call five seconds later: a card read off the screen, then the same card names its call.
  await send('运行标记命令 permission-late:5000');
  await card.waitFor();
  assert.equal(await card.getAttribute('data-permission-call'), null, 'read off the screen alone');
  assert.deepEqual(await calls(session.path), [], 'the transcript has no tool call yet');
  assert.match(await card.innerText(), /Bash command[\s\S]*Write a marker file[\s\S]*echo allowed > allowed\.txt/);
  assert.deepEqual(await card.locator('[data-permission-option] strong').allInnerTexts(), ['Yes', "Yes, and don't ask again for echo commands in this project", 'No']);
  const token = await card.getAttribute('data-permission-token');
  await page.screenshot({ path: path.join(results, 'permission-early-card.png') });
  await owned();
  assert.equal(await card.count(), 1, 'one card');
  assert.equal(await card.getAttribute('data-permission-token'), token, 'the same card: its token kept');
  await page.locator(`[data-tool-id="${await card.getAttribute('data-permission-call')}"]`).waitFor({ state: 'attached' });
  await card.locator('[data-permission-option="1"]').click();
  await card.waitFor({ state: 'detached' });
  await page.locator('.message-assistant').filter({ hasText: '已允许并运行' }).waitFor();
  assert.ok(existsSync(path.join(workspace.cwd, 'allowed.txt')), 'allowed: the command ran');

  // 2. The call written only once answered: "No" on a card that never had its call.
  await idle();
  await send('再运行一次 permission-late:600000');
  await card.waitFor();
  assert.equal(await card.getAttribute('data-permission-call'), null);
  const before = (await calls(session.path)).length;
  await card.locator('[data-permission-option="3"]').click();
  await card.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelectorAll('article.message-assistant .message-interrupted').length >= 1);
  assert.equal((await calls(session.path)).length, before + 1, 'the call is in the transcript once answered');
  await idle();

  // 3. A new session's first response written ahead of its prompt: the card has its call at once.
  await page.getByRole('button', { name: /^新建对话/ }).first().click();
  await page.waitForFunction(() => !document.querySelector('textarea')?.matches(':disabled, [aria-disabled="true"]') && document.querySelector('.draft-settings'));
  await send('第一条消息 permission-first');
  await card.waitFor({ timeout: 30_000 });
  await owned();
  const fresh = path.join(path.dirname(session.path), `${await page.locator('.session-row.active').getAttribute('data-session-id')}.jsonl`);
  const types = (await readFile(fresh, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line).type);
  assert.ok(types.indexOf('assistant') < types.indexOf('user'), `the call precedes its prompt in the file: ${types.join(' ')}`);
  await page.locator(`[data-tool-id="${await card.getAttribute('data-permission-call')}"]`).waitFor({ state: 'attached' });
  assert.equal(await page.locator('.message-user').filter({ hasText: '第一条消息' }).count(), 1);
  await card.locator('[data-permission-option="1"]').click();
  await card.waitFor({ state: 'detached' });
  await page.locator('.message-assistant').filter({ hasText: '已允许并运行' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: a permission dialog before its call in the transcript is a card that answers, and becomes the call\'s card (same token) when the call arrives; a call written ahead of its prompt has its card at once.');
} finally {
  await app?.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
