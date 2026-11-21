import { backgroundParts, runStart, type BackgroundCounts, type SessionActivity } from '../shared/activity';
import { joinList, t } from '../shared/i18n';

export interface PendingBackground { agents: number; workflows: number; at?: string }

/**
 * What runs besides Claude's reply: background shells, subagents and monitors from
 * the transcript, and the subagents and workflows the last turn_duration record
 * left pending.
 *
 * Claude Code's own state cross-checks the transcript, which has no record of
 * work that died with an earlier process: "idle" means no background shells,
 * subagents or workflows (monitors are not part of it), "shell" means background
 * shells but no subagents or workflows. Work started before the current process
 * (`since`, its registration time) is not counted either; a subagent resumed in
 * this process counts from its resume.
 *
 * `listed` (Claude Code 2.1.310+, core/subagent-status.ts): the activity lists every
 * subagent with the state its meta file gives, already checked against the process;
 * the subagents counted are exactly the running ones it lists, as the activity card and
 * the task column show them.
 */
export function backgroundCounts(activity: readonly SessionActivity[], pending?: PendingBackground, native?: string, since?: number, listed = false): BackgroundCounts {
  const current = (at?: string) => since === undefined || !at || Date.parse(at) >= since - 1000;
  const running = activity.filter(item => item.status === 'running' && (item.kind === 'monitor' || item.background === true) && (listed && item.kind === 'agent' || current(runStart(item))));
  const count = (kind: SessionActivity['kind']) => running.filter(item => item.kind === kind).length;
  const shellsAllowed = native !== 'idle', delegationAllowed = native !== 'idle' && native !== 'shell';
  const waiting = pending && current(pending.at) ? pending : undefined;
  const shells = shellsAllowed ? count('shell') : 0;
  return {
    shells, monitors: count('monitor'),
    agents: listed ? count('agent') : delegationAllowed ? Math.max(count('agent'), waiting?.agents ?? 0) : 0,
    workflows: delegationAllowed ? waiting?.workflows ?? 0 : 0,
    ...(!shells && native === 'shell' && { unknownShells: true }),
  };
}

/** The sidebar's and title bar's "后台运行中" detail, after Claude's reply. */
export function backgroundSummary(activity: readonly SessionActivity[], pending?: PendingBackground, native?: string, since?: number, listed = false): string | undefined {
  const parts = backgroundParts(backgroundCounts(activity, pending, native, since, listed));
  if (!parts.length) return;
  const text = joinList(parts);
  return t(/[A-Za-z]$/.test(text) ? 'core.stillRunningLatin' : 'core.stillRunning', { what: text });
}
