import type { NavigationSessionStatus, SessionStatus } from "../shared/types";
import { t } from '../shared/i18n';

export function isMessageInputReady(input: {
  status: SessionStatus;
  navigationStatus?: NavigationSessionStatus;
  nativeInputReady?: boolean;
}) {
  if (input.status === "error")
    return input.navigationStatus === "error" && input.nativeInputReady === true;
  return input.status === "idle" &&
    (!input.navigationStatus || input.navigationStatus === "idle");
}

/** The composer placeholder. A disabled composer always says why. */
export function composerPlaceholder(input: {
  workspace: boolean; sessionId: boolean; snapshot: boolean; paneId: boolean;
  canSend: boolean; inTurn: boolean; compacting?: boolean; terminalLocked: boolean; draftOccupied: boolean;
  settingBusy: boolean; trustBusy: boolean; questionBusy: boolean; rewind: boolean; busy: boolean; permission?: boolean;
  status: SessionStatus; navigationStatus?: NavigationSessionStatus;
  /** A new chat with nothing started yet; the folder still being read; its launch. */
  draft?: boolean; folderResolving?: boolean; launching?: boolean; pendingFirst?: boolean;
  /** Why nothing can start on this machine (it lacks tmux or Claude Code). */
  hostBlocked?: string;
}): string {
  if (!input.workspace) return t('composer.addFolderToStart');
  if (input.hostBlocked) return input.hostBlocked;
  if (input.launching) return t('composer.launching');
  if (input.pendingFirst) return input.status === "waiting" || input.navigationStatus === "waiting"
    ? t('composer.sendAfterPrompt') : t('composer.sendWhenReady');
  if (input.folderResolving) return t('composer.readingFolder');
  if (input.draft) return t('composer.firstMessage');
  if (!input.sessionId) return t('composer.chooseChat');
  if (!input.snapshot) return t('composer.loadingChat');
  if (!input.paneId) return t('composer.resumeToContinue');
  if (input.terminalLocked) return t('composer.terminalTakenOver');
  if (input.draftOccupied) return t('composer.draftInTerminal');
  if (input.canSend) return input.compacting ? t('composer.compactingQueue')
    : input.inTurn ? t('composer.steerOrQueue') : t('composer.chatPrompt');
  if (input.settingBusy) return t('composer.switchingSetting');
  if (input.trustBusy) return t('composer.handlingTrust');
  if (input.questionBusy) return t('composer.submittingAnswer');
  if (input.permission) return t('composer.waitingPermission');
  if (input.rewind) return t('composer.rewindOpen');
  if (input.busy) return t('composer.previousAction');
  if (input.status === "connecting") return t('composer.syncing');
  if (input.status === "waiting" || input.navigationStatus === "waiting") return t('composer.waitingTerminal');
  if (input.status === "error") return t('composer.sessionError');
  if (input.status === "offline") return t('composer.notRunning');
  if (input.status === "working" || input.navigationStatus === "working") return t('composer.workingNoInput');
  return t('composer.noInput');
}
