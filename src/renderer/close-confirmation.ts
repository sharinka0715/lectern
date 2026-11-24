import { backgroundParts, type BackgroundCounts } from '../shared/activity';
import { joinList, t } from '../shared/i18n';

export interface CloseConfirmation { title: string; message: string; confirmLabel: string; danger: true; detail?: string }

/**
 * "关闭对话" ends the Claude Code process of the pane: always ask first. The
 * dialog names what that stops, the reply in progress and the background work
 * the activity state still sees running, with counts.
 */
export function closeConfirmation(replying: boolean, work?: BackgroundCounts, replyComplete = !replying): CloseConfirmation {
  const running = [replying && t('app.closeConfirmReply'), ...backgroundParts(work)].filter((part): part is string => !!part);
  const detail = running.length ? t('app.closeConfirmStops', { what: joinList(running) }) : undefined;
  return {
    title: t('app.closeConfirmTitle'), message: t('app.closeConfirmMessage'), confirmLabel: t('app.closeChat'), danger: true,
    ...(detail && { detail: replyComplete && !replying ? t('app.closeConfirmAfterReply', { state: t('app.replyComplete'), detail }) : detail }),
  };
}
