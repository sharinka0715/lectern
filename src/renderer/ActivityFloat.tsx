import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Activity, Bot, ChevronDown, FileDiff, FileImage, GitBranch, Laptop, Loader2, Minus, PanelRight, Paperclip, Radio, RefreshCw, Server, Terminal } from "lucide-react";
import { runOrder, type ActivityKind, type SessionActivity } from "../shared/activity";
import type { GitChange, GitChangesResult, MessageAttachment } from "../shared/types";
import { ActivityCard, Tally } from "./ActivityPanel";
import { AttachmentThumbnail } from "./AttachmentThumbnail";
import "./activity-float.css";
import { t, type MessageKey } from '../shared/i18n';

type GitState = { loading: boolean; result?: GitChangesResult; error?: string };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");

/** The folder's repository changes: read when shown, after each finished turn, and every minute while open. */
function useGitChanges(workspaceId: string, refreshKey: string, open: boolean) {
  const [state, setState] = useState<GitState>({ loading: true });
  const request = useRef(0);
  const load = useCallback(async (explicit = false) => {
    const id = ++request.current;
    setState(previous => ({ ...previous, loading: true, error: undefined }));
    try {
      const result = await window.desktop.gitChanges(workspaceId, explicit);
      if (id === request.current) setState({ loading: false, result });
    } catch (error) {
      if (id === request.current) setState(previous => ({ ...previous, loading: false, error: message(error) }));
    }
  }, [workspaceId]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 600);
    return () => window.clearTimeout(timer);
  }, [load, refreshKey]);
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [load, open]);
  return { state, load };
}

const statusMarks: Record<GitChange["status"], string> = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U", conflict: "!" };
const statusNames: Record<GitChange["status"], MessageKey> = { modified: 'activity.gitModified', added: 'activity.gitAdded', deleted: 'activity.gitDeleted',
  renamed: 'activity.gitRenamed', untracked: 'activity.gitUntracked', conflict: 'activity.gitConflict' };
const kindLabels = { agent: 'activity.kindAgent', shell: 'activity.kindShell', monitor: 'activity.kindMonitor' } as const;
const kindIcons = { agent: Bot, shell: Terminal, monitor: Radio } as const;

function Section({ icon, title, summary, open, onToggle, children, action }: {
  icon: ReactNode; title: string; summary?: ReactNode; open: boolean; onToggle?: () => void; children?: ReactNode; action?: ReactNode;
}) {
  return <section className="activity-float-section" data-open={open || undefined}>
    <div className="activity-float-row">
      <button type="button" className="activity-float-toggle" aria-expanded={onToggle ? open : undefined} disabled={!onToggle} onClick={onToggle}>
        <span className="activity-float-heading"><span className="activity-float-icon">{icon}</span><span className="activity-float-title">{title}</span>
          {summary !== undefined && <span className="activity-float-summary">{summary}</span>}</span>
        {onToggle && <ChevronDown size={13} className="activity-float-chevron" aria-hidden="true" />}
      </button>
      {action}
    </div>
    {open && children && <div className="activity-float-body">{children}</div>}
  </section>;
}

/** Status dots of a kind of task: running ones pulse, ended ones show how they ended. */
function Dots({ items }: { items: SessionActivity[] }) {
  return <span className="activity-float-dots" aria-hidden="true">
    {items.slice(0, 8).map(item => <i key={item.id} data-state={item.status} />)}
    {items.length > 8 && <small>+{items.length - 8}</small>}
  </span>;
}

interface Props {
  workspaceId: string;
  folderName: string;
  /** The machine the folder is on, named as in the sidebar; shown beside the folder. */
  machine?: { name: string; remote: boolean };
  /** The Claude Code version running this chat, shown at the top of the card. */
  cliVersion?: string;
  items: SessionActivity[];
  attachments: MessageAttachment[];
  /** The chat the attachments belong to: their thumbnails are read through it. */
  sessionId?: string;
  /** Changes whenever a turn ends: the repository is read again. */
  refreshKey: string;
  /** The user's choice for this chat; without one the card opens when it fits beside the conversation. */
  choice?: boolean;
  onChoice(open: boolean): void;
  onShownChange(open: boolean): void;
  onOpenPath(path: string): void;
  onOpenAttachment(attachment: MessageAttachment): void;
  /** Shows a subagent's conversation, or a shell's or monitor's command and output, in the pane's
   * task column; without an item, the column on the first one of `kind`. */
  onOpenTask?(item?: SessionActivity, kind?: ActivityKind): void;
}

/**
 * The chat's activity, floating at the top right of its conversation (one per
 * split pane): the repository's changes, subagents, background shells, monitors
 * and attachments. Each part opens in place; the card folds into a small pill.
 */
export function ActivityFloat(props: Props) {
  const { items, attachments } = props;
  const root = useRef<HTMLDivElement>(null);
  const [roomy, setRoomy] = useState(true);
  useLayoutEffect(() => {
    const anchor = root.current, area = anchor?.parentElement;
    if (!anchor || !area) return;
    // Open by default only where it does not cover the conversation column: the card's
    // width and its inset from the edge come from activity-float.css.
    const measure = () => {
      const column = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--conversation-width")) || 800;
      const style = getComputedStyle(anchor), card = parseFloat(style.getPropertyValue("--activity-float-width")) || 336;
      setRoomy((area.clientWidth - column) / 2 >= card + (parseFloat(style.right) || 0));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    return () => observer.disconnect();
  }, []);
  const changes = useGitChanges(props.workspaceId, props.refreshKey, props.choice ?? roomy);
  const git = changes.state, load = changes.load;
  const gitShown = git.result?.kind === "repo" || git.result?.kind === "guarded";
  // Without a choice, open where it fits and only with something to show.
  const open = props.choice ?? (roomy && (gitShown || items.length > 0 || attachments.length > 0));
  const [section, setSection] = useState<string>();
  const [now, setNow] = useState(Date.now);
  const running = items.filter(item => item.status === "running").length;
  useEffect(() => {
    if (!running || !open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, open]);
  const repo = git.result?.kind === "repo" ? git.result.changes : undefined;
  const hasContent = gitShown || items.length > 0 || attachments.length > 0;
  useEffect(() => { props.onShownChange(open); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (name: string) => setSection(current => current === name ? undefined : name);

  if (!open) return <div ref={root} className="activity-float-anchor">
    {hasContent && <button type="button" className="activity-float-pill" aria-label={t('activity.expand')}
      title={props.cliVersion ? t('activity.expandWithVersion', { version: props.cliVersion }) : t('activity.expand')} onClick={() => props.onChoice(true)}>
      <Activity size={14} aria-hidden="true" />{t('activity.pill')}
      {running > 0 && <b>{running}</b>}
      {!!repo?.total && <small>{t('activity.changeCount', { count: repo.total })}</small>}
    </button>}
  </div>;

  // Each kind in the task column's order: running ones first, then ended ones, newest first.
  const kinds = (["agent", "shell", "monitor"] as const).map(kind => ({ kind, list: runOrder(items.filter(item => item.kind === kind)) })).filter(group => group.list.length);
  return <div ref={root} className="activity-float-anchor">
    <aside className="activity-float" aria-label={t('activity.label')}>
      <header>
        <span className="activity-float-repo" title={repo?.root}>{repo?.repo ?? props.folderName}</span>
        {props.machine && <span className="activity-float-machine" title={t(props.machine.remote ? 'activity.sshMachine' : 'activity.thisComputer', { name: props.machine.name })}>
          {props.machine.remote ? <Server size={11} aria-hidden="true" /> : <Laptop size={11} aria-hidden="true" />}<span>{props.machine.name}</span></span>}
        <button type="button" className="icon-button" aria-label={t('activity.collapse')} title={t('activity.collapseShort')} onClick={() => props.onChoice(false)}><Minus size={14} /></button>
        {(repo?.branch || props.cliVersion) && <div className="activity-float-meta">
          {repo?.branch && <span className="activity-float-branch" title={t('activity.branch', { branch: repo.branch })}><GitBranch size={11} aria-hidden="true" />{repo.branch}</span>}
          {props.cliVersion && <span className="activity-float-version" title={t('activity.versionTitle')}>Claude Code {props.cliVersion}</span>}
        </div>}
      </header>
      {git.result?.kind === "guarded" && !repo && <Section icon={<FileDiff size={14} />} title={t('activity.changes')} open={false} summary={t('activity.guarded')}
        action={<button type="button" className="activity-float-link" onClick={() => void load(true)}>{t('activity.read')}</button>} />}
      {repo && <Section icon={<FileDiff size={14} />} title={t('activity.changes')} open={section === "changes"} onToggle={repo.total ? () => toggle("changes") : undefined}
        summary={repo.total ? <><span className="activity-float-count">{t('activity.fileCount', { count: repo.total })}</span><span className="activity-added">+{repo.added}</span><span className="activity-removed">−{repo.removed}</span></> : t('activity.noChanges')}
        action={<button type="button" className="icon-button activity-float-refresh" aria-label={t('activity.rereadChanges')} title={t('activity.rereadChanges')} onClick={() => void load(true)}>
          {git.loading ? <Loader2 size={13} className="rotating" /> : <RefreshCw size={13} />}</button>}>
        <ul className="activity-float-files">{repo.files.map(file => {
          const slash = file.path.replace(/\/$/u, "").lastIndexOf("/"), name = file.path.slice(slash + 1), dir = slash >= 0 ? file.path.slice(0, slash) : "";
          return <li key={file.path}>
            <button type="button" disabled={file.status === "deleted"} title={t('settings.labelWithValue', { name: t(statusNames[file.status]), value: `${file.from ? `${file.from} → ` : ""}${file.path}` })}
              onClick={() => props.onOpenPath(`${repo.root}/${file.path}`)}>
              <span className="activity-float-mark" data-status={file.status}>{statusMarks[file.status]}</span>
              <span className="activity-float-file">{name}{dir && <small>{dir}</small>}</span>
              {file.binary ? <small>{t('activity.binary')}</small> : <span className="activity-changes">
                {!!file.added && <span className="activity-added">+{file.added}</span>}{!!file.removed && <span className="activity-removed">−{file.removed}</span>}</span>}
            </button>
          </li>;
        })}{repo.total > repo.files.length && <li className="activity-float-more">{t('activity.moreFiles', { count: repo.total - repo.files.length })}</li>}</ul>
      </Section>}
      {git.error && !repo && <p className="activity-float-error">{t('activity.readFailed', { error: git.error })}</p>}
      {kinds.map(({ kind, list }) => {
        const Icon = kindIcons[kind];
        const open = props.onOpenTask;
        return <Section key={kind} icon={<Icon size={14} />} title={t(kindLabels[kind])} open={section === kind} onToggle={() => toggle(kind)}
          summary={<Tally items={list} lead={<Dots items={list} />} />}
          action={open && <button type="button" className="icon-button activity-float-refresh" aria-label={t('activity.openSubagents')} title={t('activity.openSubagents')}
            data-open-kind={kind} onClick={() => open(undefined, kind)}><PanelRight size={13} /></button>}>
          {list.map(item => <ActivityCard key={item.id} item={item} now={now} expand={false} onOpen={open && (() => open(item))} />)}
        </Section>;
      })}
      {attachments.length > 0 && <Section icon={<Paperclip size={14} />} title={t('activity.attachments')} open={section === "attachments"} onToggle={() => toggle("attachments")}
        summary={t('activity.attachmentCount', { count: attachments.length })}>
        <ul className="activity-float-attachments">{attachments.map(file => <li key={file.id}>
          <button type="button" title={t('activity.openName', { name: file.name })} onClick={() => props.onOpenAttachment(file)}>
            <AttachmentThumbnail workspaceId={props.workspaceId} sessionId={props.sessionId} file={file}
              icon={file.image ? <FileImage size={13} aria-hidden="true" /> : <Paperclip size={13} aria-hidden="true" />} />{file.name}</button>
        </li>)}</ul>
      </Section>}
      {!hasContent && !git.loading && <p className="activity-float-empty">{t('activity.empty')}</p>}
    </aside>
  </div>;
}
