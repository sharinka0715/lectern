import { t } from './i18n';

export type ActivityKind = 'agent' | 'shell' | 'monitor';
export type ActivityState = 'running' | 'completed' | 'failed' | 'stopped' | 'unobserved';

export interface SessionActivity {
  id: string;
  kind: ActivityKind;
  status: ActivityState;
  title: string;
  taskId?: string;
  command?: string;
  prompt?: string;
  agentType?: string;
  model?: string;
  background?: boolean;
  startedAt?: string;
  updatedAt?: string;
  /** The end of the latest run; absent while running again after a resume. */
  endedAt?: string;
  /** A finished or stopped subagent resumed with SendMessage: when its latest run began. */
  resumedAt?: string;
  /** How many times it was resumed. */
  resumes?: number;
  /** Time spent running before the latest resume, without the gaps between runs. */
  priorRunMs?: number;
  timeoutMs?: number;
  exitCode?: number;
  toolUses?: number;
  tokens?: number;
  output?: string;
  summary?: string;
  events: { key: string; text: string; at?: string }[];
}

/** Background work of a live conversation (see core/background-work.ts). */
export interface BackgroundCounts {
  shells: number; agents: number; monitors: number; workflows: number;
  /** Claude Code reports background shells the transcript has no record of. */
  unknownShells?: boolean;
}

/** "1 个后台 Shell", "2 个子代理", …: the parts with a count, in a fixed order. */
export function backgroundParts(counts: BackgroundCounts | undefined): string[] {
  if (!counts) return [];
  const parts = [counts.shells && t('core.backgroundShells', { count: counts.shells }), counts.agents && t('core.subagents', { count: counts.agents }),
    counts.monitors && t('core.monitors', { count: counts.monitors }), counts.workflows && t('core.workflows', { count: counts.workflows })]
    .filter((part): part is string => !!part);
  if (counts.unknownShells) parts.unshift(t('core.backgroundShell'));
  return parts;
}

/** When the current (or last) run began: the launch, or the latest resume. */
export const runStart = (item: Pick<SessionActivity, 'startedAt' | 'resumedAt'>) => item.resumedAt ?? item.startedAt;

/** Time spent running across the launch and every resume, up to `now` while running. */
export function runningMs(item: SessionActivity, now: number): number | undefined {
  const start = runStart(item);
  if (!start || (!item.endedAt && item.status !== 'running')) return;
  return (item.priorRunMs ?? 0) + Math.max(0, (item.endedAt ? Date.parse(item.endedAt) : now) - Date.parse(start));
}

/** A section header of the activity card: "2 运行中 · 3 完成" (a resumed subagent runs again). */
export function activityTally(items: readonly SessionActivity[]): string {
  const running = items.filter(item => item.status === 'running').length;
  const failed = items.filter(item => item.status === 'failed').length, ended = items.length - running;
  return [running && t('activity.running', { count: running }),
    ended && (failed ? t('activity.endedFailed', { ended, failed }) : t('activity.completed', { count: ended }))].filter(Boolean).join(' · ');
}

/** Claude Code shows a foreground shell inline in the transcript; only background
 * shells (run_in_background, or moved there with Ctrl+B) are tasks of their own. */
export function panelActivities(items: readonly SessionActivity[]): SessionActivity[] {
  return items.filter(item => item.kind !== 'shell' || item.background === true);
}

export interface LiveShell { command?: string; title?: string; startedAt?: string; output?: string; lines?: number;
  /** The session waits for a permission or other native prompt: the command has not run yet. */
  waiting?: boolean }
/** Foreground shells still running, keyed by tool_use id. Claude Code 2.1.328 writes
 * no progress records for them, so output appears only when a sample exists. */
export function liveShells(items: readonly SessionActivity[]): ReadonlyMap<string, LiveShell> {
  return new Map(items.filter(item => item.kind === 'shell' && item.background !== true && item.status === 'running')
    .map(item => [item.id, { command: item.command, title: item.title !== item.command?.split('\n')[0].slice(0, 200) ? item.title : undefined,
      startedAt: item.startedAt, output: item.output }]));
}

/** Claude Code's own progress for a running foreground command, from its screen:
 * `⎿  $ <command> (4s · 5 lines)`. The command may be cut off with "…". */
export function shellScreenLines(viewport: string, command: string): number | undefined {
  const first = command.split('\n')[0].trim();
  let found: number | undefined;
  for (const line of viewport.replace(/\x1b\[[0-9;]*m/g, '').split('\n')) {
    const match = /^\s*(?:⎿\s+)?\$ (.+?) \([^()]*· (\d+) lines?\)\s*$/u.exec(line);
    if (!match) continue;
    const shown = match[1].replace(/…$/u, '').trim();
    if (!shown || !(match[1].endsWith('…') ? first.startsWith(shown) : first === shown)) continue;
    if (found !== undefined) return; // ambiguous: two such commands on screen
    found = Number(match[2]);
  }
  return found;
}
