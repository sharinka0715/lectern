import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from './i18n';
import type { LiveShell } from "../shared/activity";
import { ReplyCwd, useArtifactResolutions, useArtifactScope } from "./ArtifactReferenceScope";
import { showContextMenu } from "./ContextMenu";
import { messageMenu, toolMenu } from "./message-menus";
import { ArtifactMarkdown, FileLink, LinkedToolText, LinkedUserText } from "./ArtifactLinks";
import { isRelativePath, pathBasename, pathFromCwd, type OpenPath } from "./artifact-paths";
import { AttachmentImage } from './ChatImage';
import { MessageAttachmentCards, MessageFileChip } from './AttachmentCards';
import { confirmFile, isAttachedPath, isChipPath } from './attachment-registry';
import { confirmsMention, messageFileLayout, samePath } from '../shared/attachments';
import { mentionCandidates } from './composer-chips';
import { activityExcerpt, replyMarkdown, replyParts, summarizeActivities, toolDisplayState, type Activity, type LineChanges, type ReplyPart, type ToolActivity } from './reply-activities';
import './reply-activities.css';
import { EditDiff } from "./EditDiff";
import { ToolInput } from "./ToolInput";
import { Check, ChevronRight, Copy, CornerDownLeft, Mail, Paperclip, SquareTerminal, Terminal } from "lucide-react";
import type { ChatMessage, GoalEvent, MessageAttachment, PeerMessage } from "../shared/types";
import { reportActionError } from "./diagnostics";
import type { ReplyDetail } from "./desktop-state";
import { formatNumber, t } from '../shared/i18n';
import { goalDurationText } from './GoalStatus';
import { TurnTimingLabel } from './TurnTiming';


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
  const stateLabel = t(({ error: 'chat.stateError', pending: 'chat.statePending', completed: 'chat.stateCompleted', discussion: 'chat.stateDiscussion', cancelled: 'chat.stateCancelled',
    interrupted: 'chat.stateInterrupted', incomplete: 'chat.stateIncomplete' } as const)[state]);
  const showDiff = row.category === 'write' && (tool.name !== 'Write' || !!tool.editPatch);
  // Paths in the call are from the directory it was made in; in its result, from where the command left it.
  const menuFile = file && tool.cwd?.startsWith('/') ? pathFromCwd(tool.cwd, file) : file;
  return <ReplyCwd cwd={tool.cwd}><details ref={details} className={`tool-block${compact ? ' activity-row' : ''}`} data-tool-id={tool.id} data-tool-name={tool.name} data-tool-state={state}
    onToggle={event => setOpen(event.currentTarget.open)}
    onContextMenu={event => showContextMenu(event, toolMenu(event, tool, { file: menuFile, open, toggle: () => { if (details.current) details.current.open = !details.current.open; },
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
        <div className="tool-detail-label">{t(tool.isError ? 'chat.error' : 'chat.result')}</div>
        <ReplyCwd cwd={tool.resultCwd ?? tool.cwd}><LinkedToolText text={tool.result} onOpen={onOpenPath} /></ReplyCwd>
      </div>}
    </div>}
  </details>{state === 'pending' && !grouped && <LiveShellOutput toolId={tool.id} />}</ReplyCwd>;
}

function TaskNotification({ text, onOpenPath }: { text: string; onOpenPath: OpenPath }) {
  const [open, setOpen] = useState(false);
  const headline = text.trimStart().split('\n', 1)[0];
  return <details className="tool-block activity-row task-notice" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span className="activity-verb">{t('chat.taskNotice')}</span><span className="activity-subject">{activityExcerpt(headline)}</span><ChevronRight size={13} aria-hidden="true" /></summary>
    {open && <div className="task-notice-content"><LinkedToolText text={text} onOpen={onOpenPath} /></div>}
  </details>;
}

const goalVerbs = { set: 'chat.goalSet', 'not-met': 'chat.goalNotMet', met: 'chat.goalMet', failed: 'chat.goalFailed', cleared: 'chat.goalCleared',
  paused: 'chat.goalPaused', retry: 'chat.goalRetry', checkin: 'chat.goalCheckin' } as const;
function checkinText(goal: GoalEvent) {
  const summary = goal.notice ?? '';
  const text = t(/no longer running/u.test(summary) ? 'chat.goalCheckinStopped' : /continuing after/u.test(summary) ? 'chat.goalCheckinRetry' : 'chat.goalCheckinRunning');
  return goal.minutes !== undefined && !/continuing after/u.test(summary) ? `${text} · ${t('chat.goalCheckinFor', { minutes: goal.minutes })}` : text;
}
/** Claude Code's native /goal in the chat (core/goal-records.ts): set, each check, the end, Claude Code's
 * own notices and check-ins, as rows like a background task's notice that open to the details. */
function GoalNotice({ goal }: { goal: GoalEvent }) {
  const [open, setOpen] = useState(false);
  const verb = goal.kind === 'not-met' && (goal.count ?? 1) > 1 ? t('chat.goalNotMetTimes', { count: goal.count! }) : t(goalVerbs[goal.kind]);
  const stats = goal.kind === 'met' || goal.kind === 'failed' ? [goal.durationMs !== undefined && goalDurationText(goal.durationMs),
    goal.iterations !== undefined && t('telemetry.goalTurns', { n: goal.iterations }), goal.tokens !== undefined && t('telemetry.goalTokens', { tokens: formatNumber(goal.tokens) })].filter(Boolean).join(' · ') : '';
  const subject = goal.kind === 'set' || goal.kind === 'cleared' && !goal.notice ? goal.condition : goal.kind === 'checkin' ? checkinText(goal)
    : goal.kind === 'met' ? stats || goal.reason : goal.kind === 'paused' || goal.kind === 'retry' || goal.kind === 'cleared' ? goal.notice : goal.reason ?? goal.condition;
  const reasons = goal.reasons ?? (goal.reason !== undefined ? [goal.reason] : []);
  return <details className="tool-block activity-row task-notice goal-notice" data-goal-event={goal.kind} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span className="activity-verb">{verb}</span>{subject && <span className="activity-subject">{activityExcerpt(subject)}</span>}<ChevronRight size={13} aria-hidden="true" /></summary>
    {open && <div className="task-notice-content goal-notice-content">
      {goal.condition && <p>{t('chat.goalCondition', { condition: goal.condition })}</p>}
      {goal.kind === 'not-met' && reasons.length > 1 ? <ol>{reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ol>
        : reasons.length > 0 && <p>{t('chat.goalReason', { reason: reasons[0] })}</p>}
      {stats && goal.kind === 'failed' && <p>{stats}</p>}
      {goal.notice && <p lang="en">{t('chat.goalNative', { notice: goal.notice })}</p>}
      {!!goal.tasks?.length && <><p>{t('chat.goalTasks')}</p><ul>{goal.tasks.map((task, i) => <li key={i}><code>{task}</code></li>)}</ul></>}
    </div>}
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
    {open && <div className="tool-detail thought-text"><div className="markdown"><ReplyCwd cwd={row.tool.cwd}><ArtifactMarkdown onOpen={onOpenPath} text={row.tool.result ?? ''} /></ReplyCwd></div></div>}
  </details>;
}

function ActivityRow({ row, compact, onOpenPath, grouped }: { row: Activity; compact: boolean; onOpenPath: OpenPath; grouped?: boolean }) {
  if (row.kind === 'tool' && row.category === 'thought') return <ThoughtRow row={row} onOpenPath={onOpenPath} />;
  return row.kind === 'tool' ? <ToolCall row={row} compact={compact} onOpenPath={onOpenPath} grouped={grouped} /> : <PeerDelivery peer={row.peer} compact={compact} />;
}

function ActivityGroup({ rows, onOpenPath }: { rows: Activity[]; onOpenPath: OpenPath }) {
  const { labels, pending, failed, interrupted, incomplete, changes, partialChanges } = summarizeActivities(rows);
  const label = labels.join(t('sidebar.ariaJoin'));
  const status = [failed && t('chat.failedCount', { count: failed }), pending && t('chat.pendingCount', { count: pending }),
    interrupted && t('chat.interruptedCount', { count: interrupted }), incomplete && t('chat.incompleteCount', { count: incomplete })].filter(Boolean).join(' · ');
  // A running foreground command stays visible below the collapsed summary.
  return <><details className="tool-block tool-group activity-group"
    data-tool-state={failed ? 'error' : pending ? 'pending' : interrupted ? 'interrupted' : incomplete ? 'incomplete' : 'completed'}>
    <summary><span className="activity-label" title={label}>{label}</span>{status && <span className="tool-state">{status}</span>}
      <ChangeCount changes={changes} partial={partialChanges} /><ChevronRight size={13} aria-hidden="true" /></summary>
    <div className="activity-rows">{rows.map(row => <ActivityRow key={row.key} row={row} compact onOpenPath={onOpenPath} grouped />)}</div>
  </details>{rows.map(row => row.kind === 'tool' && toolDisplayState(row.tool) === 'pending' && <LiveShellOutput key={row.key} toolId={row.tool.id} withCommand />)}</>;
}

type ReplyProps = { message: ChatMessage; onOpenPath: OpenPath; onOpenAttachment: (attachment: MessageAttachment) => void };

function ReplyContent({ message, parts, compact, onOpenPath, onOpenAttachment }: ReplyProps & { parts: ReplyPart[]; compact: boolean }) {
  // A user message shows the files its @-mentions name as chips in their place, like the input box,
  // with its images (and attached files it does not name) in a row above the text. A mention
  // counts when the transcript recorded the file, Lectern attached or knows it, or the reference
  // check finds that very file. Claude Code read a relative mention from its directory then (the
  // prompt's cwd): the file recorded or found there comes first, then the folder's.
  const user = message.role === 'user', workspaceId = useArtifactScope()?.workspaceId;
  const cwd = user ? message.cwds?.[0]?.cwd : undefined;
  const located = useCallback((path: string) => cwd?.startsWith('/') && isRelativePath(path) ? pathFromCwd(cwd, path) : undefined, [cwd]);
  const candidates = useMemo(() => {
    if (!user) return [];
    const files = (message.attachments ?? []).flatMap(file => file.path ? [file.path] : []);
    const attached = (path: string, at = located(path)) => files.some(file => samePath(file, path) || !!at && samePath(file, at));
    const fromCwd = mentionCandidates(message.text, path => !located(path) || attached(path)).map(path => located(path)!);
    return [...fromCwd, ...mentionCandidates(message.text, path => isChipPath(workspaceId, path) || attached(path))];
  }, [user, message.text, message.attachments, workspaceId, located]);
  const found = useArtifactResolutions(candidates);
  const layout = useMemo(() => user ? messageFileLayout(message.text, message.attachments ?? [], path => {
    const at = located(path);
    // Until the check answers, a file there might still come first.
    if (at && !found) return false;
    return at && confirmsMention(at, found?.get(at)) ? at : isChipPath(workspaceId, path) || confirmsMention(path, found?.get(path));
  }, located) : undefined, [user, message.text, message.attachments, workspaceId, found, located]);
  // Their mentions pasted into the input box are chips there too.
  useEffect(() => { if (workspaceId) for (const chip of layout?.chips ?? []) if (!isAttachedPath(chip.path)) confirmFile(workspaceId, chip.path); }, [layout, workspaceId]);
  // A stand-in: the reply's first block that replaces it fades in (content-fade.ts).
  if (!parts.length && message.status === 'streaming') return <div className="markdown" data-fade-placeholder>{t('chat.waitingClaude')}</div>;
  let offset = 0;
  const content = parts.map(part => {
    if (part.kind === 'image') return <AttachmentImage key={part.key} attachment={part.attachment} onOpen={onOpenAttachment} />;
    if (part.kind === 'notice') return part.notice.goal ? <GoalNotice key={part.key} goal={part.notice.goal} />
      : <TaskNotification key={part.key} text={part.notice.text} onOpenPath={onOpenPath} />;
    if (part.kind === 'text' && layout) {
      const start = offset, end = offset += part.text.length;
      const chips = layout.chips.filter(chip => chip.start >= start && chip.end <= end).map(chip => ({ start: chip.start - start, end: chip.end - start,
        node: <MessageFileChip chip={chip} onOpenPath={onOpenPath} onOpenAttachment={onOpenAttachment} /> }));
      return <div key={part.key} className="user-text"><LinkedUserText text={part.text} chips={chips} onOpen={onOpenPath} /></div>;
    }
    if (part.kind === 'text') return <div key={part.key} className={part.thought ? 'markdown reply-thought' : 'markdown'}>
      <ReplyCwd cwd={part.cwd}><ArtifactMarkdown onOpen={onOpenPath} text={part.text} inlineImages /></ReplyCwd>
    </div>;
    return part.rows.length === 1 ? <ActivityRow key={part.key} row={part.rows[0]} compact={compact} onOpenPath={onOpenPath} />
      : <ActivityGroup key={part.key} rows={part.rows} onOpenPath={onOpenPath} />;
  });
  if (!layout?.row.length) return content;
  return <><MessageAttachmentCards cards={layout.row} onOpenPath={onOpenPath} onOpenAttachment={onOpenAttachment} />{content}</>;
}

export function MessageDisplay({ message, replyDetail, showThinkingAsText, onOpenPath, onOpenAttachment, onRewind, onQuote }: ReplyProps & {
  replyDetail: ReplyDetail;
  showThinkingAsText: boolean;
  onRewind?: (uuid: string) => void;
  onQuote?: (text: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const scope = useArtifactScope();
  const isUser = message.role === "user";
  const compact = replyDetail === 'compact';
  // Activity verbs and summaries are written in the current language.
  const locale = useLocale();
  const showThoughts = !isUser && showThinkingAsText;
  // ReplyContent shows a user message's files as chips and cards, leaving only inline images here.
  const parts = useMemo(() => replyParts(isUser ? { ...message, attachments: message.attachments?.filter(file => file.image && !file.path) } : message,
    compact, showThoughts), [message, message.text, message.attachments, isUser, compact, showThoughts, locale]);
  const markdown = useMemo(() => showThoughts ? replyMarkdown(parts) : message.text, [showThoughts, parts, message.text]);
  const files = isUser ? undefined : message.attachments?.filter(ref => !ref.image);
  async function copy() {
    try {
      await window.desktop.copyText(markdown);
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
      onContextMenu={event => showContextMenu(event, messageMenu(event, message, { markdown, workspaceId: scope?.workspaceId, onOpenPath, onRewind, onQuote }), t('chat.messageActions'))}
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
        <ReplyContent message={message} parts={parts} compact={compact} onOpenPath={onOpenPath} onOpenAttachment={onOpenAttachment} />
        {message.interrupted && <p className="message-interrupted">{t('chat.interrupted')}</p>}
        {!!files?.length && <div className="artifact-attachments">
          {files.map(ref => ref.path
            ? <FileLink key={ref.id} path={ref.path} onOpen={onOpenPath} explicit><Paperclip size={13} />{ref.name}</FileLink>
            : <button type="button" key={ref.id} className="artifact-link" title={t('chat.openFile', { name: ref.name })}
              onClick={() => onOpenAttachment(ref)}><Paperclip size={13} />{ref.name}</button>)}
        </div>}
      </div>
      {isUser && onRewind && message.rewindUuid && <button type="button" className="message-rewind" title={t('chat.rewindHereTitle')}
        onClick={() => onRewind(message.rewindUuid!)}><CornerDownLeft size={13}/>{t('chat.rewindHere')}</button>}
      {!isUser && (markdown || message.timing) && (
        <div className="message-footer">
          {message.status === "streaming" && (
            <span className="stream-label">
              <span className="pulse-dot" />
              {t('chat.replying')}
            </span>
          )}
          {markdown && <button
            className="icon-button copy-button"
            onClick={copy}
            title={t('chat.copyReply')}
            aria-label={t('chat.copyReply')}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>}
          {message.timing && <TurnTimingLabel timing={message.timing} />}
        </div>
      )}
    </article>
  );
}
