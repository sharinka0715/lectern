// Isolated Electron + real tmux fixture. No native Claude model request.
import assert from 'node:assert/strict';
import { _electron } from './fixtures/electron.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('test-results', `manual-ui-${Date.now()}`);
await mkdir(root, { recursive: true });
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: path.join(root, 'profile'), LECTERN_LOG_DIR: path.join(root, 'diagnostics'), LECTERN_LOG_CONTENT: '1', LECTERN_NODE_BINARY: process.execPath };
delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL;
const report = { success: false, root, checks: [], nativeModelRequests: 0 };
let app, page;
try {
  const executablePath = process.argv[2];
  app = await _electron.launch({ ...(executablePath && { executablePath: path.resolve(executablePath) }), args: [...(executablePath ? [] : ['.']), '--demo'], env });
  page = await app.firstWindow(); page.setDefaultTimeout(20000);
  // Idle and read: while the chat is still loading the row already shows the folder scan's status.
  await page.waitForFunction(() => { const row = document.querySelector('.session-row.active'); return row?.getAttribute('data-status') === 'idle' && !row.hasAttribute('data-loading'); });
  await page.locator('.message-user').first().waitFor();
  await page.evaluate(() => { window.__manualSnapshots = []; window.desktop.onSnapshot(s => { window.__manualSnapshot = s; window.__manualSnapshots.push(s); }); });
  const oldUsers = await page.locator('.message-user').count();
  await page.getByTitle('查看终端原屏').click();
  const panel = page.locator('.terminal-panel'), screen = panel.locator('pre');
  assert.equal(await panel.getAttribute('data-terminal-control'), 'false');
  await screen.focus(); await page.keyboard.type('MUST_NOT_SEND'); await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.message-user').count(), oldUsers);
  report.checks.push('default-readonly');
  await page.locator('[data-terminal-action="take"]').click();
  await page.waitForFunction(() => document.querySelector('.terminal-panel')?.getAttribute('data-terminal-control') === 'true');
  const terminal = page.getByRole('textbox', { name: '原生终端输入' });
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '原生终端输入');
  await page.waitForFunction(() => document.querySelector('.terminal-panel .xterm-rows')?.textContent.includes('offline fixture'));
  assert.equal(await panel.locator('[data-terminal-key], .terminal-text-entry').count(), 0);
  await terminal.press('F6');
  assert.equal(await panel.locator('[data-terminal-action="release"]').evaluate(node => node === document.activeElement), true);
  assert.equal(await page.getByRole('textbox', { name: '发送给 Claude 的消息' }).isDisabled(), true);
  for (const kind of ['model', 'effort']) {
    await page.locator(`[data-setting-kind="${kind}"]`).click();
    const menu = page.locator(`[data-setting-menu="${kind}"]`);
    await menu.getByRole('option').first().waitFor();
    assert.equal(await menu.locator('[role="option"]:enabled').count(), 0);
    await page.keyboard.press('Escape');
  }
  const lease = await page.evaluate(() => ({ ...window.__manualSnapshot.terminalControl, workspaceId: window.__manualSnapshot.workspaceId, sessionId: window.__manualSnapshot.sessionId }));
  await terminal.focus(); await page.keyboard.type('/model'); await terminal.press('Enter');
  await page.waitForFunction(() => window.__manualSnapshot?.viewport.includes('Select model'));
  await terminal.press('ArrowDown');
  await page.waitForFunction(() => /❯ 2\. Fixture Beta/.test(window.__manualSnapshot?.viewport));
  await terminal.press('Escape');
  await page.waitForFunction(() => !window.__manualSnapshot?.viewport.includes('Select model'));
  await page.keyboard.type('clear-this'); await terminal.press('Control+u'); await page.keyboard.type('ab'); await terminal.press('Backspace');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '拼音', selectionStart: 2, selectionEnd: 2 });
  await page.waitForFunction(() => document.querySelector('.composition-view.active')?.textContent === '拼音');
  assert.equal(await page.locator('.message-user').count(), oldUsers);
  await cdp.send('Input.insertText', { text: '中文' }); await cdp.detach();
  await page.waitForFunction(() => window.__manualSnapshot?.viewport.includes('❯ a中文'));
  const pasted = '，周末我想去逛书店 🧭\n顺便喝杯茶。';
  const text = 'a中文' + pasted;
  // Paste via the browser clipboard event without replacing the user's clipboard.
  await terminal.evaluate((node, text) => { const data = new DataTransfer(); data.setData('text/plain', text);
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, pasted);
  await page.waitForFunction(() => window.__manualSnapshot?.viewport.includes('顺便喝杯茶。'));
  assert.equal(await page.locator('.message-user').count(), oldUsers, 'Native draft remains unsubmitted after paste');
  await terminal.press('Enter');
  await page.waitForFunction(count => window.__manualSnapshot?.messages.filter(m => m.role === 'user').length === count && window.__manualSnapshot.messages.at(-1)?.source === 'jsonl' && window.__manualSnapshot.messages.at(-1)?.status === 'complete', oldUsers + 1);
  assert.equal((await page.evaluate(() => window.__manualSnapshot.messages.filter(m => m.role === 'user').at(-1).text)), text);
  assert.equal(await page.locator('.message-user').count(), oldUsers + 1);
  report.checks.push('exclusive-control', 'terminal-focus-and-keyboard-exit', 'arrow-menu-and-escape', 'ctrl-u-and-backspace', 'chromium-ime-composition-and-commit-once', 'unicode-multiline-paste-no-enter', 'explicit-enter-canonical-turn');
  await page.screenshot({ path: path.join(root, 'manual-terminal.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 600));
  await page.waitForTimeout(200);
  const buttonBounds = await page.locator('[data-terminal-action="release"]').boundingBox();
  assert.ok(buttonBounds.y >= 0 && buttonBounds.y + buttonBounds.height < 600, 'Release remains reachable at minimum window size');
  await page.screenshot({ path: path.join(root, 'manual-terminal-compact.png') });
  await page.getByRole('button', { name: '关闭终端原屏', exact: true }).click();
  await panel.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => !window.__manualSnapshot?.terminalControl);
  assert.equal(await page.getByRole('textbox', { name: '发送给 Claude 的消息' }).isDisabled(), false);
  const rejected = await page.evaluate(async lease => {
    try { await window.desktop.sendTerminalInput(lease.workspaceId, lease.sessionId, lease.token, { type: 'key', key: 'Enter' }); return false; }
    catch { return true; }
  }, lease);
  assert.equal(rejected, true);
  report.checks.push('close-releases-control', 'stale-token-denied', 'minimum-window-reachable');
  // A new chat starts with its first message (the offline fixture answers it).
  await page.getByRole('button', { name: /^新建对话/ }).first().click();
  await page.getByRole('textbox', { name: '发送给 Claude 的消息' }).fill('你好');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.waitForFunction(old => {
    const snapshot = window.__manualSnapshot;
    return snapshot?.sessionId !== old && snapshot?.paneId && snapshot.navigationStatus === 'idle'
      && snapshot.messages.some(message => message.role === 'assistant' && message.source === 'jsonl');
  }, lease.sessionId);
  await page.getByTitle('查看终端原屏').click(); await panel.locator('[data-terminal-action="take"]').click();
  await terminal.focus(); await page.keyboard.type('old-pane-only');
  await page.waitForFunction(() => window.__manualSnapshot?.viewport.includes('❯ old-pane-only'));
  const previous = await page.evaluate(() => ({ ...window.__manualSnapshot.terminalControl, workspaceId: window.__manualSnapshot.workspaceId, sessionId: window.__manualSnapshot.sessionId }));
  await page.locator(`.session-row[data-session-id="${lease.sessionId}"]`).click();
  await page.waitForFunction(id => window.__manualSnapshot?.sessionId === id && window.__manualSnapshot?.paneId && !window.__manualSnapshot.terminalControl, lease.sessionId);
  assert.equal(await panel.locator('.xterm-helper-textarea').count(), 0, 'Navigation must not silently acquire the destination');
  assert.equal(await page.evaluate(() => window.__manualSnapshot.viewport.includes('old-pane-only')), false);
  assert.equal(await page.evaluate(async old => { try { await window.desktop.sendTerminalInput(old.workspaceId, old.sessionId, old.token, {type:'key',key:'Enter'}); return false; } catch { return true; } }, previous), true);
  report.checks.push('switch-does-not-transfer-draft-focus-or-lease');
  report.success = true;
} catch (error) {
  report.error = error.stack || String(error);
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await app?.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
