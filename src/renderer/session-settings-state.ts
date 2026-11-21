import type {
  NavigationSessionStatus,
  SessionSettingKind,
  SessionSettingSnapshot,
  SessionStatus,
} from "../shared/types";
import { t } from '../shared/i18n';

export function confirmedSettingOption(menu?: SessionSettingSnapshot) {
  if (!menu?.currentOptionId) return undefined;
  const current = menu.options.filter((option) => option.current);
  return current.length === 1 && current[0].id === menu.currentOptionId
    ? current[0]
    : undefined;
}

export function validateSettingMenu(
  menu: SessionSettingSnapshot,
  kind: SessionSettingKind,
  sessionId: string,
  paneId: string,
) {
  if (
    menu.kind !== kind ||
    menu.sessionId !== sessionId ||
    menu.paneId !== paneId
  )
    throw new Error(t('settings.menuChanged'));
  if (
    new Set(menu.options.map((option) => option.id)).size !==
    menu.options.length
  )
    throw new Error(t('settings.duplicateOptions'));
  if (
    menu.options.some((option) => !option.id || !option.label) ||
    (menu.complete && !menu.token)
  )
    throw new Error(t('settings.menuInfoIncomplete'));
  return menu;
}

export function settingAvailability(input: {
  paneId?: string;
  status: SessionStatus;
  navigationStatus?: NavigationSessionStatus;
  busy?: boolean;
  nativeInputReady?: boolean;
}) {
  if (!input.paneId)
    return { allowed: false, reason: t('settings.resumeToSwitch') };
  if (input.busy) return { allowed: false, reason: t('settings.menuBusy') };
  if (input.status === "working")
    return { allowed: false, reason: t('settings.afterReply') };
  if (input.status === "waiting" || input.navigationStatus === "waiting")
    return { allowed: false, reason: t('settings.confirmInTerminal') };
  if (input.nativeInputReady === false)
    return { allowed: false, reason: t('settings.handleDraftFirst') };
  // A live native API error may be recoverable by changing the model. The
  // backend still verifies an empty, ready composer before sending commands.
  if (input.status === "error" && input.navigationStatus === "error")
    return { allowed: true, reason: "" };
  if (
    input.status !== "idle" ||
    (input.navigationStatus && input.navigationStatus !== "idle")
  )
    return { allowed: false, reason: t('settings.notReady') };
  return { allowed: true, reason: "" };
}
