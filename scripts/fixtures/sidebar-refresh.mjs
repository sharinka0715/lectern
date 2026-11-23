// For e2e scripts that write a conversation into a folder the app already shows: the sidebar
// reads a shown folder every 5 seconds, so waiting for its next read costs up to that long.
// The folder's context menu reads it now (刷新会话列表, the same refresh the timer starts);
// a read already under way when the file was written is reused, so this asks again until
// `until` holds. Tests whose subject is that background read keep waiting for it instead.

/** Right-clicks the folder's row and picks 刷新会话列表 (Refresh conversations). */
export async function refreshFolder(page, workspaceId) {
  await page.locator(`.workspace-row[data-workspace-id="${workspaceId}"]`).click({ button: 'right' });
  await page.locator('.context-menu:popover-open').getByRole('menuitem', { name: /^(刷新会话列表|Refresh conversations)$/ }).click();
}

/** Refreshes the folder until `until` (a locator) is visible, or `state` if given; same timeout as a plain waitFor. */
export async function refreshFolderUntil(page, workspaceId, until, { state = 'visible', timeout = 20_000 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    await refreshFolder(page, workspaceId);
    try {
      return await until.waitFor({ state, timeout: Math.max(1, Math.min(2000, end - Date.now())) });
    } catch (error) {
      if (Date.now() >= end) throw error;
    }
  }
}
