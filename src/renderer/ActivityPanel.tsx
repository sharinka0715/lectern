import { useEffect, useState } from 'react';
import { Bot, Check, ChevronDown, ChevronsDownUp, CircleAlert, Copy, MessagesSquare, Radio, Square, Terminal, TextSelect } from 'lucide-react';
import { copyWithToast, showContextMenu } from './ContextMenu';
import { selectionWithin } from './message-menus';
import { runningMs, type SessionActivity } from '../shared/activity';
import { ShellCode } from './ShellCode';
import './activity.css';
import { localeTag, t } from '../shared/i18n';

const labels = { agent: 'activity.panelAgent', shell: 'activity.panelShell', monitor: 'activity.panelMonitor' } as const;
const states = { running: 'activity.stateRunning', completed: 'activity.stateCompleted', failed: 'activity.stateFailed', stopped: 'activity.stateStopped', unobserved: 'activity.stateUnobserved' } as const;
const icons = { shell: Terminal, agent: Bot, monitor: Radio };
function time(value?: string) {
  return value ? new Date(value).toLocaleTimeString(localeTag(), { hour12: false }) : undefined;
}
function elapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds >= 60 ? t('activity.minutesSeconds', { m: Math.floor(seconds / 60), s: seconds % 60 }) : t('activity.seconds', { s: seconds });
}
/** One subagent, shell or monitor; the floating activity card lists them per kind.
 * A subagent's `onOpen` shows its conversation in the pane's subagent column. */
export function ActivityCard({ item, now, expand = item.status === 'running', onOpen }: { item: SessionActivity; now: number; expand?: boolean; onOpen?: () => void }) {
  const [expanded, setExpanded] = useState(expand);
  const Icon = icons[item.kind];
  const statusIcon = item.status === 'completed' ? <Check size={12} /> : item.status === 'failed' ? <CircleAlert size={12} />
    : item.status === 'stopped' ? <Square size={10} /> : <i />;
  const description = [item.background ? t('activity.background') : '', item.agentType, item.startedAt && time(item.startedAt),
    item.resumes ? t('activity.resumedCount', { count: item.resumes }) : ''].filter(Boolean).join(' · ');
  // Running time across the launch and every resume, without the pauses between them.
  const ran = runningMs(item, now);
  return <article className="activity-card" data-activity-id={item.id} data-activity-state={item.status} data-activity-kind={item.kind}
    onContextMenu={event => {
      const selected = selectionWithin(event.currentTarget).trim();
      showContextMenu(event, [
        !!selected && { label: t('activity.copySelection'), icon: <TextSelect size={14} />, onSelect: () => copyWithToast(selected) },
        !!onOpen && { label: t('activity.viewConversation'), icon: <MessagesSquare size={14} />, onSelect: onOpen },
        { label: t(expanded ? 'activity.collapseDetails' : 'activity.expandDetails'), icon: <ChevronsDownUp size={14} />, onSelect: () => setExpanded(!expanded) },
        'separator',
        { label: t('activity.copyTitle'), icon: <Copy size={14} />, onSelect: () => copyWithToast(item.title) },
        !!item.command && { label: t('activity.copyCommand'), icon: <Copy size={14} />, onSelect: () => copyWithToast(item.command!) },
        !!item.prompt && { label: t('activity.copyPrompt'), icon: <Copy size={14} />, onSelect: () => copyWithToast(item.prompt!) },
        !!item.output && { label: t('activity.copyOutput'), icon: <Copy size={14} />, onSelect: () => copyWithToast(item.output!) },
        !!item.summary && { label: t('activity.copyResult'), icon: <Copy size={14} />, onSelect: () => copyWithToast(item.summary!) },
      ], item.title);
    }}>
    <button type="button" className="activity-card-heading" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <span className="activity-type-icon"><Icon size={17} /></span>
      <span className="activity-title"><small>{t(labels[item.kind])}</small><strong>{item.title}</strong></span>
      <ChevronDown size={14} className={'activity-chevron' + (expanded ? ' open' : '')} />
    </button>
    <div className="activity-card-subhead"><span className="activity-state">{statusIcon}{t(states[item.status])}</span><span>{description}</span>
      {onOpen && <button type="button" className="activity-open-conversation" title={t('activity.viewConversationTitle', { title: item.title })} onClick={onOpen}>
        <MessagesSquare size={12} aria-hidden="true" />{t('activity.viewConversation')}</button>}</div>
    {expanded && <div className="activity-detail">
      {item.command && <ShellCode className="activity-command" text={item.command} />}
      {item.prompt && <p className="activity-prompt">{item.prompt}</p>}
      <dl className="activity-facts">
        {item.model && <><dt>{t('activity.model')}</dt><dd>{item.model}</dd></>}
        {ran !== undefined && <><dt>{t('activity.elapsed')}</dt><dd>{elapsed(ran)}</dd></>}
        {item.resumedAt && <><dt>{t('activity.lastResumed')}</dt><dd>{time(item.resumedAt)}</dd></>}
        {item.timeoutMs !== undefined && <><dt>{t('activity.timeout')}</dt><dd>{item.timeoutMs ? t('activity.seconds', { s: item.timeoutMs / 1000 }) : t('activity.keepsWatching')}</dd></>}
        {item.exitCode !== undefined && <><dt>{t('activity.exitCode')}</dt><dd>{item.exitCode}</dd></>}
        {item.toolUses !== undefined && <><dt>{t('activity.toolUses')}</dt><dd>{t('activity.times', { count: item.toolUses })}</dd></>}
        {item.tokens !== undefined && <><dt>Token</dt><dd>{item.tokens.toLocaleString()}</dd></>}
        {item.taskId && <><dt>{t('activity.taskId')}</dt><dd><code>{item.taskId}</code></dd></>}
      </dl>
      {!!item.events.length && <ol className="activity-events" aria-label={t('activity.recentEvents')}>{item.events.map(event =>
        <li key={event.key}>{event.at && <time dateTime={event.at}>{time(event.at)}</time>}<span>{event.text}</span></li>)}</ol>}
      {item.output && <div className="activity-output"><h4>{t('activity.recentOutput')}</h4><pre>{item.output}</pre></div>}
      {item.summary && <p className="activity-result">{item.summary}</p>}
    </div>}
  </article>;
}
