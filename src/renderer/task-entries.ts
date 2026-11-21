import { runOrder, type ActivityKind, type ActivityState, type SessionActivity } from '../shared/activity';
import type { SubagentFile } from '../shared/types';
import { defaultSubagent, subagentEntries, type SubagentEntry } from './subagent-entries';

/** One row of the task column: a subagent, a background shell or a monitor. */
export interface TaskEntry {
  /** Stable while the column is open: the launching tool call (or `agent:<id>` for an earlier subagent). */
  key: string;
  kind: ActivityKind;
  title: string;
  /** A subagent's type; a shell's or monitor's command when its title is a description. */
  note?: string;
  status: ActivityState;
  /** The activity card's item (absent for an earlier subagent known only from its file). */
  item?: SessionActivity;
  agent?: SubagentEntry;
}
export type TaskGroups = Record<ActivityKind, TaskEntry[]>;
export const TASK_KINDS = ['agent', 'shell', 'monitor'] as const;

/** The column's rows by kind: subagents as subagent-entries.ts merges and orders them, then
 * the card's background shells and monitors, running ones first, then ended ones, each newest
 * first (`runOrder`). The shown entry is found by key (`shownTask`), so a reorder never changes which one is shown. */
export function taskEntries(items: readonly SessionActivity[], files: readonly SubagentFile[]): TaskGroups {
  const agents = subagentEntries(items, files).map((agent): TaskEntry => ({ key: agent.key, kind: 'agent', title: agent.title, note: agent.agentType, status: agent.status, item: agent.item, agent }));
  const tasks = (kind: 'shell' | 'monitor') => runOrder(items.filter(item => item.kind === kind && (kind === 'monitor' || item.background === true))).map((item): TaskEntry => {
    const head = item.command?.split('\n')[0].replace(/\s*\\$/, '').trim();
    return { key: item.id, kind, title: item.title, note: head && head !== item.title ? head : undefined, status: item.status, item };
  });
  return { agent: agents, shell: tasks('shell'), monitor: tasks('monitor') };
}

/** Without a choice: a running entry of the kind asked for, else its first; the default
 * subagent when no kind was asked for (or it has none); else any entry. */
export function defaultTask(groups: TaskGroups, kind?: ActivityKind): TaskEntry | undefined {
  const pick = (list: TaskEntry[]) => list.find(entry => entry.status === 'running') ?? list[0];
  if (kind && kind !== 'agent' && groups[kind].length) return pick(groups[kind]);
  const agent = defaultSubagent(groups.agent.map(entry => entry.agent!));
  return (agent && groups.agent.find(entry => entry.agent === agent)) ?? pick(groups.shell) ?? pick(groups.monitor);
}

/** The entry shown: the chosen one; a subagent found again by its agent ID when its key
 * changed (older history gave it the card's key, or a reset took it away); else the default. */
export function shownTask(groups: TaskGroups, selected?: string, agentId?: string, kind?: ActivityKind): TaskEntry | undefined {
  const all = TASK_KINDS.flatMap(name => groups[name]);
  return all.find(entry => entry.key === selected)
    ?? (agentId ? groups.agent.find(entry => entry.agent?.agentId === agentId) : undefined)
    ?? defaultTask(groups, kind);
}
