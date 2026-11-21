import type { SessionSettingSnapshot, Workspace } from './types';

export const sessionSettingTicketLifetimeMs = 5 * 60_000;

export function settingMenuNeedsRefresh(menu?: SessionSettingSnapshot, now = Date.now()): boolean {
  if (!menu?.complete || !menu.token || menu.refreshRequired) return true;
  if (menu.source === 'catalog') return false;
  const age = now - Date.parse(menu.observedAt);
  return !Number.isFinite(age) || age < 0 || age >= sessionSettingTicketLifetimeMs;
}

export function sessionSettingsTarget(workspace: Workspace): string {
  return JSON.stringify([workspace.kind, workspace.host, workspace.port, workspace.cwd, workspace.claudeDir]);
}
