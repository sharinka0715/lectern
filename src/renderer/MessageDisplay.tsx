import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from './i18n';
import type { LiveShell } from "../shared/activity";
import { useArtifactScope } from "./ArtifactReferenceScope";
import { showContextMenu } from "./ContextMenu";
import { messageMenu, toolMenu } from "./message-menus";
import { ArtifactMarkdown, FileLink, LinkedToolText, LinkedUserText } from "./ArtifactLinks";
import { pathBasename } from "./artifact-paths";
import { AttachmentImage } from './ChatImage';
import { AttachmentChipView, MessageAttachmentCards } from './AttachmentCards';
import { isAttachedPath } from './attachment-registry';
import { messageAttachmentLayout } from '../shared/attachments';
import { activityExcerpt, replyParts, summarizeActivities, toolDisplayState, type Activity, type LineChanges, type ToolActivity } from './reply-activities';
import './reply-activities.css';
import { EditDiff } from "./EditDiff";
import { ToolInput } from "./ToolInput";
import { Check, ChevronRight, Copy, CornerDownLeft, Mail, Paperclip, SquareTerminal, Terminal } from "lucide-react";
import type { ChatMessage, MessageAttachment, PeerMessage } from "../shared/types";
import { reportActionError } from "./diagnostics";
import type { ReplyDetail } from "./desktop-state";
import { t } from '../shared/i18n';

type OpenPath = (path: string) => void;

/** Foreground shells still running, keyed by tool_use id (App supplies them). */
export const LiveShells = createContext<ReadonlyMap<string, LiveShell>>(new Map());
function elapsedText(startedAt: string | undefined, now: number) {
  const seconds = startedAt ? Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000)) : NaN;
  return !Number.isFinite(seconds) ? '' : seconds >= 60 ? t('chat.minutesSeconds', { m: Math.floor(seconds / 60), s: seconds % 60 }) : t('chat.seconds', { s: seconds });
}
/** A running foreground command under its tool row, as Claude Code shows it:
 * the command, its elapsed time, and the latest output when one was sampled. */
function LiveShellOutput({ toolId, withCommand }: { toolId: string; withCommand?: boolean }) {
  const shell = useContext(LiveShells).get(toolId);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!shell) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [shell]);
  if (!shell) return null;
  const lines = shell.output?.replace(/\s+$/, '').split('\n') ?? [];
  const elapsed = elapsedText(shell.startedAt, now);
  return <div className="tool-live" data-live-tool={toolId} data-live-state={shell.waiting ? 'waiting' : 'running'} role="status" aria-label={t(shell.waiting ? 'chat.foregroundWaiting' : 'chat.foregroundRunning')}>
    <span className="tool-live-heading">{!shell.waiting && <span className="pulse-dot" aria-hidden="true" />}{t(shell.waiting ? 'chat.waitingConfirm' : 'chat.running')}{shell.title && <span className="tool-live-title">{shell.title}</span>}
      {withCommand && shell.command && <code>{activityExcerpt(shell.command.split('\n')[0])}</code>}
      {(elapsed || shell.lines !== undefined) && <span>{[elapsed, shell.lines !== undefined && t('chat.outputLines', { count: shell.lines })].filter(Boolean).join(' · ')}</span>}</span>
    {!!lines.length && <pre className="tool-live-output">{lines.length > 8 && <span className="tool-live-more">{t('chat.earlierLines', { count: lines.length - 8 })}</span>}{lines.slice(-8).join('\n')}</pre>}
  </div>;
}

function ChangeCount({ changes, partial }: { changes?: LineChanges; partial?: boolean }) {
  if (!changes || !changes.added && !changes.removed) return null;
  return <span className="activity-changes" title={t(partial ? 'chat.partialChanges' : 'chat.appliedLines')}>
    {partial && <span>{t('chat.known')}</span>}
    {!!changes.added && <span className="activity-added">+{changes.added}</span>}
    {!!changes.removed && <span className="activity-removed">−{changes.removed}</span>}
  </span>;
}

function ToolCall({ row, compact, onOpenPath, grouped = false }: { row: ToolActivity; compact: boolean; onOpenPath: OpenPath; grouped?: boolean }) {
  const [open, setOpen] = useState(false);
  const details = useRef<HTMLDetailsElement>(null);
  const scope = useArtifactScope();
  const { tool, file, subject, changes } = row;
  const state = toolDisplayState(tool);
  const stateLabel = t(({ error: 'chat.stateError', pending: 'chat.statePending', completed: 'chat.stateCompleted', discussion: 'chat.stateDiscussion', cancelled: 'chat.stateCancelled' } as const)[state]);
  const showDiff = row.category === 'write' && (tool.name !== 'Write' || !!tool.editPatch);
  return <><details ref={details} className={`tool-block${compact ? ' activity-row' : ''}`} data-tool-id={tool.id} data-tool-name={tool.name} data-tool-state={state}
    onToggle={event => setOpen(event.currentTarget.open)}
    onContextMenu={event => showContextMenu(event, toolMenu(event, tool, { file, open, toggle: () => { if (details.current) details.current.open = !details.current.open; },
      onOpenPath, workspaceId: scope?.workspaceId }), tool.name)}>
    <summary title={tool.name}>
      {!compact && <Terminal size={14} />}
      <span className="activity-verb">{compact ? row.verb : tool.name}</span>
      {file && <span className="activity-subject" title={file}><FileLink path={file} onOpen={onOpenPath}>{pathBasename(file)}</FileLink></span>}
      {subject && <span className="activity-subject">{activityExcerpt(subject)}</span>}
      <ChangeCount changes={changes} />
      {(!compact || state !== 'completed') && <span className="tool-state">{stateLabel}</span>}
      <ChevronRight size={13} aria-hidden="true" />
    </summary>
    {open && <div className="tool-detail">
      {showDiff ? <EditDiff tool={tool} onOpenPath={onOpenPath} /> : <ToolInput tool={tool} onOpen={onOpenPath} />}
      {tool.result !== undefined && tool.result.trim() !== '' && <div className="tool-output" data-error={tool.isError || undefined}>
        <div className="tool-detail-label">{t(tool.isError ? 'chat.error' : 'chat.result')}</div><LinkedToolText text={tool.result} onOpen={onOpenPath} />
      </div>}
    </div>}
  </details>{state === 'pending' && !grouped && <LiveShellOutput toolId={tool.id} />}</>;
}

function TaskNotification({ text, onOpenPath }: { text: string; onOpenPath: OpenPath }) {
  const [open, setOpen] = useState(false);
  const headline = text.trimStart().split('\n', 1)[0];
  return <details className="tool-block activity-row task-notice" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span className="activity-verb">{t('chat.taskNotice')}</span><span className="activity-subject">{activityExcerpt(headline)}</span><ChevronRight size={13} aria-hidden="true" /></summary>
    {open && <div className="task-notice-content"><LinkedToolText text={text} onOpen={onOpenPath} /></div>}
  </details>;
}

function PeerDelivery({ peer, compact }: { peer: PeerMessage; compact: boolean }) {
  const label = t(({ agent: 'chat.peerAgent', handback: 'chat.peerHandback', session: 'chat.peerSession', coordinator: 'chat.peerCoordinator' } as const)[peer.source]);
  const notice = peer.unverified && <span className="peer-unverified">{t('chat.unverifiedSource')}</span>;
  if (!compact) return <aside className="peer-delivery" data-peer-source={peer.source} data-peer-id={peer.id}>
    <header><Mail size={14} />{label}{peer.sender && <strong>{peer.sender}</strong>}{notice}</header>
    <div>{peer.text}</div>
  </aside>;
  return <details className="tool-block activity-row" data-peer-source={peer.source} data-peer-id={peer.id}>
    <summary><span className="activity-verb">{label}</span><span className="activity-subject">{peer.sender || activityExcerpt(peer.text)}</span>{notice}<ChevronRight size={13} aria-hidden="true" /></summary>
    <div className="tool-detail activity-peer-body">{peer.text}</div>
  </details>;
}

/** Reasoning folded as in Claude Code ("Thought for Ns"); the text opens on demand. */
function ThoughtRow({ row, onOpenPath }: { row: ToolActivity; onOpenPath: OpenPath }) {
  const [open, setOpen] = useState(false);
  return <details className="tool-block activity-row thought-row" data-tool-id={row.tool.id} data-thought
    onToggle={event => setOpen(event.currentTarget.open)}>
    <summary title={t('chat.thinkingTitle')}><span className="activity-verb">{t('chat.verbThink')}</span>
      {row.subject && <span className="activity-subject">{row.subject}</span>}<ChevronRight size={13} aria-hidden="true" /></summary>
    {open && <div className="tool-detail thought-text"><div className="markdown"><ArtifactMarkdown onOpen={onOpenPath} text={row.tool.result ?? ''} /></div></div>}
  </details>;
}

function ActivityRow({ row, compact, onOpenPath, grouped }: { row: Activity; compact: boolean; onOpenPath: OpenPath; grouped?: boolean }) {
  if (row.kind === 'tool' && row.category === 'thought') return <ThoughtRow row={row} onOpenPath={onOpenPath} />;
  return row.kind === 'tool' ? <ToolCall row={row} compact={compact} onOpenPath={onOpenPath} grouped={grouped} /> : <PeerDelivery peer={row.peer} compact={compact} />;
}

function ActivityGroup({ rows, onOpenPath }: { rows: Activity[]; onOpenPath: OpenPath }) {
  const { labels, pending, failed, changes, partialChanges } = summarizeActivities(rows);
  const label = labels.join(t('sidebar.ariaJoin'));
  const status = [failed && t('chat.failedCount', { count: failed }), pending && t('chat.pendingCount', { count: pending })].filter(Boolean).join(' · ');
  // A running foreground command stays visible below the collapsed summary.
  return <><details className="tool-block tool-group activity-group" data-tool-state={failed ? 'error' : pending ? 'pending' : 'completed'}>
    <summary><span className="activity-label" title={label}>{label}</span>{status && <span className="tool-state">{status}</span>}
      <ChangeCount changes={changes} partial={partialChanges} /><ChevronRight size={13} aria-hidden="true" /></summary>
    <div className="activity-rows">{rows.map(row => <ActivityRow key={row.key} row={row} compact onOpenPath={onOpenPath} grouped />)}</div>
  </details>{rows.map(row => row.kind === 'tool' && toolDisplayState(row.tool) === 'pending' && <LiveShellOutput key={row.key} toolId={row.tool.id} withCommand />)}</>;
}

type ReplyProps = { message: ChatMessage; replyDetail: ReplyDetail; onOpenPath: OpenPath; onOpenAttachment: (attachment: MessageAttachment) => void };

function ReplyContent({ message, replyDetail, onOpenPath, onOpenAttachment }: ReplyProps) {
  const compact = replyDetail === 'compact';
  // Activity verbs and summaries are written in the current language.
  const locale = useLocale();
  // A user message shows each attached file once: cards above the text, chips for files named inside it.
  const layout = useMemo(() => message.role === 'user' ? messageAttachmentLayout(message.text, message.attachments ?? [], isAttachedPath) : undefined,
    [message.role, message.text, message.attachments]);
  const shown = useMemo(() => layout ? { ...message, text: layout.text, attachments: message.attachments?.filter(file => file.image && !file.path) } : message,
    [message, layout]);
  const parts = useMemo(() => replyParts(shown, compact), [shown, compact, locale]);
  if (!parts.length && message.status === 'streaming') return <div className="markdown">{t('chat.waitingClaude')}</div>;
  let offset = 0;
  const content = parts.map(part => {
    if (part.kind === 'image') return <AttachmentImage key={part.key} attachment={part.attachment} onOpen={onOpenAttachment} />;
    if (part.kind === 'text' && layout) {
      const start = offset, end = offset += part.text.length;
      const chips = layout.chips.filter(chip => chip.start >= start && chip.end <= end).map(chip => ({ start: chip.start - start, end: chip.end - start,
        node: <AttachmentChipView chip={chip} onOpenPath={onOpenPath} onOpenAttachment={onOpenAttachment} /> }));
      return <div key={part.key} className="user-text"><LinkedUserText text={part.text} chips={chips} onOpen={onOpenPath} /></div>;
    }
    if (part.kind === 'text') return <div key={part.key} className="markdown"><ArtifactMarkdown onOpen={onOpenPath} text={part.text} inlineImages /></div>;
    return part.rows.length === 1 ? <ActivityRow key={part.key} row={part.rows[0]} compact={compact} onOpenPath={onOpenPath} />
      : <ActivityGroup key={part.key} rows={part.rows} onOpenPath={onOpenPath} />;
  });
  if (!layout?.cards.length) return content;
  return <><MessageAttachmentCards cards={layout.cards} onOpenPath={onOpenPath} onOpenAttachment={onOpenAttachment} />{content}</>;
}

export function MessageDisplay({ message, replyDetail, onOpenPath, onOpenAttachment, onRewind, onQuote }: ReplyProps & {
  onRewind?: (uuid: string) => void;
  onQuote?: (text: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const scope = useArtifactScope();
  const isUser = message.role === "user";
  // A user message's files are cards above its text (ReplyContent).
  const files = isUser ? undefined : message.attachments?.filter(ref => !ref.image);
  async function copy() {
    try {
      await window.desktop.copyText(message.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (error) {
      reportActionError(error, "复制回复失败");
      /* The selectable text remains available when clipboard access is unavailable. */
    }
  }
  return (
    <article
      className={`message message-${message.role}`}
      data-message-id={message.id}
      data-source={message.source}
      data-role={message.role}
      onContextMenu={event => showContextMenu(event, messageMenu(event, message, { workspaceId: scope?.workspaceId, onOpenPath, onRewind, onQuote }), t('chat.messageActions'))}
    >
      {!isUser && (
        <div className="message-heading">
          <span className="assistant-symbol" aria-hidden="true">
            <SquareTerminal size={17} strokeWidth={1.7} />
          </span>
          <strong>
            {message.peerMessages?.length && !message.text && !message.tools.length ? t('chat.peerConversation') : message.role === 'assistant' ? 'Claude' : t('chat.sessionNotice')}
          </strong>
          {message.source === "preview" && (
            <span className="preview-label">
              <span className="mini-dot" />
              {t('chat.livePreview')}
            </span>
          )}
        </div>
      )}
      <div className="message-content">
        <ReplyContent message={message} replyDetail={replyDetail} onOpenPath={onOpenPath} onOpenAttachment={onOpenAttachment} />
        {message.interrupted && <p className="message-interrupted">{t('chat.interrupted')}</p>}
        {message.taskNotifications?.map(notice => <TaskNotification key={notice.id} text={notice.text} onOpenPath={onOpenPath} />)}
        {!!files?.length && <div className="artifact-attachments">
          {files.map(ref => ref.path
            ? <FileLink key={ref.id} path={ref.path} onOpen={onOpenPath} explicit><Paperclip size={13} />{ref.name}</FileLink>
            : <button type="button" key={ref.id} className="artifact-link" title={t('chat.openFile', { name: ref.name })}
              onClick={() => onOpenAttachment(ref)}><Paperclip size={13} />{ref.name}</button>)}
        </div>}
      </div>
      {isUser && onRewind && message.rewindUuid && <button type="button" className="message-rewind" title={t('chat.rewindHereTitle')}
        onClick={() => onRewind(message.rewindUuid!)}><CornerDownLeft size={13}/>{t('chat.rewindHere')}</button>}
      {!isUser && message.text && (
        <div className="message-footer">
          {message.status === "streaming" && (
            <span className="stream-label">
              <span className="pulse-dot" />
              {t('chat.replying')}
            </span>
          )}
          <button
            className="icon-button copy-button"
            onClick={copy}
            title={t('chat.copyReply')}
            aria-label={t('chat.copyReply')}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
      )}
    </article>
  );
}
