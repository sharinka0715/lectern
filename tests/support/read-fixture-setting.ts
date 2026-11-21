import type { Backend } from '../../src/backend';
import type { SettingReadOptions } from '../../src/backend/native-settings';
import { sessionSettingsTarget } from '../../src/shared/session-setting-ticket';
import type { SessionSettingKind, Workspace } from '../../src/shared/types';

/** Exercises the native menu and its guards directly in an isolated mock
 * terminal. Production menu reads use getMachineSettingCatalog. */
export function readFixtureSetting(backend: Backend, workspace: Workspace, sessionId: string, kind: SessionSettingKind, options?: SettingReadOptions) {
  const context = { workspaceId: workspace.id, sessionId, targetKey: sessionSettingsTarget(workspace) };
  return backend['settings'].get(backend['settingDriver'](workspace, sessionId), context, kind, options);
}
