import { useEffect, useState } from 'react';
import { Check, CircleAlert, Loader2, Square, Unplug } from 'lucide-react';
import { runningMs, type ActivityState } from '../shared/activity';
import type { ChatView, SubagentFile, SubagentTranscript, Workspace } from '../shared/types';
import type { ArtifactTarget } from './ArtifactDrawer';
import { ConversationTranscript } from './ConversationTranscript';
import type { ReplyDetail } from './desktop-state';
import { reportActionError } from './diagnostics';
import type { SubagentEntry } from './subagent-entries';
import { t } from '../shared/i18n';

export const states = { running: 'activity.stateRunning', completed: 'activity.stateCompleted', failed: 'activity.stateFailed', stopped: 'activity.stateStopped', interrupted: 'activity.stateInterrupted', unobserved: 'activity.stateUnobserved' } as const;
export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
const ignoreFollow = () => {};
const NO_FILES: SubagentFile[] = [];

export function StateIcon({ status }: { status: ActivityState }) {
  return status === 'completed' ? <Check size={12} /> : status === 'failed' ? <CircleAlert size={12} /> : status === 'stopped' ? <Square size={10} />
    : status === 'interrupted' ? <Unplug size={11} /> : <i />;
}
export function elapsed(ms?: number) {
  if (ms === undefined) return '';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds >= 60 ? t('activity.minutesSeconds', { m: Math.floor(seconds / 60), s: seconds % 60 }) : t('activity.seconds', { s: seconds });
}

/** The subagent transcript files, read when the column opens and whenever a subagent starts, ends or
 * resumes; every few seconds while a running one has no reported ID (its meta file names its launch).
 * Not read (`enabled` false) when the activity already lists every subagent (Claude Code 2.1.310+). */
export function useSubagentFiles(workspaceId: string, sessionId: string, agentsKey: string, unidentified: boolean, enabled = true) {
  const [files, setFiles] = useState<SubagentFile[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let current = true, timer = 0;
    const list = () => window.desktop.listSubagents(workspaceId, sessionId).then(found => { if (current) setFiles(found); },
      error => reportActionError(error, '读取子代理列表失败')).finally(() => { if (current && unidentified) timer = window.setTimeout(list, 3000); });
    timer = window.setTimeout(list, 300);
    return () => { current = false; window.clearTimeout(timer); };
  }, [workspaceId, sessionId, agentsKey, unidentified, enabled]);
  return enabled ? files : NO_FILES;
}

interface Reading { agentId: string; data?: SubagentTranscript; error?: string }
/** One subagent's conversation: read every second while it runs, once more when its state changes. */
function useSubagentTranscript(workspaceId: string, sessionId: string, view: ChatView, agentId: string | undefined, toolUseId: string | undefined, status: ActivityState | undefined, attempt: number) {
  const [reading, setReading] = useState<Reading>();
  const pollState = status === 'running' ? 'running' : status === 'unobserved' ? 'unknown' : status ?? 'none';
  useEffect(() => {
    if (!agentId) return;
    let stopped = false, timer = 0, revision: number | undefined;
    const tick = async () => {
      try {
        const result = await window.desktop.readSubagent(workspaceId, sessionId, agentId, { revision, toolUseId }, view);
        if (stopped) return;
        revision = result.revision;
        setReading(previous => ({ agentId, data: { ...result, messages: result.messages ?? (previous?.agentId === agentId ? previous.data?.messages : undefined) } }));
      } catch (error) {
        if (stopped) return;
        setReading(previous => ({ ...(previous?.agentId === agentId ? previous : {}), agentId, error: errorText(error) }));
      }
      // A run in progress is followed closely; an unknown state now and then; an ended one not at all.
      if (!stopped && (pollState === 'running' || pollState === 'unknown')) timer = window.setTimeout(tick, pollState === 'running' ? 1000 : 5000);
    };
    void tick();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [workspaceId, sessionId, view, agentId, toolUseId, pollState, attempt]);
  return [reading?.agentId === agentId ? reading : undefined, setReading] as const;
}

/** The selected subagent's own conversation (prompt, replies, tool calls with results, folded
 * thinking), rendered by the main transcript's components and read while it runs. */
export function SubagentDetail({ entry, now, workspace, sessionId, view, replyDetail, sizeMiB, openArtifact }: {
  entry: SubagentEntry; now: number; workspace: Workspace; sessionId: string; view: ChatView; replyDetail: ReplyDetail; sizeMiB: number;
  openArtifact(target: ArtifactTarget): void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [reading, setReading] = useSubagentTranscript(workspace.id, sessionId, view, entry.agentId, entry.item?.id, entry.status, attempt);
  const retry = () => setAttempt(n => n + 1);
  async function loadEarlier(cursor: string) {
    if (!entry.agentId) return;
    const agentId = entry.agentId;
    const result = await window.desktop.readSubagent(workspace.id, sessionId, agentId, { older: cursor, sizeMiB, toolUseId: entry.item?.id }, view);
    setReading(previous => previous?.agentId === agentId ? { agentId, data: { ...result, messages: result.messages ?? previous.data?.messages } } : previous);
  }
  const item = entry.item;
  const facts = [entry.agentType, item?.model, elapsed(item && runningMs(item, now)),
    item?.resumes ? t('activity.resumedCount', { count: item.resumes }) : ''].filter(Boolean).join(' · ');
  const data = reading?.data;
  let placeholder;
  if (!entry.agentId) placeholder = <p className="subagent-note">{t('activity.subagentNoId')}</p>;
  else if (reading?.error && !data?.messages) placeholder = <div className="subagent-note" role="alert">{t('activity.subagentFailed', { error: reading.error })}
    <button type="button" className="secondary-button" onClick={retry}>{t('activity.subagentRetry')}</button></div>;
  else if (!data) placeholder = <p className="subagent-note" role="status"><Loader2 size={14} className="rotating" />{t('activity.subagentLoading')}</p>;
  else if (data.missing) placeholder = <p className="subagent-note">{t('activity.subagentMissing')}</p>;
  else placeholder = <p className="subagent-note">{t('activity.subagentEmpty')}</p>;
  return <section className="subagent-detail" data-subagent-detail={entry.agentId} data-state={entry.status}>
    <div className="subagent-detail-head">
      <strong title={entry.title}>{entry.title}</strong>
      <span className="subagent-detail-state" data-state={entry.status}><StateIcon status={entry.status} />{t(states[entry.status])}</span>
      {facts && <small>{facts}</small>}
    </div>
    {data?.notice && <p className="subagent-notice" role="status">{data.notice}</p>}
    {reading?.error && data?.messages && <p className="subagent-notice" role="alert">{t('activity.subagentFailed', { error: reading.error })}</p>}
    <ConversationTranscript key={entry.agentId ?? entry.key} workspace={workspace} sessionId={sessionId} replyDetail={replyDetail}
      messages={entry.agentId ? data?.messages : undefined} historyPage={data?.historyPage} loadEarlier={loadEarlier} onFollowLatest={ignoreFollow} openArtifact={openArtifact}>
      {placeholder}
    </ConversationTranscript>
  </section>;
}
