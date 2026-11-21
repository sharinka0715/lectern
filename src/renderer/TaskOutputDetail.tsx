import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Copy, FileText, Loader2 } from 'lucide-react';
import { runningMs, type ActivityState, type SessionActivity } from '../shared/activity';
import type { ChatView, TaskOutput, Workspace } from '../shared/types';
import type { ArtifactTarget } from './ArtifactDrawer';
import { copyWithToast } from './ContextMenu';
import { ShellCode } from './ShellCode';
import { elapsed, errorText, StateIcon, states } from './SubagentDetail';
import { formatBytes } from './UpdatePrompt';
import { localeTag, t } from '../shared/i18n';

interface Reading { toolId: string; data?: TaskOutput; error?: string }
const time = (value?: string) => value ? new Date(value).toLocaleTimeString(localeTag(), { hour12: false }) : undefined;
/** A path below the command's working directory, relative to it. */
const shortPath = (path: string, cwd: string) => path.startsWith(cwd.replace(/\/+$/, '') + '/') ? path.slice(cwd.replace(/\/+$/, '').length + 1) : path;
const baseName = (path: string) => path.replace(/\/+$/, '').slice(path.replace(/\/+$/, '').lastIndexOf('/') + 1) || path;

/** A shell's or monitor's output: read every second while it runs (the main process sends
 * text only when it changed), every 5 seconds while its state is unknown, once when it ends. */
function useTaskOutput(workspaceId: string, sessionId: string, view: ChatView, toolId: string, status: ActivityState, source: string | undefined, attempt: number) {
  const [reading, setReading] = useState<Reading>();
  const revision = useRef<number | undefined>(undefined);
  const pollState = status === 'running' ? 'running' : status === 'unobserved' ? 'unknown' : status;
  useEffect(() => {
    let stopped = false, timer = 0;
    const tick = async () => {
      try {
        const result = await window.desktop.readTaskOutput(workspaceId, sessionId, toolId, { revision: revision.current, source }, view);
        if (stopped) return;
        revision.current = result.revision;
        setReading(previous => ({ toolId, data: { ...result, text: result.text ?? (previous?.toolId === toolId ? previous.data?.text : undefined) } }));
      } catch (error) {
        if (stopped) return;
        setReading(previous => ({ ...(previous?.toolId === toolId ? previous : {}), toolId, error: errorText(error) }));
      }
      if (!stopped && (pollState === 'running' || pollState === 'unknown')) timer = window.setTimeout(tick, pollState === 'running' ? 1000 : 5000);
    };
    void tick();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [workspaceId, sessionId, view, toolId, pollState, source, attempt]);
  /** One more read now: an older page, or the redirect file the user asked to read. */
  const request = async (extra: { older?: boolean; explicit?: boolean }) => {
    const result = await window.desktop.readTaskOutput(workspaceId, sessionId, toolId, { revision: revision.current, source, ...extra }, view);
    revision.current = result.revision;
    setReading(previous => ({ toolId, data: { ...result, text: result.text ?? previous?.data?.text } }));
  };
  return [reading?.toolId === toolId ? reading : undefined, request] as const;
}

/**
 * A background shell or monitor in the task column: its description, state, start and
 * running time, the full command (coloured, file paths as links) and its output. When the
 * task printed nothing and its command wrote to a file, that file is the output (the main
 * process decides, task-output-reader.ts); the other sources stay one click away.
 */
export function TaskOutputDetail({ item, now, workspace, sessionId, view, openArtifact }: {
  item: SessionActivity; now: number; workspace: Workspace; sessionId: string; view: ChatView; openArtifact(target: ArtifactTarget): void;
}) {
  const [choice, setChoice] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [reading, request] = useTaskOutput(workspace.id, sessionId, view, item.id, item.status, choice, attempt);
  const [busy, setBusy] = useState(false);
  const data = reading?.data;
  // The file's trailer can arrive a moment before the notification that ends the run.
  const ended = item.status !== 'running';
  const exitCode = ended ? item.exitCode ?? data?.exitCode : undefined;
  const ran = runningMs(item, now);
  const facts = [t(item.kind === 'monitor' ? 'activity.panelMonitor' : 'activity.panelShell'), item.startedAt && t('activity.startedAt', { time: time(item.startedAt)! }),
    ran !== undefined && t('activity.elapsedFor', { time: elapsed(ran) }),
    item.timeoutMs !== undefined && (item.timeoutMs ? t('activity.timeoutFor', { time: elapsed(item.timeoutMs) }) : t('activity.keepsWatching'))].filter(Boolean).join(' · ');
  const source = data?.sources.find(entry => entry.key === data.source);
  const output = useRef<HTMLPreElement>(null);
  // Follow the end while the reader is there; elsewhere new output below leaves the view
  // alone, and older output added above keeps the same lines in view.
  const anchor = useRef({ bottom: true, fromEnd: 0, prepend: false });
  const remember = (prepend = false) => {
    const el = output.current;
    if (el) anchor.current = { bottom: el.scrollHeight - el.scrollTop - el.clientHeight < 24, fromEnd: el.scrollHeight - el.scrollTop, prepend };
  };
  useLayoutEffect(() => {
    const el = output.current;
    if (!el) return;
    if (anchor.current.bottom) el.scrollTop = el.scrollHeight;
    else if (anchor.current.prepend) el.scrollTop = el.scrollHeight - anchor.current.fromEnd;
    anchor.current.prepend = false;
  }, [data?.text, data?.source]);
  async function more(extra: { older?: boolean; explicit?: boolean }) {
    remember(extra.older === true);
    setBusy(true);
    try { await request(extra); } catch { setAttempt(n => n + 1); } finally { setBusy(false); }
  }
  const label = (key: string) => {
    const entry = data?.sources.find(candidate => candidate.key === key);
    return !entry || entry.kind === 'task' ? t('activity.outputOwn') : entry.kind === 'transcript' ? t('activity.outputTranscript') : baseName(entry.path ?? '');
  };
  let note;
  if (reading?.error && !data) note = <div className="subagent-note" role="alert">{t('activity.outputFailed', { error: reading.error })}
    <button type="button" className="secondary-button" onClick={() => setAttempt(n => n + 1)}>{t('activity.subagentRetry')}</button></div>;
  else if (!data) note = <p className="subagent-note" role="status"><Loader2 size={14} className="rotating" />{t('activity.outputLoading')}</p>;
  const text = data?.text ?? '';
  return <section className="task-detail" data-task-detail={item.id} data-kind={item.kind} data-state={item.status} data-source={data?.source} data-output-state={data?.state}>
    <div className="subagent-detail-head">
      <strong title={item.title}>{item.title}</strong>
      <span className="subagent-detail-state" data-state={item.status}><StateIcon status={item.status} />{t(states[item.status])}
        {exitCode !== undefined && <em data-exit-code={exitCode}>{t('activity.exitCodeShort', { code: exitCode })}</em>}
        {ended && exitCode === undefined && data?.killed && <em>{t('activity.killed')}</em>}</span>
      {facts && <small>{facts}</small>}
    </div>
    <div className="task-detail-command">
      <div className="task-detail-label"><span>{t('activity.command')}</span>
        {item.command && <button type="button" className="icon-button" aria-label={t('activity.copyCommand')} title={t('activity.copyCommand')}
          onClick={() => void copyWithToast(item.command!)}><Copy size={12} /></button>}</div>
      {item.command ? <ShellCode className="task-command" text={item.command} onOpen={path => openArtifact({ path })} /> : <p className="subagent-note">{t('activity.noCommand')}</p>}
      {item.cwd && <p className="task-cwd" title={item.cwd}>{t('activity.workingDirectory', { path: item.cwd })}</p>}
    </div>
    {data && data.sources.length > 1 && <div className="task-sources" role="group" aria-label={t('activity.outputSources')}>
      {data.sources.map(entry => <button type="button" key={entry.key} aria-pressed={entry.key === data.source} data-source-key={entry.key}
        title={entry.path ?? label(entry.key)} onClick={() => { anchor.current = { bottom: true, fromEnd: 0, prepend: false }; setChoice(entry.key); }}>
        {entry.kind === 'file' && <FileText size={11} aria-hidden="true" />}{label(entry.key)}</button>)}
    </div>}
    {source?.kind === 'file' && source.path && <p className="task-source-note" data-redirect-path={source.path}>
      {t(data!.ownEmpty ? 'activity.outputFromFileEmpty' : 'activity.outputFromFile')}
      <button type="button" className="task-path" title={t('activity.openName', { name: source.path })} onClick={() => openArtifact({ path: source.path! })}>{shortPath(source.path, item.cwd ?? workspace.cwd)}</button></p>}
    {source?.kind === 'transcript' && <p className="task-source-note">{t('activity.outputFromTranscript')}</p>}
    {data?.state === 'privacy' && <div className="task-source-note" role="status">{t('activity.outputPrivacy')}
      <button type="button" className="secondary-button" disabled={busy} onClick={() => void more({ explicit: true })}>{t('activity.read')}</button></div>}
    {data?.state === 'missing' && <p className="task-source-note" role="status">{t(item.taskId ? 'activity.outputMissing' : 'activity.outputNoTask')}</p>}
    {data?.state === 'error' && <p className="task-source-note" role="alert">{t('activity.outputFailed', { error: data.error ?? '' })}</p>}
    {reading?.error && data && <p className="task-source-note" role="alert">{t('activity.outputFailed', { error: reading.error })}</p>}
    {note ?? <div className="task-output-frame">
      <div className="task-detail-label"><span>{t('activity.output')}</span>
        {!!data?.omitted && <small>{t('activity.outputOmitted', { size: formatBytes(data.omitted) })}</small>}
        {data?.hasOlder && <button type="button" className="activity-float-link" disabled={busy} onClick={() => void more({ older: true })}>{t('activity.outputEarlier')}</button>}
        {!!text && <button type="button" className="icon-button" aria-label={t('activity.copyShownOutput')} title={t('activity.copyShownOutput')} onClick={() => void copyWithToast(text)}><Copy size={12} /></button>}
      </div>
      <pre ref={output} className="task-output" tabIndex={0} onScroll={() => remember()} data-empty={!text || undefined}>{text || (data?.state === 'ok' ? t('activity.outputNone') : '')}</pre>
    </div>}
  </section>;
}
