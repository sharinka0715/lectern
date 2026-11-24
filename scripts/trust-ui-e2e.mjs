// Renderer-only contract test. Synthetic snapshots/IPC never accept a real
// directory prompt; native trust transactions have separate integration tests.
import assert from 'node:assert/strict';
import { _electron } from './fixtures/electron.mjs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const profile = await mkdtemp(path.join(tmpdir(), 'lectern-trust-ui-'));
const resultDirectory = path.resolve('test-results', `trust-ui-${Date.now()}`);
await mkdir(resultDirectory, { recursive: true });
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: profile, LECTERN_LOG_DIR: path.join(resultDirectory, 'diagnostics'), LECTERN_NODE_BINARY: process.execPath };
delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL;
let app;
try {
  app = await _electron.launch({ args: ['.', '--demo'], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  // The navigation row can be idle while the first native settings query still owns
  // terminal input. Freeze a settled base for the synthetic trust prompts below.
  await page.waitForFunction(() => document.querySelector('.session-row.active')?.getAttribute('data-status') === 'idle' &&
    document.querySelector('.session-settings')?.getAttribute('data-setting-initialization') === 'ready' &&
    !document.querySelector('textarea')?.matches(':disabled, [aria-disabled="true"]'));
  const context = await page.evaluate(async () => {
    const workspace = (await window.desktop.listWorkspaces())[0];
    const sessionId = document.querySelector('.session-row.active').getAttribute('data-session-id');
    const snapshot = await window.desktop.watchSession(workspace.id, sessionId);
    const session = (await window.desktop.discover(workspace.id)).sessions.find(item => item.id === sessionId);
    await window.desktop.unwatchSession();
    return { workspace, snapshot, session };
  });
  const originalBytes = await readFile(context.session.path);
  const originalMessages = await page.locator('.message').count();
  await app.evaluate(({ ipcMain, BrowserWindow }, context) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const fixture = globalThis.__trustFixture = {
      base: context.snapshot, snapshot: context.snapshot, cwd: context.workspace.cwd,
      calls: [], delay: 250, fail: false, wrongPane: false, version: 0,
    };
    fixture.emit = () => contents.send('lectern:snapshot', fixture.snapshot);
    fixture.show = (kind, scope = 'session') => {
      fixture.snapshot = { ...fixture.base, status: 'waiting', navigationStatus: 'waiting', trustBusy: false,
        screen: 'Synthetic native directory safety prompt\n' + fixture.cwd,
        viewport: 'Synthetic native directory safety prompt\n' + fixture.cwd,
        directoryTrust: kind === 'trust' ? {
          token: `synthetic-prompt-${++fixture.version}`, sessionId: fixture.base.sessionId,
          paneId: fixture.base.paneId, cwd: fixture.cwd, scope,
          observedAt: new Date().toISOString(), acceptLabel: 'Yes, I trust this folder (for this session only)', cancelLabel: 'No, exit',
        } : undefined,
      };
      fixture.emit();
    };
    ipcMain.removeHandler('lectern:respondDirectoryTrust');
    ipcMain.handle('lectern:respondDirectoryTrust', async (_event, workspaceId, sessionId, token, decision) => {
      const observed = fixture.snapshot.directoryTrust;
      if (!observed || token !== observed.token || workspaceId !== fixture.base.workspaceId || sessionId !== observed.sessionId)
        throw new Error('Synthetic stale directory prompt');
      fixture.calls.push({ workspaceId, sessionId, token, decision });
      fixture.snapshot = { ...fixture.snapshot, trustBusy: true };
      fixture.emit();
      await new Promise(resolve => setTimeout(resolve, fixture.delay));
      if (fixture.fail || fixture.wrongPane) {
        fixture.snapshot = { ...fixture.snapshot, trustBusy: false };
        fixture.emit();
        if (fixture.fail) throw new Error('Synthetic prompt changed before confirmation');
        return { decision, sessionId, paneId: '%incorrect-pane', closed: true };
      }
      fixture.snapshot = { ...fixture.base, status: 'idle', navigationStatus: decision === 'exit' ? 'history' : 'idle',
        paneId: decision === 'exit' ? undefined : observed.paneId, directoryTrust: undefined, trustBusy: false };
      fixture.emit();
      return { decision, sessionId, paneId: observed.paneId, closed: true };
    });
  }, context);
  const card = page.getByRole('region', { name: '目录信任确认', exact: true });
  const trust = page.getByRole('button', { name: '信任此目录并继续', exact: true });
  const exit = page.getByRole('button', { name: '取消并退出', exact: true });
  const composer = page.getByRole('textbox', { name: '发送给 Claude 的消息', exact: true });

  // Startup may have an idle reducer before a current viewport confirms that
  // the native composer is ready. Never send text into an unknown dialog.
  await app.evaluate(() => {
    const fixture = globalThis.__trustFixture;
    fixture.snapshot = { ...fixture.base, status: 'idle', navigationStatus: 'unknown',
      directoryTrust: undefined, trustBusy: false, screen: '', viewport: '' };
    fixture.emit();
  });
  await page.waitForFunction(() => document.querySelector('.session-row.active')?.getAttribute('data-status') === 'unknown');
  assert.equal(await card.count(), 0);
  assert.equal(await composer.isDisabled(), true, 'An idle compatibility status cannot enable sending before the native viewport confirms readiness');

  await app.evaluate(() => globalThis.__trustFixture.show('generic'));
  await page.locator('.waiting-banner').waitFor();
  assert.equal(await card.count(), 0, 'Generic tool permissions cannot expose directory trust buttons');
  assert.equal(await composer.isDisabled(), true);
  await app.evaluate(() => globalThis.__trustFixture.show('trust'));
  await card.waitFor();
  assert.equal(await card.getAttribute('data-directory-trust-cwd'), context.workspace.cwd);
  assert.equal(await card.getAttribute('data-directory-trust-scope'), 'session');
  assert.match(await card.innerText(), /仅当前会话/);
  assert.equal(await page.locator('.waiting-banner').count(), 0);
  assert.equal(await composer.isDisabled(), true);
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(350);
  assert.equal(await app.evaluate(() => globalThis.__trustFixture.calls.length), 0, 'Showing a prompt and pressing Enter outside its buttons never accepts automatically');
  await page.getByRole('button', { name: '查看原生提示', exact: true }).click();
  await page.getByRole('region', { name: '终端原屏（只读）', exact: true }).waitFor();
  assert.equal(await page.locator('.terminal-keybar').count(), 0);
  await page.screenshot({ path: path.join(resultDirectory, 'session-trust-card.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 600));
  await page.waitForTimeout(150);
  const bounds = await card.boundingBox();
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= await page.evaluate(() => innerHeight), 'Trust card stays inside the minimum-height window');
  await trust.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(resultDirectory, 'trust-minimum-window.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 880));
  await trust.click();
  assert.equal(await exit.isDisabled(), true);
  assert.equal(await composer.isDisabled(), true);
  await card.waitFor({ state: 'detached' });
  await page.waitForFunction(() => !document.querySelector('textarea')?.matches(':disabled, [aria-disabled="true"]'));
  assert.equal(await app.evaluate(() => globalThis.__trustFixture.calls[0].decision), 'trust');

  await app.evaluate(() => { globalThis.__trustFixture.fail = true; globalThis.__trustFixture.show('trust', 'unspecified'); });
  await card.waitFor();
  assert.equal(await card.locator('.directory-trust-scope').count(), 0, 'Unspecified native scope does not claim permanent or session-only trust');
  await exit.click();
  await card.getByRole('alert').waitFor();
  assert.match(await card.getByRole('alert').innerText(), /Synthetic prompt changed/);
  assert.equal(await trust.isDisabled(), false);
  assert.equal(await app.evaluate(() => globalThis.__trustFixture.calls.length), 2, 'Failed trust decisions are not retried automatically');
  await app.evaluate(() => { globalThis.__trustFixture.fail = false; globalThis.__trustFixture.wrongPane = true; });
  await exit.click();
  await page.waitForFunction(() => document.querySelector('.directory-trust-error')?.textContent.includes('当前会话不一致'));
  await app.evaluate(() => { globalThis.__trustFixture.wrongPane = false; });
  await exit.click();
  await card.waitFor({ state: 'detached' });
  await page.waitForFunction(original => document.querySelector('.session-row.active')?.getAttribute('data-session-id') === original && !document.querySelector('textarea')?.matches(':disabled, [aria-disabled="true"]'), context.session.id);
  assert.equal(await page.locator('.error-banner').count(), 0, 'Confirmed exit returns to the workspace and reloads its available session');
  assert.equal(await page.locator('.message').count(), originalMessages);
  assert.deepEqual(await readFile(context.session.path), originalBytes, 'Trust controls never add dialogue or modify JSONL');

  await page.evaluate(() => window.desktop.unwatchSession());
  // Prepare a real isolated fixture pane but delay the create IPC response.
  // This reproduces exit completing AFTER the new-conversation click and
  // BEFORE that request returns, with no intervening selection/watch event.
  const preparedSession = await page.evaluate(workspaceId => window.desktop.createSession(workspaceId), context.workspace.id);
  await app.evaluate(({ ipcMain }, prepared) => {
    const fixture = globalThis.__trustFixture;
    fixture.createStarted = false;
    fixture.createReturned = false;
    ipcMain.removeHandler('lectern:createSession');
    ipcMain.handle('lectern:createSession', async () => {
      fixture.createStarted = true;
      await new Promise(resolve => setTimeout(resolve, 950));
      fixture.createReturned = true;
      return prepared;
    });
    fixture.delay = 250;
    fixture.show('trust');
  }, preparedSession);
  await exit.click();
  // A new chat starts with its first message, while the exit above is still pending.
  await page.getByRole('button', { name: /^新建对话/ }).first().click();
  await composer.fill('你好');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.waitForTimeout(450);
  assert.deepEqual(await app.evaluate(() => ({ started: globalThis.__trustFixture.createStarted, returned: globalThis.__trustFixture.createReturned })), { started: true, returned: false });
  assert.equal(await page.locator('.session-row.active').count(), 0, 'The race occurs while the new chat is still starting');
  await page.waitForFunction(created => document.querySelector('.session-row.active')?.getAttribute('data-session-id') === created && !document.querySelector('textarea')?.matches(':disabled, [aria-disabled="true"]'), preparedSession.id);
  const newSessionId = await page.locator('.session-row.active').getAttribute('data-session-id');
  await page.waitForTimeout(750);
  assert.equal(await card.count(), 0, 'Late confirmation from a previous session never changes the new session');
  assert.equal(await page.locator('.session-row.active').getAttribute('data-session-id'), newSessionId, 'A late exit never navigates away from the newly selected session');
  // The first message went to the new chat once; the offline fixture answers it.
  await page.waitForFunction(() => document.querySelectorAll('.message-user').length === 1
    && document.querySelector('.message-assistant')?.getAttribute('data-source') === 'jsonl' && !document.querySelector('textarea')?.matches(':disabled, [aria-disabled="true"]'), null, { timeout: 15000 });
  assert.equal(await composer.isDisabled(), false);
  const calls = await app.evaluate(() => globalThis.__trustFixture.calls);
  const report = { success: true, scope: 'renderer contract only; synthetic trust snapshots and IPC', genericPermissionsExcluded: true, noAutomaticTrust: true,
    explicitScopeOnly: true, explicitTrustAndExit: true, confirmedExitReturnsToWorkspace: true, failedResultsVisible: true, lateResultsIgnored: true, createIntentSurvivesPendingExit: true, startupUnknownComposerBlocked: true, composerBlockedUntilReady: true, calls: calls.length };
  await writeFile(path.join(resultDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, resultDirectory }));
} catch (error) {
  if (app) await (await app.firstWindow()).screenshot({ path: path.join(resultDirectory, 'failure.png') }).catch(() => {});
  throw error;
} finally { await app?.close(); await rm(profile, { recursive: true, force: true }); }
