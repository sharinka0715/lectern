import { runningMs, runStart, type SessionActivity } from '../shared/activity';
import { taskRowsStart } from './native-task-screen';
import { stripTerminalEscapes } from './screen';

/**
 * Claude Code asks a model, about every 30 s while a background subagent's transcript moves on,
 * for a 3-5 word label of what it is doing ("正在编辑 hp.py", "Reading runAgent.ts"). The label
 * stays in memory: neither the transcript nor the meta file has it. From 2.1.329 the task rows
 * below the input box show it in place of the task's description (2.1.332, probed with the
 * matrix's fake API):
 *
 *   ● main
 *   ◯ general-purpose  正在编辑 hp.py                                        37s · ↓ 4.2k tokens
 *   ◯ Explore          Reading runAgent.ts                                 1m 1s · ↓ 4.2k tokens
 *   ◯ general-purpose  正在给 transcript-store.ts 的超长函数名 normalizeEveryRe… 36s · ↓ 4.2k tokens
 *
 * The type column is padded to the widest; a long label is cut with "…"; the rows keep the
 * launch order; tokens show once a subagent has some (2.1.330 the same). More rows than fit end with "↓ N more".
 */
export interface AgentTaskRow {
  /** The subagent's type ("general-purpose"). */
  type: string;
  /** Its progress label, or its description before the first label. */
  text: string;
  /** The time shown, and how coarse it is ("1h 2m": a minute). */
  elapsedMs: number;
  stepMs: number;
}

const elapsed = String.raw`\d+h(?: \d+m)?(?: \d+s)?|\d+m(?: \d+s)?|\d+s`;
const agentRow = new RegExp(String.raw`^ {2,}[◯○◌◎◉] (\S(?:.*?\S)?) {2,}(\S.*?) +(${elapsed})(?: · [↓↑] [\d.,]+[kKmM]? tokens?)?\s*$`, 'u');
// A workflow's row has a progress bar instead ("◯ name  ▱▱▱  0/4 · 11s").
const progressBar = /[▱▰]/u;

function duration(text: string) {
  const part = (unit: string) => Number(new RegExp(String.raw`(\d+)${unit}`).exec(text)?.[1] ?? 0);
  return { elapsedMs: ((part('h') * 60 + part('m')) * 60 + part('s')) * 1000, stepMs: /\d+s/.test(text) ? 1000 : /\d+m/.test(text) ? 60_000 : 3_600_000 };
}

/** The running subagents' rows below the input box (nothing when the screen has none). */
export function agentTaskRows(viewport: string): AgentTaskRow[] {
  const lines = stripTerminalEscapes(viewport).split('\n');
  return lines.slice(taskRowsStart(lines)).flatMap(line => {
    const match = agentRow.exec(line);
    if (!match || progressBar.test(match[2])) return [];
    return [{ type: match[1], text: match[2], ...duration(match[3]) }];
  });
}

/** Progress labels by activity ID (only running subagents keep one). */
export type ProgressLabels = ReadonlyMap<string, string>;

/** The row shows the subagent's description (whole, or cut with "…"): no label yet, or no longer. */
const describes = (row: AgentTaskRow, title: string) => row.text === title || row.text.endsWith('…') && row.text.length > 1 && title.startsWith(row.text.slice(0, -1));
const sameType = (row: AgentTaskRow, item: SessionActivity) => !item.agentType || item.agentType === row.type;

/**
 * The labels after one screen. A row showing a subagent's description clears that one's label.
 * Each other row goes to the first unclaimed running subagent of its type, in launch order,
 * whose running time is the row's (within the row's precision and a few seconds); several of a
 * type launched together keep the rows' order. Running subagents without a row (a dialog covers
 * the rows, or they are past "↓ N more") keep their last label; ended ones lose it.
 */
export function observeProgressLabels(previous: ProgressLabels, activity: readonly SessionActivity[], rows: readonly AgentTaskRow[], now: number): Map<string, string> {
  const ms = (item: SessionActivity) => { const start = runStart(item); return start ? Date.parse(start) : NaN; };
  // Oldest launch first; the activity lists the newest first, so equal times keep the launch order reversed back.
  const running = activity.filter(item => item.kind === 'agent' && item.status === 'running').reverse()
    .map((item, index) => ({ item, index, at: ms(item) })).sort((a, b) => (a.at || 0) - (b.at || 0) || a.index - b.index).map(entry => entry.item);
  const next = new Map([...previous].filter(([id]) => running.some(item => item.id === id)));
  const claimed = new Set<string>(), left: AgentTaskRow[] = [];
  for (const row of rows) {
    const item = running.find(candidate => !claimed.has(candidate.id) && sameType(row, candidate) && describes(row, candidate.title));
    if (item) { claimed.add(item.id); next.delete(item.id); } else left.push(row);
  }
  for (const row of left) {
    const item = running.find(candidate => {
      if (claimed.has(candidate.id) || !sameType(row, candidate)) return false;
      const ran = [runningMs(candidate, now), now - ms(candidate)].filter(value => value !== undefined && Number.isFinite(value)) as number[];
      return ran.some(value => Math.abs(value - row.elapsedMs) <= row.stepMs + 5000);
    });
    if (!item) continue;
    claimed.add(item.id);
    next.set(item.id, row.text);
  }
  return next;
}

/** The activity with each running subagent's last label (`progress`). */
export function withProgressLabels(activity: readonly SessionActivity[], labels: ProgressLabels | undefined): SessionActivity[] {
  if (!labels?.size) return [...activity];
  return activity.map(item => {
    const progress = item.kind === 'agent' && item.status === 'running' ? labels.get(item.id) : undefined;
    return progress ? { ...item, progress } : item;
  });
}
