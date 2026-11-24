import { Target } from 'lucide-react';
import type { GoalObservation } from '../shared/types';
import { dateTimeText, formatNumber, t, type MessageKey } from '../shared/i18n';
import { tip } from './Tooltip';
import './turn-progress.css';
import './goal-status.css';

const units: Record<string, MessageKey> = { s: 'telemetry.goalSeconds', m: 'telemetry.goalMinutes', h: 'telemetry.goalHours', d: 'telemetry.goalDays' };
/** Claude Code's own timer ("12s", "3m", "1h"): its largest unit, in the current language. */
export function goalElapsedText(value: string): string {
  const match = /^(\d+)([smhd])$/.exec(value);
  return match ? t(units[match[2]], { n: Number(match[1]) }) : value;
}
/** A duration the way Claude Code shows the goal's: only its largest unit. */
export function goalDurationText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return goalElapsedText(s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`);
}
const statusLabel = { active: 'telemetry.goalActive', met: 'telemetry.goalMet', failed: 'telemetry.goalFailed', cleared: 'telemetry.goalCleared' } as const;

function phaseText(goal: GoalObservation): string | undefined {
  switch (goal.phase) {
    case 'checking': return t('telemetry.goalPhaseChecking');
    case 'not-met': return goal.source === 'transcript' && goal.checks ? t('telemetry.goalPhaseNotMet', { count: goal.checks }) : t('telemetry.goalPhaseNotMetUnknown');
    case 'deferred': return t('telemetry.goalPhaseDeferred');
    case 'retrying': return t('telemetry.goalPhaseRetrying');
    case 'paused': return t('telemetry.goalPhasePaused');
    case 'set': return t('telemetry.goalPhaseSet');
  }
}

/** The goal's facts under its pill: what it is, how its checks went, and Claude Code's own notices. */
function GoalFacts({ goal }: { goal: GoalObservation }) {
  const { result, deferred } = goal;
  const active = goal.status === 'active';
  return <>
    <p className="goal-status-condition"><span>{t('telemetry.goalCondition')}</span>{goal.condition
      ? <q>{goal.condition}</q> : <em>{t(goal.source === 'screen' ? 'telemetry.goalScreenOnly' : 'telemetry.goalConditionUnknown')}</em>}</p>
    {goal.setAt && <p>{t('telemetry.goalSetAt', { time: dateTimeText(goal.setAt) })}</p>}
    {active && !goal.setAt && goal.source === 'transcript' && <p>{t('telemetry.goalRestated')}</p>}
    {active && goal.source === 'probe' && <p>{t('telemetry.goalChecksUnknown')}</p>}
    {goal.source === 'transcript' && goal.checks > 0 && <p>{t('telemetry.goalChecks', { count: goal.checks })}</p>}
    {goal.lastReason && goal.status !== 'met' && <p>{t('telemetry.goalLastReason', { reason: goal.lastReason })}</p>}
    {active && goal.phase === 'checking' && <p>{t('telemetry.goalCheckingNote')}</p>}
    {active && goal.phase === 'deferred' && <p>{t('telemetry.goalDeferredNote')}{deferred?.minutes !== undefined && t('telemetry.goalDeferredFor', { minutes: deferred.minutes })}</p>}
    {active && goal.phase === 'deferred' && !!deferred?.tasks.length && <ul className="goal-status-tasks">{deferred.tasks.map((task, i) => <li key={i}><code>{task}</code></li>)}</ul>}
    {active && goal.phase === 'retrying' && <p>{t('telemetry.goalRetryingNote')}</p>}
    {active && goal.phase === 'paused' && <p>{t('telemetry.goalPausedNote')}</p>}
    {goal.notice && <p className="goal-status-native" lang="en">{t('telemetry.goalNativeNotice', { notice: goal.notice })}</p>}
    {goal.status === 'cleared' && goal.notice && <p>{t('telemetry.goalClearedByError')}</p>}
    {result?.reason && <p>{t('telemetry.goalReason', { reason: result.reason })}</p>}
    {goal.history && active && <p>{t('telemetry.goalHistoryNote')}</p>}
  </>;
}

/**
 * Claude Code's native /goal above the input box (beside the turn's progress pill): whether a goal
 * is going and how its checks went, or how the latest one ended until the next prompt. It opens to
 * the facts and, while it runs in a live session, a "Clear goal" button (App confirms, then sends
 * `/goal clear`, which Claude Code runs at once even during a reply). The selectors are the
 * compatibility matrix's: `data-goal-status`, `data-goal-phase` (active), `data-goal-condition`.
 */
export function GoalStatus({ goal, open, onOpenChange, canClear, onClear }: {
  goal: GoalObservation; open: boolean; onOpenChange: (open: boolean) => void; canClear: boolean; onClear: () => void;
}) {
  const active = goal.status === 'active';
  const phase = active ? phaseText(goal) : undefined;
  const time = active ? goal.screen?.elapsed && goalElapsedText(goal.screen.elapsed)
    : goal.result?.durationMs !== undefined ? goalDurationText(goal.result.durationMs) : undefined;
  const stats = goal.status === 'met' || goal.status === 'failed' ? [goal.result?.iterations !== undefined && t('telemetry.goalTurns', { n: goal.result.iterations }),
    goal.result?.tokens !== undefined && t('telemetry.goalTokens', { tokens: formatNumber(goal.result.tokens) })].filter(Boolean) : [];
  return <details className="turn-progress turn-progress-receipt goal-status" open={open} onToggle={event => onOpenChange(event.currentTarget.open)}
    data-goal-status={goal.status} data-goal-phase={active ? goal.phase ?? 'set' : undefined} data-goal-condition={goal.condition}
    data-goal-source={goal.source} data-goal-history={goal.history || undefined}>
    <summary {...tip(t(statusLabel[goal.status]), t('telemetry.goalHelp'))}>
      <Target size={13} aria-hidden="true" className="goal-status-icon" />
      <span className="goal-status-label">{t(statusLabel[goal.status])}</span>
      {phase && <span className="goal-status-phase">{phase}</span>}
      {time && <span className="turn-progress-count">{time}</span>}
      {stats.map((text, i) => <span key={i} className="turn-progress-count">{text}</span>)}
      {goal.condition && <span className="goal-status-excerpt">{goal.condition}</span>}
    </summary>
    <div className="turn-progress-facts goal-status-facts">
      <GoalFacts goal={goal} />
      {active && !goal.history && <p><button type="button" className="goal-status-clear" data-goal-clear disabled={!canClear}
        onClick={event => { event.preventDefault(); onClear(); }}>{t('telemetry.goalClear')}</button></p>}
    </div>
  </details>;
}
