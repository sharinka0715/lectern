// The sidebar steps the opt-in native scripts (real SSH hosts, real model requests: nothing runs
// them on CI) share, done the way a user does them:
// - a folder folds with its arrow (.workspace-toggle, aria-expanded); clicking its name
//   (.workspace-select) opens a new-chat draft instead;
// - a folder added through 添加项目文件夹 lists only running Lectern panes until 扫描所有对话
//   (Workspace.historyScan === false); folders saved with desktop.saveWorkspace scan at once;
// - 新建对话 opens a draft, and its Claude Code starts with the first message: a real request
//   to the default model. startConversation starts the pane without a message instead.
import { refreshFolder } from './sidebar-refresh.mjs';

/** The folder's conversation list, shown while it is expanded. */
export const folderGroup = (page, workspaceId) => page.locator(`[id="workspace-children-${workspaceId}"]`);
export const sessionRow = (page, workspaceId, sessionId) =>
  page.locator(`.session-row[data-workspace-id="${workspaceId}"][data-session-id="${sessionId}"]`);
const workspaces = page => page.evaluate(() => window.desktop.listWorkspaces());

/** Adds a folder on the sidebar machine named `machine` through 添加项目文件夹 and returns the saved workspace. */
export async function addFolder(page, machine, { cwd, name, host }) {
  await page.getByRole('button', { name: `在 ${machine} 添加项目文件夹`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加项目文件夹', exact: true });
  if (name !== undefined) await dialog.getByLabel('名称', { exact: true }).fill(name);
  await dialog.getByLabel('工作目录', { exact: true }).fill(cwd);
  await dialog.getByRole('button', { name: '添加目录', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const workspace = (await workspaces(page)).find(item => item.cwd === cwd && (host === undefined || item.host === host));
  if (!workspace) throw new Error(`The folder ${cwd} was not saved`);
  return workspace;
}

/** Expands the folder (nothing to do when it already is). */
export async function expandFolder(page, workspaceId) {
  const toggle = page.locator(`.workspace-row[data-workspace-id="${workspaceId}"] .workspace-toggle`);
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await folderGroup(page, workspaceId).waitFor();
}

/** Expands the folder and, if it has not scanned its saved conversations yet, clicks 扫描所有对话 and waits until it has. */
export async function scanFolder(page, workspaceId, { timeout = 45_000 } = {}) {
  const scanned = async () => {
    const workspace = (await workspaces(page)).find(item => item.id === workspaceId);
    if (!workspace) throw new Error(`No folder ${workspaceId}`);
    return workspace.historyScan !== false;
  };
  await expandFolder(page, workspaceId);
  if (await scanned()) return;
  const note = folderGroup(page, workspaceId).locator('.tree-note-scan');
  await note.getByRole('button', { name: '扫描所有对话', exact: true }).click({ timeout });
  for (const end = Date.now() + timeout; !(await scanned()); await page.waitForTimeout(200))
    if (Date.now() > end) throw new Error(`The folder ${workspaceId} did not start scanning its conversations`);
  await note.waitFor({ state: 'detached', timeout });
}

/** Expands the folder and clicks the conversation's row. The folder lists its five newest
 * conversations: 展开更多 shows ten more until the row is there. `refresh` also reads the folder
 * again every 2 seconds (a conversation the sidebar has not read yet); otherwise its next read is awaited. */
export async function openConversation(page, workspaceId, sessionId, { refresh = false, timeout = 45_000 } = {}) {
  await expandFolder(page, workspaceId);
  const row = sessionRow(page, workspaceId, sessionId);
  const more = folderGroup(page, workspaceId).locator('button.tree-more:not(.tree-collapse)');
  const end = Date.now() + timeout;
  for (let refreshed = 0; !(await row.count()); await page.waitForTimeout(200)) {
    if (Date.now() > end) throw new Error(`No sidebar row for conversation ${sessionId} in folder ${workspaceId}`);
    if (await more.count()) await more.click();
    else if (refresh && Date.now() - refreshed > 2000) { await refreshFolder(page, workspaceId); refreshed = Date.now(); }
  }
  await row.click();
}

/** Starts a new conversation's Claude Code pane in the folder without sending anything (no model
 * request), then opens it from the sidebar. Returns the new SessionInfo (its id is the session UUID). */
export async function startConversation(page, workspaceId) {
  const session = await page.evaluate(id => window.desktop.createSession(id), workspaceId);
  await openConversation(page, workspaceId, session.id, { refresh: true });
  return session;
}
