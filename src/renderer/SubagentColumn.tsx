import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Check, CircleAlert, Loader2, Square, X } from 'lucide-react';
import { activityTally, runningMs, type ActivityState, type SessionActivity } from '../shared/activity';
import type { ChatView, SubagentFile, SubagentTranscript, Workspace } from '../shared/types';
import type { ArtifactTarget } from './ArtifactDrawer';
import { ConversationTranscript } from './ConversationTranscript';
import type { ReplyDetail } from './desktop-state';
import { reportActionError } from './diagnostics';
import { shownSubagent, subagentEntries, type SubagentEntry } from './subagent-entries';
import { t } from '../shared/i18n';
import './subagent-column.css';

const states = { running: 'activity.stateRunning', completed: 'activity.stateCompleted', failed: 'activity.stateFailed', stopped: 'activity.stateStopped', unobserved: 'activity.stateUnobserved' } as const;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
const ignoreFollow = () => {};

function StateIcon({ status }: { status: ActivityState }) {
  return status === 'completed' ? <Check size={12} /> : status === 'failed' ? <CircleAlert size={12} /> : status === 'stopped' ? <Square size={10} /> : <i />;
}
function elapsed(ms?: number) {
  if (ms === undefined) return '';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds >= 60 ? t('activity.minutesSeconds', { m: Math.floor(seconds / 60), s: seconds % 60 }) : t('activity.seconds', { s: seconds });
}

/** The subagent transcript files, read when the column opens and whenever a subagent starts, ends or
 * resumes; every few seconds while a running one has no reported ID (its meta file names its launch). */
function useSubagentFiles(workspaceId: string, sessionId: string, agentsKey: string, unidentified: boolean) {
  const [files, setFiles] = useState<SubagentFile[]>([]);
  useEffect(() => {
    let current = true, timer = 0;
    const list = () => window.desktop.listSubagents(workspaceId, sessionId).then(found => { if (current) setFiles(found); },
      error => reportActionError(error, '读取子代理列表失败')).finally(() => { if (current && unidentified) timer = window.setTimeout(list, 3000); });
    timer = window.setTimeout(list, 300);
    return () => { current = false; window.clearTimeout(timer); };
  }, [workspaceId, sessionId, agentsKey, unidentified]);
  return files;
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

interface Props {
  workspace: Workspace;
  sessionId: string;
  view: ChatView;
  /** The activity card's subagents, shells and monitors; only subagents are listed. */
  items: SessionActivity[];
  selected?: string;
  /** Changes when the activity card asks to show (and focus) a subagent. */
  focusToken: number;
  replyDetail: ReplyDetail;
  sizeMiB: number;
  onSelect(key: string): void;
  onClose(): void;
  openArtifact(target: ArtifactTarget): void;
}

/**
 * The subagent column on the right of a pane: the conversation's subagents,
 * and the selected one's own conversation (prompt, replies, tool calls with
 * results, folded thinking), rendered by the main transcript's components and
 * updated while it runs.
 */
export function SubagentColumn(props: Props) {
  const { workspace, sessionId, view, items } = props;
  const agents = useMemo(() => items.filter(item => item.kind === 'agent'), [items]);
  const agentsKey = agents.map(item => `${item.id}:${item.taskId ?? ''}:${item.status}:${item.resumes ?? 0}`).join(',');
  const files = useSubagentFiles(workspace.id, sessionId, agentsKey, agents.some(item => item.status === 'running' && !item.taskId));
  const entries = useMemo(() => subagentEntries(agents, files), [agents, files]);
  // The one shown stays shown when others start or end, and when loading older
  // history gives it the activity card's key.
  const shownAgent = useRef<string | undefined>(undefined);
  const entry = shownSubagent(entries, props.selected, shownAgent.current);
  useEffect(() => { shownAgent.current = entry?.agentId; });
  const { onSelect } = props;
  useEffect(() => { if (entry && entry.key !== props.selected) onSelect(entry.key); }, [entry?.key, props.selected, onSelect]); // eslint-disable-line react-hooks/exhaustive-deps
  const [attempt, setAttempt] = useState(0);
  const [reading, setReading] = useSubagentTranscript(workspace.id, sessionId, view, entry?.agentId, entry?.item?.id, entry?.status, attempt);
  const [now, setNow] = useState(Date.now);
  const running = agents.some(item => item.status === 'running');
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  // The pane's reader keeps the last few subagents parsed until the column closes.
  useEffect(() => () => { void window.desktop.releaseSubagents(workspace.id, sessionId, view).catch(error => reportActionError(error, '释放子代理对话失败')); },
    [workspace.id, sessionId, view]);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!props.focusToken) return;
    const row = list.current?.querySelector<HTMLButtonElement>('[aria-current="true"]') ?? list.current?.querySelector('button');
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: 'nearest' });
  }, [props.focusToken]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadEarlier(cursor: string) {
    if (!entry?.agentId) return;
    const agentId = entry.agentId;
    const result = await window.desktop.readSubagent(workspace.id, sessionId, agentId, { older: cursor, sizeMiB: props.sizeMiB, toolUseId: entry.item?.id }, view);
    setReading(previous => previous?.agentId === agentId ? { agentId, data: { ...result, messages: result.messages ?? previous.data?.messages } } : previous);
  }

  return <aside className="subagent-column" aria-label={t('activity.subagentColumn')} data-subagent-column>
    <header className="subagent-column-bar">
      <Bot size={15} aria-hidden="true" /><span>{t('activity.subagentColumn')}</span>
      {!!agents.length && <small>{activityTally(agents)}</small>}
      <button type="button" className="icon-button" aria-label={t('activity.closeSubagents')} title={t('activity.closeSubagents')} onClick={props.onClose}><X size={15} /></button>
    </header>
    {entries.length ? <ul ref={list} className="subagent-list" aria-label={t('activity.subagentList')}>
      {entries.map(item => <li key={item.key}>
        <button type="button" aria-current={item.key === entry?.key} data-subagent-key={item.key} data-agent-id={item.agentId} data-state={item.status}
          onClick={() => props.onSelect(item.key)}>
          <span className="subagent-dot" data-state={item.status} aria-hidden="true" />
          <span className="subagent-name">{item.title}{item.agentType && <small>{item.agentType}</small>}</span>
          <span className="subagent-state">{item.item ? t(states[item.status]) : item.status === 'completed' ? t(states.completed) : t('activity.subagentEarlier')}</span>
        </button>
      </li>)}
    </ul> : <p className="subagent-note">{t('activity.subagentNone')}</p>}
    {entry && <SubagentDetail entry={entry} now={now} reading={reading} {...props} loadEarlier={loadEarlier} retry={() => setAttempt(n => n + 1)} />}
  </aside>;
}

function SubagentDetail({ entry, now, reading, workspace, sessionId, replyDetail, openArtifact, loadEarlier, retry }: Props & {
  entry: SubagentEntry; now: number; reading?: Reading; loadEarlier(cursor: string): Promise<void>; retry(): void;
}) {
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
