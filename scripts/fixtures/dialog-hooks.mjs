// Settings → Session's recording hooks (src/backend/dialog-hooks.ts), turned on and off from the
// settings page as a user does (Chinese UI). The e2e scripts that drive the installed Claude Code
// run with them on when LECTERN_E2E_DIALOG_HOOKS=1 (question-early-hooks-e2e, permission-hooks-e2e).
import assert from 'node:assert/strict';

export const DIALOG_HOOKS = process.env.LECTERN_E2E_DIALOG_HOOKS === '1';
export const HOOKS_LABEL = '用 Claude Code hooks 识别问答和权限框';

/** Opens Settings → Session; returns the dialog. */
async function openSession(page) {
  await page.getByRole('button', { name: '界面与连接设置' }).click();
  const settings = page.getByRole('dialog', { name: '设置' });
  await settings.waitFor();
  await settings.locator('nav').getByRole('button', { name: '会话', exact: true }).click();
  return settings;
}

/** Turns the setting on or off; it is saved on this computer and reaches the main process. */
export async function setDialogHooks(page, on) {
  const settings = await openSession(page);
  const box = settings.getByRole('checkbox', { name: HOOKS_LABEL });
  await box.setChecked(on);
  await page.waitForFunction(want => JSON.parse(localStorage.getItem('lectern.desktop.preferences.v1') ?? '{}').dialogHooks === want, on);
  await page.keyboard.press('Escape');
  await settings.waitFor({ state: 'detached' });
}

/** The open chat's hook state as Settings → Session shows it (data-hook-state), waiting up to `timeout` for `want`;
 * `screenshot`: a path for a picture of the page. */
export async function hookStatus(page, want, timeout = 20_000, screenshot) {
  const settings = await openSession(page);
  const status = settings.locator('.pref-hook-status');
  try {
    if (want) await page.waitForFunction(state => document.querySelector('.pref-hook-status')?.getAttribute('data-hook-state') === state, want, { timeout });
    if (screenshot) { await status.scrollIntoViewIfNeeded(); await settings.screenshot({ path: screenshot }); }
    return { state: await status.getAttribute('data-hook-state'), text: await status.innerText() };
  } finally {
    await page.keyboard.press('Escape');
    await settings.waitFor({ state: 'detached' });
  }
}

/** The hooks a Claude process got in its --settings (undefined: none). */
export function launchedHooks(argv) {
  const at = argv.indexOf('--settings');
  assert.ok(at >= 0, 'the process has per-launch settings');
  return JSON.parse(argv[at + 1]).hooks;
}
