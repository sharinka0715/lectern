// Quitting Lectern while conversations still run in tmux: what the quit dialog
// shows and answers. The main process decides and closes (src/main/quit-guard.ts);
// the renderer only shows this state (src/renderer/QuitDialog.tsx).
import { backgroundParts, type BackgroundCounts } from './activity';
import { joinList, t } from './i18n';
import type { WorkspaceEndpoint } from './types';

/** What a running conversation is doing, as far as Lectern can tell. */
export type QuitActivity = 'working' | 'waiting' | 'idle' | 'unknown';
export type QuitCloseState = 'pending' | 'closing' | 'closed' | 'failed';

export interface QuitSession {
  workspaceId: string;
  sessionId: string;
  /** Empty when the conversation has no title yet: shown as its first prompt or short ID. */
  title: string;
  /** The first prompt, when there is no title and an open reader has it. */
  prompt?: string;
  /** The folder's name, as in the sidebar. */
  folder: string;
  endpoint: WorkspaceEndpoint;
  paneId: string;
  panePid?: number;
  activity: QuitActivity;
  /** Background shells, subagents, monitors and workflows an open reader counts. */
  background?: BackgroundCounts;
  /** Claude Code reports background work without counts. */
  backgroundUnknown?: boolean;
  /** Seen running earlier; the machine could not be checked just now. */
  unconfirmed?: boolean;
  close?: QuitCloseState;
  error?: string;
}

/** A folder whose machine could not be checked when quitting. */
export interface QuitUnchecked { workspaceId: string; folder: string; endpoint: WorkspaceEndpoint; error: string }

export type QuitPhase = 'confirm' | 'closing' | 'failed';
/** A new phase gets a new id; progress within "closing" keeps it. */
export interface QuitPrompt { id: number; phase: QuitPhase; sessions: QuitSession[]; unchecked: QuitUnchecked[] }
export type QuitAnswer = 'cancel' | 'leave' | 'close' | 'quit-anyway';
export const quitAnswers: readonly QuitAnswer[] = ['cancel', 'leave', 'close', 'quit-anyway'];

/** "ask": show the dialog; "leave": quit at once and leave conversations running. */
export type QuitWhenRunning = 'ask' | 'leave';
export interface QuitPreferences { whenRunning: QuitWhenRunning }
export const defaultQuitPreferences: QuitPreferences = { whenRunning: 'ask' };

/** Same form as the sidebar's machine key: "local", or ssh host and port. */
export function endpointKey(endpoint: WorkspaceEndpoint): string {
  return endpoint.kind === 'ssh' ? JSON.stringify(['ssh', endpoint.host, endpoint.port ?? null]) : 'local';
}

/** host[:port], or this computer: the name when there is no saved connection name. */
export function plainMachineName(endpoint: WorkspaceEndpoint): string {
  return endpoint.kind === 'ssh' ? `${endpoint.host}${endpoint.port ? `:${endpoint.port}` : ''}` : t('workbench.local');
}

export interface QuitMachineGroup {
  key: string;
  name: string;
  endpoint: WorkspaceEndpoint;
  sessions: QuitSession[];
  /** Folders of this machine that could not be checked. */
  unchecked: QuitUnchecked[];
}

const collator = () => new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Conversations by machine: this computer first, then by name. Inside a machine, by folder
 * and title; after a failed close, the conversations that are still running come first. */
export function quitGroups(prompt: Pick<QuitPrompt, 'sessions' | 'unchecked'>, nameOf: (endpoint: WorkspaceEndpoint) => string = plainMachineName): QuitMachineGroup[] {
  const groups = new Map<string, QuitMachineGroup>();
  const group = (endpoint: WorkspaceEndpoint) => {
    const key = endpointKey(endpoint);
    let found = groups.get(key);
    if (!found) groups.set(key, found = { key, name: nameOf(endpoint), endpoint, sessions: [], unchecked: [] });
    return found;
  };
  for (const session of prompt.sessions) group(session.endpoint).sessions.push(session);
  for (const folder of prompt.unchecked) group(folder.endpoint).unchecked.push(folder);
  const compare = collator().compare;
  for (const item of groups.values()) {
    item.sessions.sort((a, b) => Number(b.close === 'failed') - Number(a.close === 'failed')
      || compare(a.folder, b.folder) || compare(quitTitle(a), quitTitle(b)) || a.paneId.localeCompare(b.paneId));
  }
  return [...groups.values()].sort((a, b) => Number(b.key === 'local') - Number(a.key === 'local') || compare(a.name, b.name) || a.key.localeCompare(b.key));
}

/** The title, else the first prompt on one line, else "对话 1a2b3c4d". */
export function quitTitle(session: Pick<QuitSession, 'title' | 'prompt' | 'sessionId'>): string {
  const prompt = session.prompt?.replace(/\s+/g, ' ').trim();
  return session.title.trim() || (prompt ? (prompt.length > 80 ? prompt.slice(0, 79) + '…' : prompt) : t('quit.untitled', { id: session.sessionId.slice(0, 8) }));
}

const activityKeys = { working: 'quit.working', waiting: 'quit.waiting', idle: 'quit.idle', unknown: 'quit.unknown' } as const;

/** "正在回复", "等待你的确认", "空闲" … with the background work it would stop. */
export function quitActivityText(session: Pick<QuitSession, 'activity' | 'background' | 'backgroundUnknown'>): string {
  const parts = backgroundParts(session.background);
  const what = parts.length ? joinList(parts) : session.backgroundUnknown ? t('quit.backgroundSome') : undefined;
  const state = t(session.activity === 'idle' && what ? 'app.replyComplete' : activityKeys[session.activity]);
  return what ? t('quit.withBackground', { state, what }) : state;
}
