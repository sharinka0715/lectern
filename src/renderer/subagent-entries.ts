import { runOrder, type ActivityState, type SessionActivity } from '../shared/activity';
import type { SubagentFile } from '../shared/types';

/** One row of the subagent column. */
export interface SubagentEntry {
  /** Stable while the column is open: the launching Agent call, else the agent ID. */
  key: string;
  /** The ID its transcript is named by; unknown until Claude Code reports it. */
  agentId?: string;
  title: string;
  agentType?: string;
  status: ActivityState;
  /** Its activity, when the launch is in the loaded history (the lifecycle source). */
  item?: SessionActivity;
  file?: SubagentFile;
}

/**
 * The conversation's subagents: those of the activity card first (their state
 * follows the lifecycle in session-activity.ts), running ones before ended ones,
 * each newest first by its latest start (`runOrder`), matched to their transcript
 * files by agent ID or by the launching tool call in the meta file; then, whatever
 * their meta file says, the transcripts whose launch is in history not loaded yet,
 * as the backend lists them (last written first).
 */
export function subagentEntries(items: readonly SessionActivity[], files: readonly SubagentFile[]): SubagentEntry[] {
  const byAgent = new Map(files.map(file => [file.agentId, file]));
  const byTool = new Map(files.flatMap(file => file.toolUseId ? [[file.toolUseId, file] as const] : []));
  const used = new Set<string>();
  const entries: SubagentEntry[] = runOrder(items.filter(item => item.kind === 'agent')).map(item => {
    const file = (item.taskId ? byAgent.get(item.taskId) : undefined) ?? byTool.get(item.id);
    if (file) used.add(file.agentId);
    return { key: item.id, agentId: item.taskId ?? file?.agentId, title: item.title, agentType: item.agentType ?? file?.agentType, status: item.status, item, file };
  });
  for (const file of files) {
    if (used.has(file.agentId)) continue;
    entries.push({ key: 'agent:' + file.agentId, agentId: file.agentId, title: file.description ?? file.agentId, agentType: file.agentType,
      status: file.finished ? 'completed' : 'unobserved', file });
  }
  return entries;
}

/** The entry to show when the column opens without a choice: a running one first. */
export function defaultSubagent(entries: readonly SubagentEntry[]): SubagentEntry | undefined {
  return entries.find(entry => entry.status === 'running' && entry.agentId) ?? entries.find(entry => entry.agentId) ?? entries[0];
}

/** The entry the column shows: the chosen one, found again by its agent ID when
 * its key changed (loading older history turns a transcript-only row into the
 * activity card's, or a reset turns it back); otherwise the default. */
export function shownSubagent(entries: readonly SubagentEntry[], selected?: string, agentId?: string): SubagentEntry | undefined {
  return entries.find(entry => entry.key === selected)
    ?? (agentId ? entries.find(entry => entry.agentId === agentId) : undefined)
    ?? defaultSubagent(entries);
}
