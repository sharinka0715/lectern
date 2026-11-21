import { useEffect, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import type { ChatView, HandoffHistorySnapshot, Workspace } from '../shared/types';
import { ArtifactDrawer, type ArtifactTarget } from './ArtifactDrawer';
import { ConversationTranscript } from './ConversationTranscript';
import type { ReplyDetail } from './desktop-state';
import { reportActionError } from './diagnostics';
import { t } from '../shared/i18n';

interface SourceProps {
  workspace: Workspace; tipId: string; view: ChatView; sizeMiB: number; replyDetail: ReplyDetail;
}
const errorText = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error);
const ignoreFollow = () => {};

// Each source owns its reads, attachments and scroll anchor. Never feed this
// snapshot into the live watch, even when both panes are showing the same tip.
function SourceHistory({ workspace, tipId, sourceId, view, sizeMiB, replyDetail }: SourceProps & { sourceId: string }) {
  const [page, setPage] = useState<HandoffHistorySnapshot>();
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const [trail, setTrail] = useState<ArtifactTarget[]>([]);
  const [showOther, setShowOther] = useState(false);
  const current = useRef(false);
  useEffect(() => {
    let retired = false, opened = false;
    current.current = true;
    // StrictMode's initial mount/cleanup does not need a second IPC lease.
    queueMicrotask(async () => {
      if (retired) return;
      opened = true;
      try {
        const result = await window.desktop.readHandoffHistory(workspace.id, tipId, sourceId, undefined, undefined, view);
        if (!retired) setPage(result);
      } catch (e) { if (!retired) setError(errorText(e)); }
    });
    return () => {
      retired = true;
      current.current = false;
      if (opened) void window.desktop.releaseHandoffHistory(workspace.id, tipId, view).catch(e => reportActionError(e, '释放交接前记录失败'));
    };
  }, [workspace.id, tipId, sourceId, view, attempt]);
  async function earlier(cursor: string) {
    try {
      const result = await window.desktop.readHandoffHistory(workspace.id, tipId, sourceId, cursor, sizeMiB, view);
      if (current.current) setPage(result);
    } catch (error) { if (current.current) throw new Error(errorText(error)); }
  }
  if (error) return <div className="artifact-unavailable" role="alert"><strong>{t('dialogs.handoffUnreadable')}</strong><p>{error}</p>
    <button type="button" className="secondary-button" onClick={() => { setError(''); setAttempt(n => n + 1); }}>{t('dialogs.retry')}</button></div>;
  if (!page) return <div className="artifact-loading" role="status"><Loader2 size={17} className="rotating" />{t('dialogs.readingHandoff')}</div>;
  const open = (target: ArtifactTarget) => setTrail(previous => [...previous, target]);
  const others = page.otherRecords ?? [];
  const viewingOther = showOther && others.length > 0;
  return <>
    {page.notice && <p className="artifact-note" role="status">{page.notice}</p>}
    {others.length > 0 && <div className="handoff-source">
      <button type="button" className="secondary-button" aria-pressed={viewingOther} onClick={() => setShowOther(!viewingOther)}>
        {viewingOther ? t('dialogs.backToSegment') : t('dialogs.otherPaths', { count: others.length })}</button>
      {viewingOther && <p>{t('dialogs.otherPathsNote')}</p>}
    </div>}
    <div className="handoff-body">
      <ConversationTranscript key={String(viewingOther)} workspace={workspace} sessionId={tipId} messages={viewingOther ? others : page.messages} replyDetail={replyDetail}
        historyPage={{hasOlder: !!page.cursor, cursor: page.cursor ?? ''}} loadEarlier={earlier} onFollowLatest={ignoreFollow} openArtifact={open}>
        <p className="artifact-unavailable">{t('dialogs.noHandoffMessages')}</p>
      </ConversationTranscript>
      {trail.length > 0 && <ArtifactDrawer key={trail.length} workspace={workspace} sessionId={tipId} target={trail[trail.length - 1]}
        canGoBack={trail.length > 1} onBack={() => setTrail(t => t.slice(0, -1))} onClose={() => setTrail([])} onOpen={path => open({path})} />}
    </div>
  </>;
}

export function HandoffHistoryDialog({ sources, onClose, ...props }: SourceProps & { sources: string[]; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState(sources.at(-1)!);
  const sourceId = sources.includes(selected) ? selected : sources.at(-1)!;
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} className="modal handoff-history" aria-label={t('dialogs.handoffTitle')} onCancel={event => {
    if (event.target === event.currentTarget) { event.preventDefault(); onClose(); }
  }}>
    <header className="pref-header"><h2>{t('dialogs.handoffTitle')}</h2>
      <button className="icon-button" type="button" aria-label={t('dialogs.closeHandoff')} onClick={onClose}><X size={18} /></button></header>
    <div className="handoff-source"><label>{t('dialogs.originalRecord')}
      <select value={sourceId} onChange={e => setSelected(e.target.value)}>
        {sources.map((id, i) => <option key={id} value={id}>{t('dialogs.segment', { n: i + 1 })}{i === sources.length - 1 ? t('dialogs.latestSegment') : ''} · {id.slice(0, 8)}</option>)}
      </select></label>
      <p>{t('dialogs.handoffNote')}</p></div>
    <SourceHistory key={sourceId} sourceId={sourceId} {...props} />
  </dialog>;
}
