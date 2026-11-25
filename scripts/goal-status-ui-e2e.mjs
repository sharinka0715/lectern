// Claude Code's native /goal through the offline demo (scripts/mock-claude.mjs in a real tmux):
// sending it from the chat box, the goal pill above the input box in each state and its details,
// the goal rows in replies, /goal clear during a reply, reopening and paging back, and keys while the
// indicator's timer ticks (stop, a permission card, a model switch). Screenshots in Chinese and English
// go to test-results/goal-status/. No installed Claude Code, no model request.
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { _electron, resizeWindow } from './fixtures/electron.mjs';

// Record both pushed snapshots and DOM mutations, including a removal undone by the fade observer.
function traceGoal(sessionId) {
  const selector = 'details.goal-status';
  const ids = new WeakMap();
  let nextId = 0;
  const snapshots = [], mutations = [];
  const describe = node => {
    if (!ids.has(node)) ids.set(node, ++nextId);
    const { goalStatus, goalSource, goalPhase, goalCondition, leaving } = node.dataset;
    return { id: ids.get(node), status: goalStatus, source: goalSource, phase: goalPhase, condition: goalCondition, leaving };
  };
  const capsules = node => node instanceof Element ? (node.matches(selector) ? [node] : node.querySelectorAll(selector)) : [];
  const record = (kind, node) => mutations.push({ kind, ...describe(node) });
  const observe = new MutationObserver(records => {
    for (const entry of records) {
      if (entry.type === 'attributes' && entry.target.matches(selector)) {
        record(entry.attributeName, entry.target);
      }
      for (const node of entry.removedNodes) for (const pill of capsules(node)) record('removed', pill);
      for (const node of entry.addedNodes) for (const pill of capsules(node)) record('added', pill);
    }
  });
  observe.observe(document, { subtree: true, childList: true, attributes: true,
    attributeFilter: ['data-leaving', 'data-goal-status', 'data-goal-source', 'data-goal-phase', 'data-goal-condition'] });
  for (const pill of document.querySelectorAll(selector)) record('initial', pill);
  const unsubscribe = window.desktop.onSnapshot(snapshot => {
    if (snapshot.sessionId !== sessionId) return;
    const { status, source, phase, condition } = snapshot.goal ?? {};
    snapshots.push({ connection: snapshot.status, status: status ?? null, source, phase, condition });
  });
  window.goalTrace = () => { observe.disconnect(); unsubscribe(); return { snapshots, mutations }; };
}

const profile = await mkdtemp(path.join(tmpdir(), 'lectern-goal-ui-'));
const results = path.resolve('test-results', 'goal-status');
await mkdir(results, { recursive: true });
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: profile, LECTERN_NODE_BINARY: process.execPath,
  LECTERN_LOG_DIR: path.join(profile, 'diagnostics'), LECTERN_DIAGNOSTIC_CONTENT: '0',
  // Each check shows "running Stop hook" long enough to be read; the check-in comes soon.
  LECTERN_MOCK_GOAL_EVAL_MS: '2500', LECTERN_MOCK_GOAL_CHECKIN_MS: '1500', LECTERN_MOCK_STREAM_MS: '60' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.LECTERN_DEV_URL;
const executablePath = process.env.LECTERN_E2E_EXECUTABLE;
let app, part = 'launch';
try {
  app = await _electron.launch({ executablePath, args: [...(executablePath ? [] : ['.']), '--demo'], env });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(20000);
  await resizeWindow(app, page, 1270, 910);
  await page.locator('.session-row.active[data-session-live="true"]').waitFor();
  const { workspace, session } = await page.evaluate(async () => {
    const [workspace] = await window.desktop.listWorkspaces();
    return { workspace, session: (await window.desktop.discover(workspace.id)).sessions[0] };
  });
  const input = page.locator('textarea');
  const ready = () => page.waitForFunction(() => { const box = document.querySelector('textarea'); return box && !box.matches(':disabled, [aria-disabled="true"]'); });
  // The send button (Enter would take the focused slash completion for a bare "/goal"); during a reply, Enter.
  const send = async text => {
    await ready(); await input.fill(text);
    const button = page.locator('.send-button');
    if (await button.isVisible()) await button.click(); else await input.press('Enter');
  };
  const pillSelector = 'details.goal-status:not([data-leaving])';
  const pill = page.locator(pillSelector);
  const goal = attrs => pill.and(page.locator(attrs));
  const togglePill = async open => { if ((await pill.getAttribute('open') !== null) !== open) await pill.locator('summary').click();
    await page.waitForFunction(([selector, open]) => document.querySelector(selector)?.open === open, [pillSelector, open]); };
  const goalEvent = kind => page.locator(`[data-goal-event="${kind}"]:not([data-leaving])`);
  // Away from the send button first: its tooltip would cover the pill.
  const shot = async name => { await page.mouse.move(640, 300); await page.waitForTimeout(250); await page.screenshot({ path: path.join(results, `${name}.png`) }); };
  const idle = () => page.waitForFunction(() => !document.querySelector('.interrupt-button') && !!document.querySelector('.send-button'));
  const records = async () => (await readFile(session.path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  // The mock holds a goal-hold or mock-hold reply until this file appears (or Esc): no timing involved.
  const release = async () => writeFile(path.join(await app.evaluate(() => process.env.CLAUDE_CONFIG_DIR), 'mock-release'), '');

  part = 'send';
  // The slash list offers /goal with what it does.
  await ready();
  await input.fill('/go');
  const option = page.locator('.composer-completion [role=option]', { hasText: '/goal' });
  await option.waitFor();
  assert.match(await option.locator('.composer-completion-note').innerText(), /设定目标/);
  await input.fill('');
  // The bare command opens Claude Code's own panel; Lectern says how to set one instead.
  await send('/goal');
  await page.locator('.context-toast', { hasText: '/goal' }).waitFor();
  assert.equal(await input.inputValue(), '');
  // Over Claude Code's 4000 characters: refused here, the text stays in the box.
  await send('/goal ' + 'x'.repeat(4001));
  await page.locator('.error-message, [role=alert]', { hasText: '4000' }).first().waitFor();
  assert.equal((await input.inputValue()).length, 4007);
  await input.fill('');

  part = 'met';
  // Not met once ("checking" while the evaluator runs), then met: the pill and the reply's goal rows.
  await send('/goal Finish the two-step task');
  await goal('[data-goal-status="active"][data-goal-condition="Finish the two-step task"]').waitFor();
  assert.equal(await page.locator('.message[data-source="pending"]').count(), 0, 'no sending bubble for /goal');
  await goal('[data-goal-phase="checking"]').waitFor();
  await goal('[data-goal-status="met"]').waitFor();
  await page.locator('.message-user', { hasText: '/goal Finish the two-step task' }).waitFor();
  for (const kind of ['set', 'not-met', 'met']) await goalEvent(kind).last().waitFor();
  assert.match(await pill.innerText(), /目标已达成[\s\S]*2 轮/);
  assert.equal(await page.locator('.message', { hasText: /session-scoped Stop hook|Stop hook feedback|◎/ }).count(), 0);
  await idle();
  await shot('met-zh');
  // The next prompt makes it history.
  await send('你好');
  await page.waitForFunction(selector => !document.querySelector(selector), pillSelector);
  await idle();

  part = 'clear during a reply';
  // The reply goes on after a failed check; the pill opens to its facts, and "Clear goal" (confirmed)
  // sends /goal clear, which Claude Code runs at once: only the cleared record, the reply goes on.
  await send('/goal Keep the reply going goal-hold');
  await goal('[data-goal-phase="not-met"]').waitFor();
  await page.locator('.interrupt-button').waitFor();
  await goal('[data-goal-phase="not-met"]').locator('.turn-progress-count').waitFor();
  await togglePill(true);
  const clear = pill.locator('[data-goal-clear]');
  await clear.waitFor();
  assert.match(await pill.locator('.goal-status-facts').innerText(), /Keep the reply going goal-hold[\s\S]*已检查 1 次[\s\S]*step two is not reported done yet/);
  await shot('active-details-zh');
  await clear.click();
  const dialog = page.locator('dialog.confirm-action');
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /Keep the reply going goal-hold/);
  await dialog.locator('.danger-button').click();
  await goal('[data-goal-status="cleared"]').waitFor();
  await goalEvent('cleared').last().waitFor();
  assert.ok(await page.locator('.interrupt-button').isVisible(), 'the reply goes on (held until released)');
  assert.equal(await page.locator('.message', { hasText: '/goal clear' }).count(), 0, 'no bubble for /goal clear');
  const cleared = (await records()).filter(record => record.attachment?.type === 'goal_status').at(-1);
  assert.deepEqual(cleared.attachment, { type: 'goal_status', met: true, sentinel: true, condition: 'Keep the reply going goal-hold' });
  assert.ok(!(await records()).some(record => record.type === 'system' && /<command-args>clear</.test(record.content ?? '')), 'cleared while busy');
  await release();
  await page.locator('.message-assistant', { hasText: 'Still working on step two.' }).last().waitFor();
  await idle();
  // The bare command opens the pill's details (the ended goal until the next prompt).
  await togglePill(false);
  await send('/goal');
  await goal('[open][data-goal-status="cleared"]').waitFor();
  await shot('cleared-zh');

  part = 'retry';
  // The check could not complete: Claude Code retries (the matrix's goal-check-error), then a typed clear.
  await send('/goal Evaluator error case goal-retry');
  await goal('[data-goal-status="active"][data-goal-phase="retrying"]').waitFor();
  await goalEvent('retry').last().waitFor();
  await idle();
  await send('/goal clear');
  await goal('[data-goal-status="cleared"][data-goal-condition="Evaluator error case goal-retry"]').waitFor();
  await page.waitForTimeout(600);
  assert.equal(await page.locator('.message[data-source="pending"]').count(), 0, 'no sending bubble for /goal clear');

  part = 'check-in';
  // Background work holds the check back; Claude Code's check-in lists it.
  await send('/goal Background work goal-checkin');
  await goal('[data-goal-phase="deferred"]').waitFor();
  const checkin = goalEvent('checkin').last();
  await checkin.locator('summary').click();
  await checkin.locator('.goal-notice-content').waitFor();
  assert.match(await checkin.innerText(), /后台任务仍在运行[\s\S]*bmock0001 · shell · sleep 80/);
  assert.equal(await page.locator('.message-user', { hasText: 'task-notification' }).count(), 0, 'never a user bubble');
  await idle();
  await togglePill(true);
  await pill.locator('.goal-status-tasks').waitFor();
  assert.match(await pill.locator('.goal-status-facts').innerText(), /bmock0001 · shell · sleep 80/);
  await shot('deferred-zh');
  await togglePill(false);

  part = 'paused';
  // Claude paused the goal itself: "◎ /goal paused" on the screen.
  await send('/goal Needs a decision goal-pausetool');
  await goal('[data-goal-phase="paused"][data-goal-condition="Needs a decision goal-pausetool"]').waitFor();
  await goalEvent('paused').last().waitFor();
  await idle();

  part = 'keys while the timer ticks';
  // A permission card with the goal in progress: the card answers, the pill stays.
  const card = page.locator('section.permission-card:not([data-leaving])');
  await send('运行标记命令 permission-late:300');
  await card.waitFor();
  assert.ok(await pill.isVisible(), 'the pill stays beside a permission card');
  await shot('permission-card-zh');
  await card.locator('[data-permission-option="1"]').click();
  await card.waitFor({ state: 'detached' });
  await page.locator('.message-assistant').filter({ hasText: '已允许并运行' }).waitFor();
  await idle();
  // A model switch types /model into the idle box under the ticking indicator.
  await page.locator('button[data-setting-kind="model"]').click();
  await page.locator('.setting-option[role=option]', { hasText: 'Fixture Beta' }).click();
  await page.waitForFunction(() => /Fixture Beta/.test(document.querySelector('button[data-setting-kind="model"]')?.textContent ?? ''));
  // The stop key during a reply.
  // Held until the stop key (Esc), however slow the machine.
  await send('一个要停下的回复 mock-hold');
  await page.locator('.interrupt-button:not(:disabled)').waitFor();
  await page.locator('.interrupt-button').click();
  await idle();
  assert.equal(await goal('[data-goal-status="active"]').count(), 1);

  const condition = 'Needs a decision goal-pausetool';
  const active = goal(`[data-goal-status="active"][data-goal-condition="${condition}"]`);
  const pausedFrom = source => active.and(page.locator(`[data-goal-source="${source}"][data-goal-phase="paused"]`));
  const traces = [];
  const startTrace = () => page.evaluate(traceGoal, session.id);
  const endTrace = async name => traces.push({ name, ...await page.evaluate(() => window.goalTrace()) });
  const row = id => page.locator(`.session-row[data-session-id="${id}"]`);
  const pane = view => page.locator(`.desk-pane[data-view="${view}"]`);
  // Only the target has a goal. Put it in each pane using the same sidebar actions as the user.
  part = 'switch and split fixture';
  await page.locator('.new-chat-button').click();
  await send('另一段对话');
  await page.locator('.session-row[aria-current="page"]').waitFor();
  const other = await page.locator('.session-row[aria-current="page"]').getAttribute('data-session-id');
  assert.notEqual(other, session.id);
  await idle();
  assert.equal(await pill.count(), 0, 'a different conversation has no goal');
  await row(session.id).click();
  await pausedFrom('transcript').waitFor();
  async function switchAndSplit(source) {
    part = `switch and split (${source})`;
    await row(other).click();
    await row(other).and(page.locator('[aria-current="page"]')).waitFor();
    await pill.waitFor({ state: 'detached' });
    await startTrace();
    await row(session.id).click();
    await pausedFrom(source).waitFor();
    await endTrace(`switch back (${source})`);
    await row(other).click();
    await pill.waitFor({ state: 'detached' });
    await startTrace();
    await row(session.id).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '在旁边分屏打开' }).click();
    await pane('secondary').locator(pausedFrom(source)).waitFor();
    assert.equal(await pane('primary').locator(pill).count(), 0, 'no goal in the other split');
    await pane('primary').locator('textarea').click();
    await row(session.id).click();
    await pane('secondary').and(page.locator('[data-active="true"]')).waitFor();
    await endTrace(`open in split and focus again (${source})`);
    await pane('secondary').getByRole('button', { name: '关闭此分屏' }).click();
    await row(session.id).click();
    await pausedFrom(source).waitFor();
  }
  async function retry(source) {
    part = `retry (${source})`;
    await app.evaluate(() => { process.env.LECTERN_DEMO_FAIL_TAG = 'session.poll'; });
    const button = page.locator('.error-banner').getByRole('button', { name: '重试', exact: true });
    await button.waitFor();
    await active.waitFor();
    await startTrace();
    await app.evaluate(() => {
      delete process.env.LECTERN_DEMO_FAIL_TAG;
      process.env.LECTERN_DEMO_LATENCY_MS = '150';
    });
    try {
      await button.click();
      await button.waitFor({ state: 'detached' });
      await pausedFrom(source).waitFor();
      await ready();
      await endTrace(part);
    } finally {
      await app.evaluate(() => { delete process.env.LECTERN_DEMO_LATENCY_MS; });
    }
  }
  async function reload(source) {
    part = `renderer reload (${source})`;
    await page.reload();
    await pausedFrom(source).waitFor();
    await endTrace(part);
  }

  await switchAndSplit('transcript');
  await retry('transcript');
  await page.addInitScript(traceGoal, session.id);
  await reload('transcript');

  part = 'reopen and page back';
  // The goal was set long before the newest page: the first page has none of its records.
  let last = (await records()).filter(record => record.uuid).at(-1).uuid;
  const filler = [];
  for (let i = 0; i < 200; i++) for (const [type, content] of [['user', `填充提问 ${i}`], ['assistant', [{ type: 'text', text: '填充回复。'.repeat(60) + i }]]]) {
    const uuid = randomUUID();
    filler.push(JSON.stringify({ type, uuid, parentUuid: last, sessionId: session.id, cwd: workspace.cwd, timestamp: new Date().toISOString(),
      message: { role: type, content, ...(type === 'assistant' && { id: randomUUID(), stop_reason: 'end_turn' }) } }) + '\n');
    last = uuid;
  }
  await appendFile(session.path, filler.join(''));
  await page.locator('.message-user', { hasText: '填充提问 199' }).waitFor();
  await pausedFrom('transcript').waitFor();
  await retry('probe');
  await switchAndSplit('probe');
  await startTrace();
  // "Load earlier messages" until the start of the conversation.
  const older = page.locator('.history-page-control button');
  for (let i = 0; i < 60 && await older.count(); i++) {
    await older.click().catch(() => {});
    await page.waitForTimeout(150);
  }
  assert.equal(await older.count(), 0, 'paged back to the start');
  await pausedFrom('transcript').waitFor();
  await goalEvent('set').first().waitFor({ state: 'attached' });
  await endTrace('page back (probe to transcript)');
  // A renderer reload has no existing DOM, but its first observation may still come from the cached reader.
  await reload('probe');

  part = 'goal continuity';
  const discontinuities = traces.filter(({ name, snapshots, mutations }) => {
    const first = name.startsWith('retry') ? 0 : snapshots.findIndex(s => s.condition === condition);
    return (first >= 0 && snapshots.slice(first).some(s => s.status !== 'active' || s.condition !== condition))
      || new Set(mutations.map(m => m.id)).size !== 1 || mutations.some(m => m.kind === 'removed' || m.kind === 'data-leaving');
  });
  if (discontinuities.length) console.log(JSON.stringify(traces, null, 2));
  assert.deepEqual(discontinuities.map(({ name }) => name), [], 'the goal capsule stays mounted once shown');

  part = 'english';
  await page.evaluate(() => window.desktop.setLocalePreference('en'));
  await pill.locator('.goal-status-label', { hasText: 'Goal active' }).waitFor();
  await togglePill(true);
  await page.locator('[data-goal-clear]', { hasText: 'Clear goal' }).waitFor();
  await shot('paused-details-en');
  await togglePill(false);
  await page.evaluate(() => window.desktop.setLocalePreference('zh-CN'));
  await pill.locator('.goal-status-label', { hasText: '目标进行中' }).waitFor();

  part = 'impossible';
  await send('/goal Impossible case goal-impossible');
  await goal('[data-goal-status="failed"][data-goal-condition="Impossible case goal-impossible"]').waitFor();
  await goalEvent('failed').last().waitFor();
  await idle();
  await shot('failed-zh');
  await page.evaluate(() => window.desktop.setLocalePreference('en'));
  await pill.locator('.goal-status-label', { hasText: "Goal can't be met" }).waitFor();
  await goalEvent('failed').last().locator('summary').click();
  await shot('failed-en');
  await page.evaluate(() => window.desktop.setLocalePreference('zh-CN'));
  assert.deepEqual(errors, []);
  console.log('PASS: /goal from the chat box (set, clear during a reply, bare, too long), the goal pill (active and its phases, met, failed, cleared) with its details, the goal rows, reopening and paging back, and keys while the indicator ticks.');
} catch (error) {
  console.error(`goal-status-ui-e2e failed in part "${part}"`);
  throw error;
} finally {
  await app?.close().catch(() => {});
}
