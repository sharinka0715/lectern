import { runStart, type ActivityState, type SessionActivity } from '../shared/activity';
import { t } from '../shared/i18n';
import type { SubagentFile } from '../shared/types';

/**
 * Claude Code 2.1.310 and later keep each subagent's state in its meta file
 * (`<session>/subagents/agent-<id>.meta.json`): `finished` is written when a run ends
 * (completed, failed, stopped, or stopped while its own background work runs) and
 * cleared, with `revivedAt`, when SendMessage resumes it. Together with whether the
 * process that runs the session is still there, that gives every subagent's state
 * without the main transcript; the transcript, where loaded, only refines it (how a
 * run ended, the resumes, the times, the launching call).
 *
 * 2.1.300 writes no `finished`: its subagents keep the state the loaded transcript
 * gives them (session-activity.ts) and the task column lists the others as earlier.
 */
const META_STATE_SINCE = [2, 1, 310];

/** Whether `version` (x.y.z…) is at least `min`; undefined when it is not a version. */
export function versionAtLeast(version: string | undefined, min: readonly number[]): boolean | undefined {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '')?.slice(1).map(Number);
  if (!parts) return;
  for (let i = 0; i < min.length; i++) if (parts[i] !== min[i]) return parts[i] > min[i];
  return true;
}

/** A meta file that a 2.1.310+ background run keeps current: it has `finished`, `revivedAt` or
 * `isBuiltIn` (absent from 2.1.300's) and was not launched as a call that waits for it. */
export const metaTracked = (file: SubagentFile) =>
  file.finished !== undefined || file.revivedAt !== undefined || (file.isBuiltIn !== undefined && !file.foreground);

/** Whether the session's subagents are listed from their folder with the state their meta
 * files give: Claude Code 2.1.310 or later by the session's version; without a version, when a
 * meta file has `isBuiltIn`, which 2.1.310 and later write into every one. 2.1.300, or no sign
 * either way: the transcript. */
export function listsSubagents(cliVersion: string | undefined, files: readonly SubagentFile[]): boolean {
  return versionAtLeast(cliVersion, META_STATE_SINCE) ?? files.some(file => file.isBuiltIn !== undefined);
}

/** `alive`: a live pane runs the session; `gone`: none does (it exited or crashed);
 * `unknown`: the machine could not be read. */
export type SessionLiveness = 'alive' | 'gone' | 'unknown';
export interface SubagentContext {
  live: SessionLiveness;
  /** When the running Claude Code process started (ms): a subagent last written before it
   * belonged to an earlier process, which took it along when it ended. */
  since?: number;
}

const ENDED = new Set<ActivityState>(['completed', 'failed', 'stopped']);
const ms = (value?: string) => { const n = value ? Date.parse(value) : NaN; return Number.isNaN(n) ? undefined : n; };

/**
 * A tracked subagent's state. `finished`: ended, as the transcript's notification says when it is
 * loaded (completed, failed or stopped), else stopped when the user stopped it and it never ran
 * again, else completed. Not finished: running while the process that launched or resumed it
 * (its meta file was written since that process started) still runs; interrupted once that
 * process is gone; unobserved while the machine cannot be read.
 */
export function metaState(file: SubagentFile, item: SessionActivity | undefined, context: SubagentContext): ActivityState {
  if (file.finished) return item && ENDED.has(item.status) ? item.status : file.stoppedByUser && !file.revivedAt ? 'stopped' : 'completed';
  if (context.live === 'unknown') return 'unobserved';
  const written = Math.max(ms(file.metaModifiedAt) ?? 0, ms(file.revivedAt) ?? 0);
  // mtime has whole seconds: allow for that and a little more.
  const current = context.since === undefined || !written || written >= context.since - 2000;
  return context.live === 'alive' && current ? 'running' : 'interrupted';
}

/**
 * The activity with every subagent of the session's folder (Claude Code 2.1.310+): the
 * transcript's subagent items get the state their meta file gives and their agent ID; those
 * whose launch is not loaded are added (keyed by the launching call from the meta file, so
 * the key stays when older history loads it), with the time of their transcript's first record.
 * A subagent of an older version in the same session (no tracked meta file) keeps its transcript
 * state, or is unobserved without one. Other items are unchanged and keep their order.
 */
export function mergeSubagents(activity: readonly SessionActivity[], files: readonly SubagentFile[], context: SubagentContext): SessionActivity[] {
  const agents = activity.filter(item => item.kind === 'agent');
  const byTask = new Map(agents.flatMap(item => item.taskId ? [[item.taskId, item] as const] : []));
  const byId = new Map(agents.map(item => [item.id, item]));
  const ids = new Set(activity.map(item => item.id)), replaced = new Map<SessionActivity, SessionActivity>(), added: SessionActivity[] = [];
  for (const file of files) {
    const launch = file.toolUseId ? byId.get(file.toolUseId) : undefined;
    const item = byTask.get(file.agentId) ?? (launch && (!launch.taskId || launch.taskId === file.agentId) ? launch : undefined);
    if (item && replaced.has(item)) continue;
    const tracked = metaTracked(file);
    const status = tracked ? metaState(file, item, context) : item ? earlierProcess(item, context).status : file.finished ? 'completed' : 'unobserved';
    const id = item?.id ?? (file.toolUseId && !ids.has(file.toolUseId) ? file.toolUseId : 'agent:' + file.agentId);
    ids.add(id);
    const next: SessionActivity = { ...(item ?? { id, kind: 'agent', title: file.description ?? t('core.subagent'), agentType: file.agentType, events: [] }),
      events: [...item?.events ?? []], status, taskId: file.agentId };
    if (!next.model && file.model) next.model = file.model;
    if (tracked) next.background = true;
    // Never revived and not finished: the meta file was written at the launch.
    const launched = file.startedAt ?? (!file.finished && !file.revivedAt ? file.metaModifiedAt : undefined);
    if (!next.startedAt && launched) next.startedAt = launched;
    const revived = ms(file.revivedAt), start = ms(runStart(next));
    if (revived !== undefined && (!item || item.status !== 'running' && status === 'running') && (start === undefined || revived > start)) next.resumedAt = file.revivedAt;
    if (status === 'running') delete next.endedAt;
    else if (file.finished && !next.endedAt && file.metaModifiedAt) next.endedAt = file.metaModifiedAt;
    if (item) replaced.set(item, next); else added.push(next);
  }
  // Newest launch first, like the transcript's own items.
  added.sort((a, b) => (ms(b.startedAt) ?? 0) - (ms(a.startedAt) ?? 0));
  return [...activity.map(item => replaced.get(item) ?? earlierProcess(item, context)), ...added];
}

/** A subagent without a tracked meta file that the transcript leaves running, though its
 * run began before the running process did: that process never ran it. */
function earlierProcess(item: SessionActivity, context: SubagentContext): SessionActivity {
  const start = ms(runStart(item));
  return item.kind === 'agent' && item.status === 'running' && context.since !== undefined && start !== undefined && start < context.since - 1000
    ? { ...item, status: 'unobserved' } : item;
}

/** Background subagents running now, as the merged list says (for the counts beside it). */
export const runningSubagents = (activity: readonly SessionActivity[]) =>
  activity.filter(item => item.kind === 'agent' && item.background === true && item.status === 'running').length;
