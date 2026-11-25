import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, ListChecks, Radio, Terminal, X } from 'lucide-react';
import type { ActivityKind, SessionActivity } from '../shared/activity';
import type { ChatView, Workspace } from '../shared/types';
import type { ArtifactTarget } from './ArtifactDrawer';
import type { ReplyDetail } from './desktop-state';
import { Tally } from './ActivityPanel';
import { reportActionError } from './diagnostics';
import { states, SubagentDetail, useSubagentFiles } from './SubagentDetail';
import { shownTask, TASK_KINDS, taskEntries } from './task-entries';
import { TaskOutputDetail } from './TaskOutputDetail';
import { t } from '../shared/i18n';
import './task-column.css';

const groupLabels = { agent: 'activity.kindAgent', shell: 'activity.kindShell', monitor: 'activity.kindMonitor' } as const;
const groupIcons = { agent: Bot, shell: Terminal, monitor: Radio } as const;

interface Props {
  workspace: Workspace;
  sessionId: string;
  view: ChatView;
  /** The activity card's subagents, background shells and monitors. */
  items: SessionActivity[];
  /** Claude Code 2.1.310+: `items` has every subagent of the session (core/subagent-status.ts), so their files need no listing. */
  listed?: boolean;
  selected?: string;
  /** The kind the card asked for when it opened the column without naming an entry. */
  kind?: ActivityKind;
  /** Changes when the activity card asks to show (and focus) an entry. */
  focusToken: number;
  replyDetail: ReplyDetail;
  showThinkingAsText: boolean;
  sizeMiB: number;
  onSelect(key: string): void;
  onClose(): void;
  openArtifact(target: ArtifactTarget): void;
}

/**
 * The task column on the right of a pane: the conversation's subagents, background
 * shells and monitors by kind, and the selected one in detail: a subagent's own
 * conversation, or a shell's or monitor's command and output, updated while it runs.
 */
export function TaskColumn(props: Props) {
  const { workspace, sessionId, view, items } = props;
  const agents = useMemo(() => items.filter(item => item.kind === 'agent'), [items]);
  const agentsKey = agents.map(item => `${item.id}:${item.taskId ?? ''}:${item.status}:${item.resumes ?? 0}`).join(',');
  const files = useSubagentFiles(workspace.id, sessionId, agentsKey, agents.some(item => item.status === 'running' && !item.taskId), !props.listed);
  const groups = useMemo(() => taskEntries(items, files), [items, files]);
  // The one shown stays shown when others start or end, and a subagent keeps its place
  // when loading older history gives it the activity card's key.
  const shownAgent = useRef<string | undefined>(undefined);
  const entry = shownTask(groups, props.selected, shownAgent.current, props.kind);
  useEffect(() => { shownAgent.current = entry?.agent?.agentId; });
  const { onSelect } = props;
  useEffect(() => { if (entry && entry.key !== props.selected) onSelect(entry.key); }, [entry?.key, props.selected, onSelect]); // eslint-disable-line react-hooks/exhaustive-deps
  const [now, setNow] = useState(Date.now);
  const running = items.some(item => item.status === 'running');
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  // The pane's readers keep the last few subagents and outputs until the column closes.
  useEffect(() => () => {
    void window.desktop.releaseSubagents(workspace.id, sessionId, view).catch(error => reportActionError(error, '释放子代理对话失败'));
    void window.desktop.releaseTaskOutputs(workspace.id, sessionId, view).catch(error => reportActionError(error, '释放后台任务输出失败'));
  }, [workspace.id, sessionId, view]);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!props.focusToken) return;
    const row = list.current?.querySelector<HTMLButtonElement>('[aria-current="true"]') ?? list.current?.querySelector('button');
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: 'nearest' });
  }, [props.focusToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const listed = TASK_KINDS.filter(kind => groups[kind].length);
  return <aside className="task-column" aria-label={t('activity.taskColumn')} data-task-column>
    <header className="task-column-bar">
      <ListChecks size={15} aria-hidden="true" /><span className="task-column-title">{t('activity.taskColumn')}</span>
      {!!items.length && <Tally items={items} align="start" />}
      <button type="button" className="icon-button" aria-label={t('activity.closeTaskColumn')} title={t('activity.closeTaskColumn')} onClick={props.onClose}><X size={15} /></button>
    </header>
    {listed.length ? <div ref={list} className="task-column-list" aria-label={t('activity.taskList')}>
      {listed.map(kind => {
        const Icon = groupIcons[kind];
        return <section key={kind} className="task-group" data-kind={kind} aria-label={t(groupLabels[kind])}>
          <h3><Icon size={12} aria-hidden="true" /><span className="task-group-label">{t(groupLabels[kind])}</span><Tally items={groups[kind]} /></h3>
          <ul>{groups[kind].map(row => <li key={row.key}>
            <button type="button" aria-current={row.key === entry?.key} data-task-key={row.key} data-kind={kind} data-agent-id={row.agent?.agentId} data-state={row.status}
              title={row.note ? `${row.title}\n${row.note}` : row.title} onClick={() => props.onSelect(row.key)}>
              <span className="task-dot" data-state={row.status} aria-hidden="true" />
              <span className="task-name">{row.title}{row.note && <small>{row.note}</small>}</span>
              <span className="task-state">{row.item ? t(states[row.status]) : row.status === 'completed' ? t(states.completed) : t('activity.subagentEarlier')}</span>
            </button>
          </li>)}</ul>
        </section>;
      })}
    </div> : <p className="subagent-note">{t('activity.taskNone')}</p>}
    {entry?.agent && <SubagentDetail entry={entry.agent} now={now} workspace={workspace} sessionId={sessionId} view={view} replyDetail={props.replyDetail}
      showThinkingAsText={props.showThinkingAsText} sizeMiB={props.sizeMiB} openArtifact={props.openArtifact} />}
    {entry?.item && entry.kind !== 'agent' && <TaskOutputDetail key={entry.key} item={entry.item} now={now} workspace={workspace} sessionId={sessionId} view={view}
      openArtifact={props.openArtifact} />}
  </aside>;
}
