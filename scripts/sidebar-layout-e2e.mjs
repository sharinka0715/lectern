// Run after npm run build. An optional first argument selects a packaged Electron executable.
import { createPrivateTmux } from './fixtures/private-tmux.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from './fixtures/electron.mjs';
import { refreshFolderUntil } from './fixtures/sidebar-refresh.mjs';
import { waitUntil } from './fixtures/loopback-ssh.mjs';

// Keep the demo's Unix-domain tmux socket within macOS's path limit.
const root = await realpath(await mkdtemp(path.join(process.platform === 'win32' ? tmpdir() : '/tmp', 'lectern-sidebar-')));
const privateServer = createPrivateTmux(root);
const profile = path.join(root, 'profile');
const claudeDir = path.join(root, 'config');
const cwd = path.join(root, 'workspace');
const reply = '侧栏宽度已保存。重新打开窗口后，可以继续处理这段会话。';
const resultDirectory = path.resolve('test-results', `sidebar-layout-${Date.now()}`);
const env = { ...privateServer.env, LECTERN_LOCALE: 'zh-CN', CLAUDE_CONFIG_DIR: claudeDir, LECTERN_USER_DATA: profile, LECTERN_LOG_DIR: path.join(root, 'logs') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.LECTERN_DEV_URL;

let app, page;
const separator = () => page.getByRole('separator', { name: '调整侧栏宽度', exact: true });
const sidebar = () => page.locator('.sidebar');
const main = () => page.getByRole('main');
const width = async (locator) => (await locator.boundingBox()).width;
const sessionRow = id => page.locator(`.session-row[data-session-id="${id}"]`);
const sortControl = () => page.getByRole('button', { name: '对话排序', exact: true });
const sortLabels = { project: '按项目', recent: '最近更新', priority: '进行中优先' };

async function selectSort(mode) {
  await sortControl().click();
  await page.getByRole('menuitem', { name: sortLabels[mode], exact: true }).click();
}

async function expectGlobalOrder(mode, ...ids) {
  await page.waitForFunction(([mode, ids]) => {
    const list = document.querySelector(`.sidebar-tree[data-sidebar-sort="${mode}"] .sidebar-global`);
    const rows = list ? [...list.querySelectorAll('.session-row')] : [];
    return rows.length === ids.length && rows.every((row, index) => row.dataset.sessionId === ids[index]);
  }, [mode, ids]);
  assert.equal(await sortControl().getAttribute('aria-description'), sortLabels[mode]);
}

async function launch() {
  const executablePath = process.argv[2];
  app = await _electron.launch({ executablePath, args: executablePath ? [] : ['.'], env });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  await page.getByText(reply, { exact: true }).waitFor();
}

async function resizeWindow(target) {
  await app.evaluate(({ BrowserWindow }, requestedWidth) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setContentSize(requestedWidth, window.getContentSize()[1]);
  }, target);
  await page.waitForFunction(target => window.innerWidth === target, target);
}

async function expectSidebarWidth(target) {
  await page.waitForFunction(target => Math.abs(document.querySelector('.sidebar').getBoundingClientRect().width - target) <= 1, target);
  assert.ok(Math.abs(Number(await separator().getAttribute('aria-valuenow')) - target) <= 1, `Separator should announce its displayed width of ${target}px`);
}

async function dragBy(delta) {
  const rect = await separator().boundingBox();
  const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  try {
    await page.mouse.move(x + delta, y, { steps: 5 });
  } finally {
    await page.mouse.up();
  }
}

async function checkRows() {
  const rows = await page.locator('.workspace-row, .session-row').evaluateAll(elements => elements.map(row => {
    const label = row.querySelector('.workspace-name, .session-title');
    const range = document.createRange();
    range.selectNodeContents(label);
    const rect = row.getBoundingClientRect();
    return {
      height: rect.height,
      font: parseFloat(getComputedStyle(label).fontSize),
      lines: new Set([...range.getClientRects()].filter(rect => rect.height > 0).map(rect => Math.round(rect.top))).size,
      ellipsis: getComputedStyle(label).textOverflow === 'ellipsis' && label.scrollWidth > label.clientWidth,
    };
  }));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok(row.height <= 30 && row.height >= row.font, `Expected a compact row with legible text, got ${JSON.stringify(row)}`);
    assert.ok(row.font >= 14, 'Directory and session text should be at least 14px by default');
    assert.equal(row.lines, 1, 'The long title should occupy one line');
    assert.equal(row.ellipsis, true, 'The long title should truncate inside its available width');
  }
  return rows;
}

async function measureMultilineRows(locator) {
  return locator.evaluateAll(rows => rows.map(row => {
    const lines = element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return new Set([...range.getClientRects()].filter(rect => rect.height > 0).map(rect => Math.round(rect.top))).size;
    };
    const wrap = row.parentElement, box = row.getBoundingClientRect();
    const first = row.querySelector('.session-line'), title = first.querySelector('.session-title');
    const origin = row.querySelector('.session-origin'), counts = row.querySelector('.session-background-label');
    const firstBox = first.getBoundingClientRect(), originBox = origin?.getBoundingClientRect(), countsBox = counts?.getBoundingClientRect();
    const stateBox = row.querySelector('.session-state-label').getBoundingClientRect();
    const dotBox = row.querySelector('.session-status-dot')?.getBoundingClientRect();
    const renameBox = wrap.querySelector('.session-rename').getBoundingClientRect();
    const center = rect => rect.top + rect.height / 2 - box.top;
    const knotCenter = () => {
      const style = getComputedStyle(row, '::before');
      return parseFloat(style.top) + parseFloat(style.height) / 2;
    };
    const knot = knotCenter();
    const wasLoading = row.hasAttribute('data-loading');
    row.setAttribute('data-loading', 'true');
    const loadingKnot = knotCenter();
    if (!wasLoading) row.removeAttribute('data-loading');
    const lineBottom = parseFloat(getComputedStyle(wrap, '::before').bottom);
    const nextWrap = wrap.nextElementSibling;
    const lineGap = nextWrap?.matches('.session-row-wrap')
      ? nextWrap.getBoundingClientRect().top + parseFloat(getComputedStyle(nextWrap, '::before').top) - (wrap.getBoundingClientRect().bottom - lineBottom)
      : null;
    const rowEnd = box.right - parseFloat(getComputedStyle(row).paddingRight);
    const textBoxes = [title.getBoundingClientRect(), originBox, countsBox].filter(Boolean);
    return {
      id: row.dataset.sessionId, height: box.height, first: firstBox.height, second: originBox?.height,
      titleFont: parseFloat(getComputedStyle(title).fontSize), originFont: origin && parseFloat(getComputedStyle(origin).fontSize),
      titleLines: lines(title), originLines: origin && lines(origin),
      stacked: originBox && firstBox.top >= box.top - 0.5 && firstBox.bottom <= originBox.top + 0.5 && originBox.bottom <= box.bottom + 0.5,
      truncated: origin && getComputedStyle(origin).textOverflow === 'ellipsis' && origin.scrollWidth > origin.clientWidth,
      titleCenter: center(firstBox), knot, loadingKnot, rename: center(renameBox),
      state: stateBox.height ? center(stateBox) : null, dot: dotBox ? center(dotBox) : null,
      lineEnd: wrap.matches(':not(:has(~ .session-row-wrap))') ? box.height - lineBottom : null, lineGap,
      textRight: Math.max(...textBoxes.map(rect => rect.right)),
      stateLeft: stateBox.height ? stateBox.left : null, stateGap: stateBox.height && dotBox ? dotBox.left - stateBox.right : null,
      dotLeft: dotBox?.left ?? null, dotRight: dotBox?.right ?? null, rowEnd, renameRight: box.right - renameBox.right,
      counts: countsBox?.height, countsTop: countsBox && countsBox.top - box.top,
      countsFont: counts && parseFloat(getComputedStyle(counts).fontSize), overflow: counts && getComputedStyle(counts).textOverflow,
      fullRowTarget: countsBox && row.draggable && document.elementFromPoint(box.left + 9, box.top + center(countsBox))?.closest('.session-row') === row,
    };
  }));
}

function checkMultilineAlignment(row, size) {
  const shown = `at ${size}px: ${JSON.stringify(row)}`;
  const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 1, `${label}, ${shown}`);
  near(row.titleCenter, 15 * size / 18, 'The title is centered 15 scaled units from the top');
  for (const key of ['knot', 'loadingKnot', 'lineEnd', 'state', 'dot', 'rename']) {
    if (row[key] !== null) near(row[key], row.height / 2, `${key} is centered on the whole row`);
  }
  if (row.lineGap !== null) near(row.lineGap, 0, 'The tree line reaches the next row');
  near(row.renameRight, 3, 'The rename button keeps its end inset');
  if (row.dotRight !== null) near(row.dotRight, row.rowEnd, 'The dot stays in its column');
  if (row.stateGap !== null) near(row.stateGap, 7, 'The state keeps its gap to the dot');
  if (row.stateLeft !== null) {
    assert.ok(row.textRight <= row.stateLeft, `Every text line ends before the state label, ${shown}`);
  } else {
    near(row.textRight, row.dotLeft === null ? row.rowEnd : row.dotLeft - 7, 'Text fills the space before the dot when the state label is hidden');
  }
}

function checkTwoLineRows(rows, size) {
  assert.ok(rows.length > 0);
  for (const row of rows) {
    const shown = `at ${size}px: ${JSON.stringify(row)}`;
    assert.ok(row.stacked && row.titleLines === 1 && row.originLines === 1, `Two lines, the title above machine · folder, ${shown}`);
    assert.ok(row.originFont < row.titleFont, `The second line is in smaller text, ${shown}`);
    checkMultilineAlignment(row, size);
  }
}

async function checkBackgroundRow(row, withOrigin, size) {
  const [geometry] = await measureMultilineRows(row);
  const at = (key, units) => assert.ok(geometry[key] !== null && Math.abs(geometry[key] - units * size / 18) <= 1,
    `${key} at ${size}px should be ${units} scaled units: ${JSON.stringify(geometry)}`);
  at('height', withOrigin ? 62 : 46);
  at('first', 20);
  if (withOrigin) at('second', 16);
  else assert.equal(geometry.second, undefined);
  at('counts', 16);
  at('countsTop', withOrigin ? 41 : 25);
  assert.ok([geometry.state, geometry.dot, geometry.lineEnd].every(value => value !== null), 'The background row has a status, dot and tree line endpoint');
  checkMultilineAlignment(geometry, size);
  assert.ok(geometry.countsFont < geometry.titleFont, 'The count is in caption text');
  assert.equal(geometry.overflow, 'ellipsis');
  assert.ok(geometry.fullRowTarget, 'The draggable row covers the count line');
  const label = '子代理 2 · 后台任务 1';
  assert.equal(await row.locator('.session-state-label').innerText(), '回复完成');
  assert.equal(await row.locator('.session-background-label').innerText(), label);
  assert.ok((await row.getAttribute('title')).includes(label));
  assert.ok((await row.getAttribute('aria-label')).includes(label));
  return geometry;
}

async function setFontSize(size) {
  await page.getByRole('button', { name: '界面与连接设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.getByRole('button', { name: '外观', exact: true }).click();
  await settings.getByLabel('界面字号').focus();
  await page.keyboard.press('Home');
  for (let step = 14; step < size; step++) await page.keyboard.press('ArrowRight');
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.waitForFunction(size => parseFloat(getComputedStyle(document.documentElement).fontSize) === size, size);
}

async function checkBackgroundReplyStatus() {
  const executablePath = process.argv[2];
  app = await _electron.launch({
    executablePath, args: executablePath ? ['--demo'] : ['.', '--demo'],
    env: { ...env, TMPDIR: root, LECTERN_USER_DATA: path.join(root, 'demo-profile'), LECTERN_NODE_BINARY: process.execPath },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const active = page.locator('.session-row.active[data-session-live="true"]');
  await active.locator('.state-idle').waitFor();
  const liveId = await active.getAttribute('data-session-id');
  const liveRow = sessionRow(liveId);
  const [workspace] = await page.evaluate(() => window.desktop.listWorkspaces());
  assert.equal(workspace.id, 'demo-local');
  const historyId = randomUUID();
  const project = path.join(await app.evaluate(() => process.env.CLAUDE_CONFIG_DIR), 'projects', workspace.cwd.replace(/[^a-z0-9-]/gi, '-'));
  const history = (...messages) => messages.map(message => JSON.stringify({
    type: message.role, uuid: randomUUID(), sessionId: historyId, cwd: workspace.cwd,
    timestamp: new Date().toISOString(), message,
  })).join('\n') + '\n';
  const archivedReply = '这段历史已经结束。';
  await writeFile(path.join(project, `${historyId}.jsonl`), history(
    { role: 'user', content: '打开另一段历史' },
    { role: 'assistant', content: [{ type: 'text', text: archivedReply }], stop_reason: 'end_turn' },
  ));
  const otherRow = sessionRow(historyId);
  await refreshFolderUntil(page, workspace.id, otherRow);
  const idleDiscovery = await page.evaluate(id => window.desktop.discover(id), workspace.id);
  assert.equal(idleDiscovery.sessions.find(chat => chat.id === liveId)?.status, 'idle');
  // Reproduce a slow directory scan while the real reader continues polling tmux.
  await app.evaluate(({ ipcMain }, discovery) => {
    globalThis.sidebarLayoutDiscoveryCount = 0;
    ipcMain.removeHandler('lectern:discover');
    ipcMain.handle('lectern:discover', () => {
      globalThis.sidebarLayoutDiscoveryCount++;
      return discovery;
    });
  }, idleDiscovery);
  await selectSort('recent');
  await expectGlobalOrder('recent', historyId, liveId);
  const stateFile = path.join(await app.evaluate(() => process.env.CLAUDE_CONFIG_DIR), 'screen-state');
  await writeFile(stateFile, 'progress');
  const replying = liveRow.locator('.session-state-label', { hasText: '回复中' });
  await replying.waitFor();
  await expectGlobalOrder('recent', historyId, liveId);
  await selectSort('priority');
  await expectGlobalOrder('priority', liveId, historyId);
  await otherRow.click();
  await page.getByText(archivedReply, { exact: true }).waitFor();
  assert.equal(await replying.isVisible(), true, 'Switching does not drop a live reply label');
  const scans = await app.evaluate(() => globalThis.sidebarLayoutDiscoveryCount);
  await waitUntil(() => app.evaluate(() => globalThis.sidebarLayoutDiscoveryCount).then(count => count > scans),
    'The sidebar did not request another directory scan after switching');
  await expectGlobalOrder('priority', liveId, historyId);
  assert.equal(await replying.isVisible(), true, 'An idle directory scan does not replace a known live reply');
  await page.reload();
  await page.getByText(archivedReply, { exact: true }).waitFor();
  await expectGlobalOrder('priority', liveId, historyId);
  await writeFile(stateFile, 'ready');
  await liveRow.locator('.session-status-dot.state-idle').waitFor();
  await expectGlobalOrder('priority', historyId, liveId);
  const [idleRow] = await measureMultilineRows(liveRow);
  assert.equal(idleRow.state, null, 'An idle row only shows the dot');
  checkMultilineAlignment(idleRow, 18);
  assert.equal(await otherRow.getAttribute('aria-current'), 'page', 'The original reply settles without switching back');
}

async function checkGlobalSorting(sessionId, olderId, remoteUpdatedAt) {
  const local = await page.evaluate(() => window.desktop.discover('layout'));
  // The global view spans machines. Exercise the normal local project alongside
  // an offline SSH fixture without connecting to a remote host.
  const remoteWorkspace = {
    id: 'layout-remote', kind: 'ssh', name: '跨机器归档项目', host: 'sidebar-fixture.invalid', cwd: '/srv/fixture',
  };
  const remoteChat = { id: randomUUID(), title: '远程发布记录', updatedAt: remoteUpdatedAt,
    paneId: '%93', mapping: 'exact', status: 'working', path: '/srv/fixture/chat.jsonl' };
  const backgroundChat = { id: randomUUID(), title: '检查后台任务',
    updatedAt: new Date(Date.parse(remoteUpdatedAt) - 48 * 60 * 60 * 1000).toISOString(),
    paneId: '%94', mapping: 'exact', status: 'idle', path: '/srv/fixture/background.jsonl', background: '子代理 2 · 后台任务 1' };
  const remote = { workspace: remoteWorkspace, sessions: [remoteChat, backgroundChat], panes: [] };
  const backgroundRow = sessionRow(backgroundChat.id);
  const remoteReply = '远程工作目录里的回复。';
  await app.evaluate(({ ipcMain }, { local, remote, remoteReply, reply }) => {
    const replace = (name, handler) => {
      ipcMain.removeHandler(`lectern:${name}`);
      ipcMain.handle(`lectern:${name}`, handler);
    };
    replace('listWorkspaces', () => [local.workspace, remote.workspace]);
    replace('checkSshConnection', () => ({ ok: true }));
    replace('checkHost', () => ({ ok: true, tools: {
      system: 'Linux', distro: ['ubuntu'], managers: ['apt-get'], root: false,
      tmux: { path: '/usr/bin/tmux', version: 'tmux 3.4' },
      claude: { path: '/usr/bin/claude', version: '2.1.329 (Claude Code)' },
    } }));
    replace('discover', (_event, workspaceId) => workspaceId === remote.workspace.id ? remote : local);
    replace('watchSession', (_event, workspaceId, sessionId) => {
      const isRemote = workspaceId === remote.workspace.id;
      const discovery = isRemote ? remote : local;
      const chat = discovery.sessions.find(item => item.id === sessionId);
      if (!chat) throw new Error('Session was opened through the wrong project');
      return { workspaceId, sessionId, status: isRemote ? 'working' : 'idle', paneId: chat.paneId, screen: '',
        messages: [{ id: `${sessionId}-reply`, role: 'assistant', source: 'jsonl', status: 'complete',
          text: isRemote ? remoteReply : reply, tools: [] }] };
    });
  }, { local, remote, remoteReply, reply });
  await page.reload();
  await sessionRow(sessionId).waitFor();
  assert.equal(await sortControl().getAttribute('aria-description'), sortLabels.project);
  assert.equal(await page.locator('.sidebar-global').count(), 0, 'A new profile opens the project tree');

  await selectSort('recent');
  await expectGlobalOrder('recent', sessionId, remoteChat.id, olderId, backgroundChat.id);
  // Two lines: the title, then the machine (named as its sidebar heading) and the folder. The
  // long local folder name is cut short there; the hover tip and spoken label have it in full.
  const localOrigin = `本地 · ${local.workspace.name}`, remoteOrigin = `${remoteWorkspace.host} · ${remoteWorkspace.name}`;
  assert.equal(await sessionRow(remoteChat.id).locator('.session-origin').innerText(), remoteOrigin);
  assert.equal(await sessionRow(sessionId).locator('.session-origin').innerText(), localOrigin);
  assert.ok((await sessionRow(remoteChat.id).getAttribute('title')).includes(`\n${remoteOrigin}\n`));
  assert.ok((await sessionRow(sessionId).getAttribute('title')).includes(`\n${localOrigin}\n`));
  assert.ok((await sessionRow(sessionId).getAttribute('aria-label')).includes(localOrigin));
  assert.equal(await sessionRow(remoteChat.id).locator('.session-state-label').innerText(), '回复中');
  const ordinaryRows = page.locator('.sidebar-global .session-row:not([data-background])');
  const twoLines = await measureMultilineRows(ordinaryRows);
  const recentBackground = { at18: await checkBackgroundRow(backgroundRow, true, 18) };
  checkTwoLineRows(twoLines, 18);
  assert.ok(twoLines.every(row => Math.abs(row.height - 46) <= 1), `Two-line rows are 46px at 18px: ${JSON.stringify(twoLines)}`);
  assert.equal(twoLines.find(row => row.id === sessionId).truncated, true, 'A long machine · folder line ends in an ellipsis');
  // The text lines and both alignment centers follow the interface font size.
  await setFontSize(14);
  const smaller = await measureMultilineRows(ordinaryRows);
  recentBackground.at14 = await checkBackgroundRow(backgroundRow, true, 14);
  checkTwoLineRows(smaller, 14);
  for (const [index, row] of smaller.entries()) for (const key of ['height', 'first', 'second']) {
    const expected = twoLines[index][key] * 14 / 18;
    assert.ok(Math.abs(row[key] - expected) <= 1, `${key} at 14px: ${row[key]}px, expected ${expected.toFixed(2)}px (${twoLines[index][key]}px at 18px)`);
  }
  await setFontSize(18);
  assert.equal(await sessionRow(sessionId).getAttribute('aria-current'), 'page');

  await sortControl().press('Enter');
  const priorityItem = page.getByRole('menuitem', { name: sortLabels.priority, exact: true });
  await priorityItem.waitFor();
  await page.keyboard.press('End');
  assert.equal(await priorityItem.evaluate(item => item === document.activeElement), true);
  await page.keyboard.press('Enter');
  await expectGlobalOrder('priority', remoteChat.id, backgroundChat.id, sessionId, olderId);
  const priorityBackground = await checkBackgroundRow(backgroundRow, true, 18);
  const global = page.locator('.sidebar-global');
  await global.getByRole('heading', { name: '进行中', exact: true }).waitFor();
  await global.getByRole('heading', { name: '其他会话', exact: true }).waitFor();
  assert.deepEqual(await global.locator('.sort-group-heading, .session-row').evaluateAll(items => items.map(item => (
    item.classList.contains('session-row') ? item.dataset.sessionId : item.textContent
  ))), ['进行中', remoteChat.id, backgroundChat.id, '其他会话', sessionId, olderId]);
  assert.equal(await sessionRow(sessionId).getAttribute('aria-current'), 'page', 'Sorting keeps the current chat selected');
  await page.reload();
  await expectGlobalOrder('priority', remoteChat.id, backgroundChat.id, sessionId, olderId);
  assert.equal(await sessionRow(sessionId).getAttribute('aria-current'), 'page');

  const filter = page.getByRole('textbox', { name: '筛选项目和对话', exact: true });
  await filter.fill(remoteWorkspace.name);
  await expectGlobalOrder('priority', remoteChat.id, backgroundChat.id);
  await filter.clear();
  await sessionRow(remoteChat.id).click();
  await page.getByText(remoteReply, { exact: true }).waitFor();
  await page.screenshot({ path: path.join(resultDirectory, 'global-priority.png') });
  await selectSort('project');
  // Opening it from the list across projects leaves the tree as it was: its folder stays
  // folded, marked as holding the open conversation, until the user opens it.
  const remoteFolder = page.locator(`.workspace-row[data-workspace-id="${remoteWorkspace.id}"]`);
  await remoteFolder.waitFor();
  assert.match(await remoteFolder.getAttribute('class'), /\bactive\b/);
  assert.equal(await sessionRow(remoteChat.id).count(), 0);
  await remoteFolder.locator('.workspace-toggle').click();
  assert.equal(await sessionRow(remoteChat.id).getAttribute('aria-current'), 'page');
  // The project tree keeps one line for conversations without background work.
  const treeRows = await page.locator('.sidebar-tree .session-row:not([data-background])').evaluateAll(rows => rows.map(row => ({
    height: row.getBoundingClientRect().height, twoLines: !!row.querySelector('.session-line, .session-origin') })));
  assert.ok(treeRows.length >= 2 && treeRows.every(row => row.height <= 30 && !row.twoLines), `The project tree keeps one-line rows: ${JSON.stringify(treeRows)}`);
  const projectBackground = { at18: await checkBackgroundRow(backgroundRow, false, 18) };
  await setFontSize(14);
  projectBackground.at14 = await checkBackgroundRow(backgroundRow, false, 14);
  await setFontSize(18);
  await checkSupersededDiscovery(local, remote, remoteChat);
  const [at18, at14] = [twoLines, smaller].map(rows => rows.find(row => row.id === remoteChat.id));
  assert.ok([at18, at14].every(row => row.state !== null && row.dot !== null), 'Both font sizes measure the visible state and dot');
  return { at18, at14, background: { recent: recentBackground, priority: priorityBackground, project: projectBackground } };
}

async function checkSupersededDiscovery(local, remote, chat) {
  const newTitle = '远程发布记录已刷新';
  const updated = { ...remote, sessions: [{ ...chat, title: newTitle }] };
  const refresh = async () => {
    await page.locator(`.workspace-row[data-workspace-id="${remote.workspace.id}"]`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '刷新会话列表', exact: true }).click();
  };
  const waitForScan = (count, message, timeout) => waitUntil(
    () => app.evaluate(() => globalThis.sidebarLayoutScans.started).then(started => started >= count), message, timeout,
  );

  await app.evaluate(({ ipcMain }, { local, updated }) => {
    const gates = Array.from({ length: 3 }, () => {
      let finish, fail;
      const result = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      return { result, finish, fail };
    });
    const scans = globalThis.sidebarLayoutScans = { started: 0, gates, updated };
    ipcMain.removeHandler('lectern:discover');
    ipcMain.handle('lectern:discover', (_event, id) => id === updated.workspace.id
      ? scans.gates[scans.started++]?.result ?? updated
      : local);
  }, { local, updated });
  const row = sessionRow(chat.id);
  try {
    await refresh();
    await waitForScan(1, 'The sidebar did not start the requested scan');
    // Electron resolves an obsolete backend scan without a discovery payload.
    await app.evaluate(() => { globalThis.sidebarLayoutScans.gates[0].finish(); });
    await waitForScan(2, 'An obsolete scan did not trigger an immediate retry', 3000);
    assert.equal(await row.locator('.session-title').innerText(), chat.title, 'The existing row stays visible during the retry');
    assert.equal(await page.locator('.error-banner, .tree-note-error').count(), 0, 'An obsolete scan does not show an error');
    await app.evaluate(() => {
      const { gates, updated } = globalThis.sidebarLayoutScans;
      gates[1].finish(updated);
    });
    await row.getByText(newTitle, { exact: true }).waitFor();
    await page.screenshot({ path: path.join(resultDirectory, 'recovered-discovery.png') });

    await refresh();
    await waitForScan(3, 'The sidebar did not start the next scan');
    await app.evaluate(() => { globalThis.sidebarLayoutScans.gates[2].fail(new Error('Synthetic discovery failure')); });
    await page.locator('.error-banner').getByText('Synthetic discovery failure', { exact: false }).waitFor();
    assert.equal(await row.getByText(newTitle, { exact: true }).isVisible(), true, 'A real failure preserves the last successful scan');
  } finally {
    await app.evaluate(() => {
      const { gates, updated } = globalThis.sidebarLayoutScans;
      for (const gate of gates) gate.finish(updated);
    });
  }
}

try {
  // Normal app startup with one historical transcript. No Claude process or SSH connection is needed.
  const project = path.join(claudeDir, 'projects', cwd.replace(/[^a-z0-9-]/gi, '-'));
  await Promise.all([profile, cwd, project, resultDirectory].map(dir => mkdir(dir, { recursive: true })));
  const workspaceName = '桌面客户端 · 多项目协作与本地历史会话管理体验改进';
  const question = '检查桌面客户端重新打开后是否保留侧栏宽度，并确认较长的历史会话标题仍然保持单行。';
  const sessionId = randomUUID(), timestamp = new Date().toISOString();
  const records = [
    { type: 'user', uuid: randomUUID(), sessionId, cwd, timestamp, message: { role: 'user', content: question } },
    { type: 'assistant', uuid: randomUUID(), sessionId, cwd, timestamp, message: { role: 'assistant', content: [{ type: 'text', text: reply }], stop_reason: 'end_turn' } },
  ];
  await Promise.all([
    writeFile(path.join(profile, 'workspaces.json'), JSON.stringify([{ id: 'layout', name: workspaceName, kind: 'local', cwd }])),
    writeFile(path.join(project, `${sessionId}.jsonl`), records.map(record => JSON.stringify(record)).join('\n') + '\n'),
  ]);

  await launch();
  await resizeWindow(1280);
  await expectSidebarWidth(304);
  assert.equal(await separator().getAttribute('aria-orientation'), 'vertical');
  const rows = await checkRows();
  const fonts = await page.evaluate(() => Object.fromEntries(['.markdown p', '.user-text', '.composer textarea'].map(selector =>
    [selector, parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)])));
  assert.ok(Object.values(fonts).every(size => size >= 16), `Chat and composer text should be at least 16px by default: ${JSON.stringify(fonts)}`);
  await page.screenshot({ path: path.join(resultDirectory, 'default.png') });

  await dragBy(104);
  const preferred = 408;
  await expectSidebarWidth(preferred);
  await separator().press('ArrowRight');
  await expectSidebarWidth(preferred + 16);
  await separator().press('ArrowLeft');
  await expectSidebarWidth(preferred);
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await sidebar().waitFor({ state: 'hidden' });
  assert.equal(await separator().isVisible(), false);
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  await expectSidebarWidth(preferred);
  await app.close();
  app = undefined;
  await launch();
  await resizeWindow(1280);
  await expectSidebarWidth(preferred);

  await separator().press('Home');
  await expectSidebarWidth(208);
  await dragBy(-150);
  await expectSidebarWidth(208);
  await separator().press('End');
  await expectSidebarWidth(480);
  await dragBy(250);
  await expectSidebarWidth(480);

  const openDrawer = () => page.getByRole('button', { name: '浏览工作目录', exact: true }).click();
  const closeDrawer = () => page.getByRole('button', { name: '关闭文件预览', exact: true }).click();
  const drawer = page.locator('.artifact-drawer');
  // The preview belongs to the chat pane: it docks while the pane leaves the
  // chat 500px and shows over the chat otherwise, never resizing the sidebar.
  const drawerPosition = () => drawer.evaluate(el => getComputedStyle(el).position);
  await separator().press('Home');
  await expectSidebarWidth(208);
  await openDrawer();
  await drawer.getByText('此文件夹为空。', { exact: true }).waitFor();
  await expectSidebarWidth(208);
  assert.equal(await drawerPosition(), 'relative', 'A wide pane docks the preview');
  const dockedChat = await width(main());
  assert.ok(dockedChat >= 499, 'Docked preview must leave room for the conversation');
  assert.ok((await main().boundingBox()).x + dockedChat <= (await drawer.boundingBox()).x + 1, 'The docked preview sits beside the chat');
  await separator().press('End');
  await expectSidebarWidth(480);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.artifact-drawer')).position === 'absolute');
  assert.ok(await width(main()) >= 499, 'An overlaid preview leaves the conversation its width');
  const header = await page.locator('.topbar').evaluate(bar => {
    const title = bar.querySelector('.topbar-title'), actions = bar.querySelector('.topbar-actions');
    return { right: title.getBoundingClientRect().right, startOfActions: actions.getBoundingClientRect().left, overflow: getComputedStyle(title).overflowX };
  });
  assert.ok(header.right <= header.startOfActions + 1 && header.overflow !== 'visible', 'A long workspace title must truncate before the toolbar buttons');
  await page.screenshot({ path: path.join(resultDirectory, 'docked-preview.png') });
  await closeDrawer();
  await expectSidebarWidth(480);

  await resizeWindow(850);
  await expectSidebarWidth(350);
  await checkRows();
  await openDrawer();
  await drawer.getByText('此文件夹为空。', { exact: true }).waitFor();
  await expectSidebarWidth(350);
  await page.screenshot({ path: path.join(resultDirectory, 'narrow-preview.png') });
  await closeDrawer();
  await resizeWindow(1280);
  await expectSidebarWidth(480);
  await resizeWindow(850);
  await dragBy(400);
  await expectSidebarWidth(350);
  assert.ok(await width(main()) >= 499, 'Dragging at minimum window width must keep the conversation usable');
  await resizeWindow(1280);
  await separator().dblclick();
  await expectSidebarWidth(304);

  // A new reply in another chat still raises its unread indicator in the project tree.
  const olderId = randomUUID();
  const olderLog = path.join(project, `${olderId}.jsonl`);
  const olderDate = (hours) => new Date(Date.parse(timestamp) - hours * 60 * 60 * 1000).toISOString();
  const olderRecords = (hours, user, assistant) => records.map((record, i) => JSON.stringify({
    ...record, uuid: randomUUID(), sessionId: olderId, timestamp: olderDate(hours - i),
    message: { ...record.message, content: i === 0 ? user : [{ type: 'text', text: assistant }] },
  })).join('\n') + '\n';
  await writeFile(olderLog, olderRecords(48, '较早的会话', '已经读过的回复'));
  const olderRow = sessionRow(olderId);
  await refreshFolderUntil(page, 'layout', olderRow);
  assert.equal(await olderRow.locator('.state-unread').count(), 0);
  await appendFile(olderLog, olderRecords(24, '较早会话的新问题', '一条未读的回复'));
  await olderRow.locator('.state-unread').waitFor();

  const twoLineRows = await checkGlobalSorting(sessionId, olderId, olderDate(12));
  await app.close();
  app = undefined;
  await checkBackgroundReplyStatus();
  console.log(JSON.stringify({ success: true, defaultWidth: 304, persistedWidth: preferred, dockedChat, narrowMax: 350, rows, fonts, sidebarSort: 'global recent and active priority across local and SSH, search, keyboard, selection, reload', twoLineRows, backgroundReplyStatus: true, supersededDiscoveryRetried: true, resultDirectory }));
} catch (error) {
  await page?.screenshot({ path: path.join(resultDirectory, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await app?.close();
  privateServer.killAll();
  await rm(root, { recursive: true, force: true });
}
