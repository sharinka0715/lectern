// The real demo initializes through main; isolated synthetic snapshots then
// exercise renderer menus and races. No installed Claude or model request.
import assert from 'node:assert/strict';
import { _electron } from './fixtures/electron.mjs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const profile = await mkdtemp(path.join(tmpdir(), 'lectern-settings-ui-'));
const resultDirectory = path.resolve('test-results', `settings-ui-${Date.now()}`);
await mkdir(resultDirectory, { recursive: true });
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: profile, LECTERN_LOG_DIR: path.join(resultDirectory, 'diagnostics'), LECTERN_NODE_BINARY: process.execPath };
delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL;
let app;
try {
  const executablePath = process.env.LECTERN_E2E_EXECUTABLE;
  app = await _electron.launch({ executablePath, args: [...(executablePath ? [] : ['.']), '--demo'], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.waitForFunction(() => document.querySelector('.session-settings')?.getAttribute('data-setting-initialization') === 'ready' && !document.querySelector('textarea')?.matches(':disabled, [aria-disabled="true"]'));
  const context = await page.evaluate(async () => {
    const workspace = (await window.desktop.listWorkspaces())[0];
    const sessionId = document.querySelector('.session-row.active').getAttribute('data-session-id');
    const base = await window.desktop.watchSession(workspace.id, sessionId);
    await window.desktop.unwatchSession();
    return { workspace, sessionId, base };
  });
  assert.equal(context.base.settings.initialization, 'ready', 'Main initializes settings without a renderer menu request');
  for (const kind of ['model', 'effort']) {
    const menu = context.base.settings.menus[kind];
    assert.equal(menu.source, 'catalog');
    assert.ok(menu.complete && menu.options.length);
    assert.equal(menu.currentOptionId, undefined, "Demo helper's selection stays private");
  }
  const transcript = await page.evaluate(async ({ workspace, sessionId }) => (await window.desktop.discover(workspace.id)).sessions.find(item => item.id === sessionId)?.path, context);
  const originalBytes = await readFile(transcript);
  const messageCount = await page.locator('.message').count();
  await app.evaluate(({ ipcMain, BrowserWindow }, base) => {
    const sender = BrowserWindow.getAllWindows()[0].webContents;
    const f = globalThis.__settingsFixture = { calls: [], tokens: {}, sessions: {}, version: 0, delay: 180, complete: true, failRead: false, failApply: false, selected: base.sessionId };
    f.menu = (state, kind) => {
      const choices = kind === 'model'
        ? [{ key: 'tenant-a', label: 'Workspace model α' }, { key: 'tenant-b', label: 'Tenant custom β' }]
        : [{ key: 'native-focus', label: 'Focused mode' }, { key: 'native-gentle', label: 'Gentle mode' }];
      const token = `opaque-menu-${++f.version}`;
      const items = choices.map((choice, index) => ({ ...choice, id: `${token}-choice-${index}` }));
      f.tokens[token] = { kind, items };
      const options = items.map(({ key, ...option }) => ({ ...option, current: key === state.values[kind] }));
      return { source: 'catalog', kind, token, sessionId: state.snapshot.sessionId, paneId: state.snapshot.paneId, observedAt: new Date().toISOString(), command: `/${kind}`, options, currentOptionId: options.find(option => option.current)?.id, complete: f.complete };
    };
    f.ensure = (sessionId, paneId = base.paneId) => {
      if (f.sessions[sessionId]) return f.sessions[sessionId];
      const state = f.sessions[sessionId] = { values: { model: 'tenant-a', effort: 'native-focus' }, snapshot: {
        ...base, sessionId, paneId, messages: sessionId === base.sessionId ? base.messages : [],
        status: 'idle', navigationStatus: 'idle', settingBusy: false, terminalControl: undefined,
        settings: { initialization: 'ready', menus: {} },
        executionMode: { mode: 'plan', label: '计划模式', source: 'native-footer', evidence: 'plan mode on' },
        contextUsage: { inputTokens: 1000, cacheReadInputTokens: 27000, cacheCreationInputTokens: 1000, totalInputTokens: 29000, outputTokens: 8000, source: 'jsonl-last-request', windowTokens: null, usedPercent: null },
      } };
      state.snapshot.settings.menus = { model: f.menu(state, 'model'), effort: f.menu(state, 'effort') };
      return state;
    };
    f.publish = (sessionId = f.selected) => { if (sessionId === f.selected) sender.send('lectern:snapshot', f.ensure(sessionId).snapshot); };
    for (const method of ['watchSession', 'unwatchSession', 'getSessionSetting', 'setSessionSetting']) ipcMain.removeHandler(`lectern:${method}`);
    ipcMain.handle('lectern:watchSession', async (event, workspaceId, sessionId) => {
      f.selected = sessionId;
      if (f.watchDelay) await new Promise(resolve => setTimeout(resolve, f.watchDelay));
      const rows = await event.sender.executeJavaScript(`window.desktop.discover(${JSON.stringify(workspaceId)})`);
      const state = f.ensure(sessionId, rows.sessions.find(row => row.id === sessionId)?.paneId);
      f.publish(); return state.snapshot;
    });
    ipcMain.handle('lectern:unwatchSession', () => { f.selected = undefined; });
    ipcMain.handle('lectern:getSessionSetting', async (_event, workspaceId, sessionId, kind) => {
      const s = f.ensure(sessionId);
      f.calls.push({ action: 'get', workspaceId, sessionId, kind });
      await new Promise(resolve => setTimeout(resolve, f.delay));
      if (f.failRead) {
        if (s.snapshot.settings.menus[kind]) s.snapshot.settings.menus[kind].refreshRequired = true;
        s.snapshot.settings.initialization = 'failed'; s.snapshot.settings.error = 'Synthetic native menu unavailable'; f.publish(sessionId);
        throw new Error(s.snapshot.settings.error);
      }
      const menu = f.menu(s, kind);
      s.snapshot.settings.menus[kind] = menu; s.snapshot.settings.initialization = 'ready'; delete s.snapshot.settings.error; f.publish(sessionId);
      return menu;
    });
    ipcMain.handle('lectern:setSessionSetting', async (_event, workspaceId, sessionId, token, optionId) => {
      const s = f.ensure(sessionId), nativeMenu = f.tokens[token], choice = nativeMenu?.items.find(item => item.id === optionId);
      if (!choice || s.snapshot.settings.menus[nativeMenu.kind]?.token !== token) throw new Error('Synthetic stale menu token');
      const kind = nativeMenu.kind;
      f.calls.push({ action: 'set', workspaceId, sessionId, kind, optionId });
      s.snapshot.settingBusy = true; f.publish(sessionId);
      await new Promise(resolve => setTimeout(resolve, f.delay));
      s.snapshot.settingBusy = false; s.values[kind] = choice.key;
      if (f.failApply) {
        s.snapshot.settings = { initialization: 'failed', menus: kind === 'model' ? {} : { model: s.snapshot.settings.menus.model }, error: 'Synthetic verification failure' }; f.publish(sessionId);
        throw new Error(s.snapshot.settings.error);
      }
      const menu = f.menu(s, kind);
      s.snapshot.settings.menus[kind] = menu;
      if (kind === 'model') s.snapshot.settings.menus.effort = f.menu(s, 'effort');
      s.snapshot.settings.initialization = 'ready'; delete s.snapshot.settings.error; f.publish(sessionId);
      return menu;
    });
    f.ensure(base.sessionId); f.publish();
  }, context.base);

  const model = page.locator('[data-setting-kind="model"]');
  const effort = page.locator('[data-setting-kind="effort"]');
  const composer = page.getByRole('textbox', { name: '发送给 Claude 的消息' });
  const close = () => page.getByRole('button', { name: '关闭设置菜单', exact: true }).click();
  const refresh = kind => page.getByRole('button', { name: `重新读取${kind === 'effort' ? '推理强度' : '模型'}`, exact: true }).click();
  const calls = () => app.evaluate(() => globalThis.__settingsFixture.calls.length);
  await page.waitForFunction(() => document.querySelector('[data-setting-kind="model"]')?.textContent.includes('Workspace model α'));
  assert.match(await effort.innerText(), /Focused mode/);
  assert.match(await page.locator('.session-telemetry').innerText(), /计划模式.*上下文输入.*29,000 tokens/s);
  assert.doesNotMatch(await page.locator('.session-telemetry').innerText(), /%/);
  await model.click();
  assert.equal(await composer.isDisabled(), false, 'A cached dropdown does not acquire native input');
  assert.equal(await calls(), 0, 'Initial labels and cached options do not request native menus');
  const tenant = page.locator('[data-setting-menu="model"]').getByRole('option', { name: /Tenant custom β/ });
  const clickedId = await tenant.getAttribute('data-option-id');
  await tenant.click();
  await page.waitForFunction(() => document.querySelector('[data-setting-kind="model"]')?.textContent.includes('Tenant custom β') && !document.querySelector('[data-setting-menu]'));
  assert.notEqual(await model.getAttribute('data-current-option-id'), clickedId);
  await page.waitForFunction(() => document.querySelector('[data-setting-kind="effort"]')?.textContent.includes('Focused mode'));
  await effort.click();
  await page.locator('[data-setting-menu="effort"]').getByRole('option', { name: /Gentle mode/ }).click();
  await page.waitForFunction(() => document.querySelector('[data-setting-kind="effort"]')?.textContent.includes('Gentle mode') && !document.querySelector('[data-setting-menu]'));
  assert.equal(await page.locator('.message').count(), messageCount);
  assert.deepEqual(await readFile(transcript), originalBytes);

  const beforeRestore = await calls();
  await app.evaluate(() => {
    const f = globalThis.__settingsFixture;
    f.ensure(f.selected).snapshot.settings = {
      initialization: 'ready', menus: {},
      observed: { model: { label: 'Previously observed model' }, effort: { label: 'Previously observed effort' } },
    };
    f.publish();
  });
  await page.waitForFunction(() => document.querySelector('[data-setting-kind="model"]')?.textContent.includes('Previously observed model'));
  assert.match(await effort.innerText(), /Previously observed effort/);
  assert.equal(await calls(), beforeRestore, 'Restored labels do not read or apply settings');
  for (const [kind, trigger, current] of [['model', model, 'Tenant custom β'], ['effort', effort, 'Gentle mode']]) {
    assert.equal(await trigger.getAttribute('data-current-option-id'), '');
    await trigger.click();
    const chooser = page.locator(`[data-setting-menu="${kind}"]`);
    await chooser.getByRole('option', { name: current, exact: true }).waitFor();
    assert.equal(await chooser.getByRole('option', { name: /Previously observed/ }).count(), 0);
    await close();
  }
  const restoreActions = await app.evaluate((_electron, start) =>
    globalThis.__settingsFixture.calls.slice(start).map(call => [call.action, call.kind]), beforeRestore);
  assert.deepEqual(restoreActions, [['get', 'model'], ['get', 'effort']]);

  async function dropMenu(kind) {
    await app.evaluate((_electron, kind) => {
      const f = globalThis.__settingsFixture;
      delete f.ensure(f.selected).snapshot.settings.menus[kind];
      f.publish();
    }, kind);
    await page.waitForFunction(kind => !document.querySelector(`[data-setting-kind="${kind}"]`).dataset.currentOptionId, kind);
  }
  const chooser = kind => page.locator(`[data-setting-menu="${kind}"]`);
  await dropMenu('model');
  await app.evaluate(() => { globalThis.__settingsFixture.delay = 650; });
  await model.click();
  await chooser('model').getByText('正在读取这台机器的模型列表…').waitFor();
  assert.equal(await composer.isEnabled(), true, 'Reading the model list does not lock the composer');
  await chooser('model').getByRole('option').first().waitFor();
  await close();
  for (const state of ['working', 'waiting', 'manual']) {
    await app.evaluate((_electron, state) => {
      const f = globalThis.__settingsFixture, s = f.ensure(f.selected).snapshot;
      if (state === 'manual') {
        s.status = s.navigationStatus = 'idle';
        s.terminalControl = { paneId: s.paneId, token: 'manual-test' };
      } else { s.status = s.navigationStatus = state; }
      f.publish();
    }, state);
    await model.click();
    assert.equal(await chooser('model').getByRole('option').count(), 2);
    assert.equal(await chooser('model').locator('[role="option"]:enabled').count(), 0, 'A busy pane can browse but cannot apply');
    await page.keyboard.press('Escape');
  }
  await app.evaluate(() => {
    const f = globalThis.__settingsFixture, s = f.ensure(f.selected).snapshot;
    delete s.terminalControl;
    s.status = s.navigationStatus = 'error'; s.nativeInputReady = true; f.publish();
  });
  await page.waitForFunction(() => !document.querySelector('textarea')?.matches(':disabled, [aria-disabled="true"]'));
  await model.click();
  assert.equal(await chooser('model').locator('[role="option"]:enabled').count(), 2, 'A ready native error allows model recovery');
  await close();
  await app.evaluate(() => {
    const f = globalThis.__settingsFixture, s = f.ensure(f.selected).snapshot;
    s.status = s.navigationStatus = 'idle'; f.complete = false; f.publish();
  });
  await dropMenu('model');
  await model.click();
  await chooser('model').locator('.setting-menu-warning').waitFor();
  assert.equal(await chooser('model').locator('[role="option"]:enabled').count(), 0);
  await app.evaluate(() => { const f = globalThis.__settingsFixture; f.complete = true; f.failRead = true; });
  await refresh('model');
  await chooser('model').getByRole('alert').waitFor();
  await app.evaluate(() => { globalThis.__settingsFixture.failRead = false; });
  await refresh('model');
  await chooser('model').locator('[role="option"]:enabled').first().waitFor();
  await app.evaluate(() => { globalThis.__settingsFixture.failApply = true; });
  await chooser('model').getByRole('option', { name: /Workspace model α/ }).click();
  await chooser('model').getByRole('alert').waitFor();
  assert.equal(await model.getAttribute('data-current-option-id'), '');
  await app.evaluate(() => { globalThis.__settingsFixture.failApply = false; });
  await refresh('model');
  await chooser('model').locator('button[data-current="true"]').filter({ hasText: 'Workspace model α' }).waitFor();
  await page.screenshot({ path: path.join(resultDirectory, 'dynamic-model-menu.png') });
  await close();

  const beforeSwitch = await calls();
  // A new chat starts with its first message (the offline fixture answers it).
  await page.getByRole('button', { name: /^新建对话/ }).first().click();
  await composer.fill('你好');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.waitForFunction(original => {
    const id = document.querySelector('.session-row.active')?.getAttribute('data-session-id');
    return id && id !== original && !document.querySelector('textarea')?.matches(':disabled, [aria-disabled="true"]') && !document.querySelector('.first-message-bar');
  }, context.sessionId);
  const secondId = await page.locator('.session-row.active').getAttribute('data-session-id');
  await app.evaluate(() => { globalThis.__settingsFixture.watchDelay = 350; });
  await page.locator(`.session-row[data-session-id="${context.sessionId}"]`).click();
  await page.waitForFunction(() => document.querySelector('.composer textarea')?.matches(':disabled, [aria-disabled="true"]'));
  assert.equal(await composer.isDisabled(), true, 'Sending is disabled until the selected session loads');
  assert.equal(await effort.isDisabled(), true, 'An effort read waits for the selected pane binding');
  await page.waitForFunction(original => document.querySelector('.session-row.active')?.getAttribute('data-session-id') === original && !document.querySelector('textarea')?.matches(':disabled, [aria-disabled="true"]'), context.sessionId);
  assert.match(await model.innerText(), /Workspace model α/); assert.equal(await calls(), beforeSwitch);
  await app.evaluate((_electron, sessionId) => {
    const f = globalThis.__settingsFixture;
    f.ensure(sessionId).snapshot.settings.menus.model.observedAt = new Date(Date.now() - 24 * 3600_000).toISOString();
    f.publish(sessionId);
  }, context.sessionId);
  await model.click();
  assert.equal(await chooser('model').locator('[role="option"]:enabled').count(), 2);
  assert.equal(await calls(), beforeSwitch, 'The catalog remains valid after the native ticket lifetime');
  await close();
  await dropMenu('model'); await model.click();
  await chooser('model').getByText('正在读取这台机器的模型列表…').waitFor();
  await page.locator(`.session-row[data-session-id="${secondId}"]`).click();
  await page.waitForTimeout(850);
  assert.match(await model.innerText(), /Workspace model α/);
  assert.equal(await page.locator('[data-setting-menu]').count(), 0);
  assert.equal(await composer.isDisabled(), false);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 600)); await page.waitForTimeout(150);
  const bounds = await page.locator('form.composer .session-settings').boundingBox(), sendBounds = await page.getByRole('button', { name: '发送消息', exact: true }).boundingBox();
  assert.ok(bounds.x + bounds.width <= sendBounds.x && Math.abs(bounds.y + bounds.height / 2 - sendBounds.y - sendBounds.height / 2) <= 2 && bounds.x >= 0,
    '模型和推理强度在输入框右下角、发送按钮左边，窄窗口内完整可见');
  const status = await page.locator('.composer-context').boundingBox();
  assert.ok(status.y >= sendBounds.y + sendBounds.height && status.x + status.width <= 900, '状态栏在输入框下方');
  await page.screenshot({ path: path.join(resultDirectory, 'cached-settings-compact.png') });
  const beforeStatus = await calls();
  await app.evaluate(() => {
    const f = globalThis.__settingsFixture, s = f.ensure(f.selected).snapshot;
    s.statusLineManaged = true;
    s.settings = { initialization: 'pending', menus: {} };
    s.statusLine = { sessionId: s.sessionId, modelId: 'model-native', modelName: 'Reported model', contextWindowSize: 1000000 };
    f.publish();
  });
  await page.waitForFunction(() => document.querySelector('[data-setting-kind="model"]')?.textContent.includes('Reported model'));
  assert.equal((await effort.innerText()).trim(), '推理强度', 'Missing report does not borrow an older menu effort');
  assert.match(await page.locator('.session-context-usage').innerText(), /用量未知/);
  assert.match(await page.locator('.session-context-usage').getAttribute('data-tip-detail'), /窗口容量 1,000,000 tokens/);
  await app.evaluate(() => {
    const f = globalThis.__settingsFixture, s = f.ensure(f.selected).snapshot;
    Object.assign(s.statusLine, { effort: 'medium', usedPercentage: 3, inputTokens: 28971 }); f.publish();
  });
  await page.waitForFunction(() => document.querySelector('[data-setting-kind="effort"]')?.textContent.includes('medium'));
  assert.match(await effort.getAttribute('data-tip-detail'), /状态栏上报/);
  assert.equal(await effort.getAttribute('data-current-option-id'), '');
  assert.match(await page.locator('.session-context-usage').innerText(), /3%/);
  assert.match(await page.locator('.session-context-usage progress').getAttribute('aria-valuetext'), /28,971 \/ 1,000,000 tokens/);
  assert.equal(await calls(), beforeStatus, 'Incoming status lines cause no picker reads');
  await effort.click();
  const nativeEffort = page.locator('[data-setting-menu="effort"]');
  const focused = nativeEffort.getByRole('option', { name: 'Focused mode', exact: true });
  await focused.waitFor();
  const firstEffortId = await focused.getAttribute('data-option-id');
  assert.equal(await nativeEffort.getByRole('option', { name: 'medium', exact: true }).count(), 0);
  assert.equal(await calls(), beforeStatus + 1, 'First explicit effort open reads the native choices once');
  await model.click();
  const nativeModel = page.locator('[data-setting-menu="model"]');
  const tenantModel = nativeModel.getByRole('option', { name: 'Tenant custom β', exact: true });
  await tenantModel.waitFor();
  const firstModelId = await tenantModel.getAttribute('data-option-id');
  for (let iteration = 0; iteration < 2; iteration++) {
    await effort.click();
    assert.equal(await focused.getAttribute('data-option-id'), firstEffortId);
    assert.equal(await focused.isEnabled(), true);
    assert.equal(await composer.isDisabled(), false);
    await model.click();
    assert.equal(await tenantModel.getAttribute('data-option-id'), firstModelId);
    assert.equal(await tenantModel.isEnabled(), true);
  }
  assert.equal(await calls(), beforeStatus + 2, 'Alternating managed menus reuses their independent native tickets');
  await effort.click();
  assert.equal(await nativeEffort.getByRole('button', { name: '重新读取推理强度' }).count(), 0);
  assert.equal(await calls(), beforeStatus + 2);
  await page.keyboard.press('Escape');
  assert.equal(await nativeEffort.count(), 0);
  assert.match(await effort.innerText(), /medium/);
  await page.screenshot({ path: path.join(resultDirectory, 'native-status-line.png') });
  const report = { success: true, scope: 'main demo initialization plus synthetic renderer snapshots', initialSettingsAutomatic: true, cacheSurvivesSwitching: true, restoredSelectionsReadOnlyUntilOpen: true, catalogUnaffectedByTicketExpiry: true, missingCapacityHasNoPercentage: true, nativeErrorAllowsRecoverySettings: true, nativeReadyErrorAllowsMessageInput: true, recoveryRetainsInputLocks: true, manualControlExclusive: true, lateSessionResultsIgnored: true, settingsCreateNoChatMessages: true, nativeStatusLineDisplayAndExplicitMenus: true, catalogBrowseWhileBusy: true, catalogDoesNotLockComposer: true, calls: await calls() };
  await writeFile(path.join(resultDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, resultDirectory }));
} catch (error) {
  if (app) await (await app.firstWindow()).screenshot({ path: path.join(resultDirectory, 'failure.png') }).catch(() => {});
  throw error;
} finally { await app?.close(); await rm(profile, { recursive: true, force: true }); }
