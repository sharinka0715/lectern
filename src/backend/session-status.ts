import { classifySessionScreen } from '../core/screen';
import { isIdleEmptyComposer } from '../core/settings-screen';
import type { NativePresence } from './native-presence';
import type { NavigationSessionStatus } from '../shared/types';
import { t } from '../shared/i18n';

export interface PaneStatusEvidence {
  id: string;
  active: boolean;
  dead: boolean;
  deadStatus?: number;
  deadSignal?: string;
  native?: NativePresence;
  identityError?: string;
}
export interface ViewportObservation { screen?: string; styled?: string; error?: string }
export interface NavigationStatus { status: NavigationSessionStatus; statusDetail?: string; background?: string }

/** Navigation cannot infer active work from mere process existence or old JSONL. */
export function paneNavigationStatus(pane: PaneStatusEvidence | undefined, observation?: ViewportObservation): NavigationStatus {
  if (!pane) return { status: 'history' };
  if (pane.dead) {
    if (pane.deadSignal && pane.deadSignal !== '0') return { status: 'error', statusDetail: t('backend.signalExit', { signal: pane.deadSignal }) };
    if (pane.deadStatus !== undefined && pane.deadStatus !== 0) return { status: 'error', statusDetail: t('backend.abnormalExit', { code: pane.deadStatus }) };
    return { status: 'history', statusDetail: t('backend.processEnded') };
  }
  if (pane.identityError) return { status: 'unknown', statusDetail: pane.identityError };
  const screen = observation?.screen;
  let classified = screen === undefined ? undefined : classifySessionScreen(screen);
  if (screen && classified?.status === 'unknown' && observation?.styled && isIdleEmptyComposer(screen, observation.styled))
    classified = { status: 'idle', detail: t('core.waitingMessage') };
  if (classified?.status === 'error') return { status: 'error', statusDetail: classified.detail };
  if (!pane.active) return { status: 'unknown', statusDetail: t('backend.paneWithoutClaude') };
  switch (pane.native?.status) {
    case 'waiting': return { status: 'waiting', statusDetail: pane.native.waitingFor ? t('backend.waitingFor', { what: pane.native.waitingFor }) : t('backend.waitingInput') };
    case 'busy':
      // Claude Code also reports busy after its reply while background subagents
      // or workflows run; its screen then shows the empty prompt again.
      if (classified?.status === 'idle') return { status: 'idle', statusDetail: t('backend.repliedCanType'), background: t('backend.backgroundAgents') };
      return { status: 'working', statusDetail: t('backend.processingRequest') };
    case 'shell':
    case 'idle':
      // A concrete dialog/error can appear before delayed native state catches up.
      if (classified?.status === 'waiting' || classified?.status === 'working') return { status: classified.status, statusDetail: classified.detail };
      // "shell": idle, with background shells still running.
      return pane.native.status === 'shell' ? { status: 'idle', statusDetail: t('backend.repliedCanType'), background: t('backend.backgroundShell') }
        : { status: 'idle', statusDetail: t('backend.claudeIdle') };
  }
  if (observation?.error) return { status: 'unknown', statusDetail: observation.error };
  if (!classified) return { status: 'unknown', statusDetail: t('backend.statusUnread') };
  return { status: classified.status, statusDetail: classified.detail };
}
