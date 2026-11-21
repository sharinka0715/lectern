import { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, Check, ChevronRight, Code, Copy, Download, File, FileQuestion, FileText, Folder, FolderOpen, Loader2, RefreshCw, TextSelect, X } from 'lucide-react';
import { copyWithToast, showContextMenu, type MenuEntry } from './ContextMenu';
import { pointedContent, selectionWithin } from './message-menus';
import type { ArtifactDirectory, ArtifactPreview, MessageAttachment, Workspace } from '../shared/types';
import { ArtifactMarkdown } from './ArtifactLinks';
import { CodePreview } from './CodePreview';
import { useDesktopState } from './desktop-state';
import { parentPath, pathBasename } from './artifact-paths';
import { ArtifactReferenceScope } from './ArtifactReferenceScope';
import { t } from '../shared/i18n';

export type ArtifactTarget = { path: string } | { attachment: MessageAttachment };

// The panel width is the user's choice, kept across files, sessions and restarts.
// Without one the stylesheet's responsive default applies.
const widthKey = 'lectern.artifact.width', minWidth = 300, minChatWidth = 500;
function savedWidth() {
  try {
    const value = Number(localStorage.getItem(widthKey));
    if (Number.isInteger(value) && value >= minWidth && value <= 4000) return value;
  } catch { /* A read-only profile still resizes for this window. */ }
  return undefined;
}
function rememberWidth(value: number | undefined) {
  try { if (value === undefined) localStorage.removeItem(widthKey); else localStorage.setItem(widthKey, String(value)); }
  catch { /* Keep the in-memory size. */ }
}

function errorText(error: unknown) {
  return String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}
function sizeLabel(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
const kinds = { directory: 'files.kindDirectory', markdown: 'files.kindMarkdown', code: 'files.kindCode', text: 'files.kindText', document: 'files.kindDocument',
  image: 'files.kindImage', pdf: 'files.kindPdf', video: 'files.kindVideo', audio: 'files.kindAudio', binary: 'files.kindBinary' } as const;

function MediaPreview({ preview }: { preview: ArtifactPreview }) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  const playable = preview.kind === 'video' || preview.kind === 'audio';
  useEffect(() => {
    if (!preview.data) return;
    const blob = new Blob([new Uint8Array(preview.data)], { type: preview.kind === 'pdf' ? 'application/pdf' : preview.mime });
    // Players seek inside a blob URL; a data URL would copy the whole file into a string.
    if (playable) {
      const value = URL.createObjectURL(blob);
      setUrl(value);
      return () => URL.revokeObjectURL(value);
    }
    const reader = new FileReader();
    reader.onload = () => setUrl(String(reader.result));
    reader.onerror = () => setFailed(true);
    reader.readAsDataURL(blob);
    return () => {
      reader.onload = reader.onerror = null;
      if (reader.readyState === FileReader.LOADING) reader.abort();
    };
  }, [preview, playable]);
  if (failed) return <p className="artifact-note">{playable ? t('files.cannotPlay', { kind: t(kinds[preview.kind]) }) : t('files.cannotDecode')}</p>;
  if (!url) return <div className="artifact-loading" role="status"><Loader2 size={17} className="rotating" />{t('files.loading')}</div>;
  if (preview.kind === 'pdf') return <iframe className="artifact-pdf" title={t('files.pdfPreview', { name: preview.name })} src={url + '#toolbar=1&navpanes=0&view=FitH'} />;
  if (preview.kind === 'video') return <div className="artifact-video">
    <video src={url} controls preload="metadata" aria-label={t('files.videoLabel', { name: preview.name })} onError={() => setFailed(true)} />
  </div>;
  if (preview.kind === 'audio') return <div className="artifact-audio">
    <audio src={url} controls preload="metadata" aria-label={t('files.audioLabel', { name: preview.name })} onError={() => setFailed(true)} />
  </div>;
  return <div className="artifact-image"><img src={url} alt={preview.name} onError={() => setFailed(true)} /></div>;
}

function DirectoryView({ initial, workspaceId, onOpen }: {
  initial: ArtifactDirectory; workspaceId: string; onOpen: (path: string) => void;
}) {
  const [listing, setListing] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  async function more() {
    if (loading || listing.nextOffset === undefined) return;
    setError('');
    setLoading(true);
    try {
      const next = await window.desktop.listArtifactDirectory(workspaceId, listing.path, listing.nextOffset);
      const seen = new Set(listing.entries.map(entry => entry.path));
      setListing({ ...next, entries: [...listing.entries, ...next.entries.filter(entry => !seen.has(entry.path))] });
    } catch (error) { setError(errorText(error)); }
    finally { setLoading(false); }
  }
  return <div className="artifact-directory">
    {listing.entries.map(entry => <button type="button" className="artifact-entry" key={entry.path} data-entry-path={entry.path} onClick={() => onOpen(entry.path)}
      onContextMenu={event => showContextMenu(event, [
        { label: t(entry.kind === 'directory' ? 'files.openFolder' : 'files.preview'), icon: entry.kind === 'directory' ? <FolderOpen size={14} /> : <FileText size={14} />, onSelect: () => onOpen(entry.path) },
        'separator',
        { label: t('files.copyPath'), icon: <Copy size={14} />, onSelect: () => copyWithToast(entry.path) },
        { label: t('files.copyName'), icon: <Copy size={14} />, onSelect: () => copyWithToast(entry.name) },
        entry.kind !== 'directory' && { label: t('files.download'), icon: <Download size={14} />, onSelect: () => window.desktop.downloadArtifact(workspaceId, entry.path) },
      ], entry.name)}>
      {entry.kind === 'directory' ? <Folder size={17} className="artifact-folder-icon" /> : <File size={16} />}
      <span>{entry.name}</span><ChevronRight size={14} />
    </button>)}
    {!listing.entries.length && <p className="artifact-note">{t('files.emptyFolder')}</p>}
    {listing.nextOffset !== undefined && <button className="secondary-button artifact-more" onClick={() => void more()} disabled={loading}>{t(loading ? 'files.loadingMore' : 'files.loadMore')}</button>}
    {error && <p className="artifact-error" role="alert">{error}</p>}
  </div>;
}

interface DrawerProps {
  workspace: Workspace;
  sessionId: string;
  target: ArtifactTarget;
  canGoBack: boolean;
  onBack: () => void;
  onClose: () => void;
  onOpen: (path: string) => void;
}

/** Mounted with a fresh key on every navigation. Late reads and saves can only update the retired view. */
export function ArtifactDrawer({ workspace, sessionId, target, canGoBack, onBack, onClose, onOpen }: DrawerProps) {
  const [preview, setPreview] = useState<ArtifactPreview>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [source, setSource] = useState(false);
  const prefs = useDesktopState();
  const request = useRef<{ attempt: number; value: Promise<ArtifactPreview> }>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const panelId = useId();
  const [width, setWidth] = useState(savedWidth);
  const drag = useRef<{ id: number; startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const limit = () => Math.max(minWidth, (panel.current?.parentElement?.clientWidth ?? window.innerWidth) - minChatWidth);
  const clamp = (value: number) => Math.max(minWidth, Math.min(limit(), Math.round(value)));
  const shown = () => panel.current?.getBoundingClientRect().width ?? width ?? minWidth;
  function settle(value: number | undefined) { setWidth(value); rememberWidth(value); }
  useEffect(() => {
    let active = true;
    // React StrictMode replays effects. Reuse this navigation's IPC read, including its native access prompt.
    if (!request.current || request.current.attempt !== attempt) request.current = {
      attempt, value: 'path' in target ? window.desktop.previewArtifact(workspace.id, target.path)
        : window.desktop.previewMessageAttachment(workspace.id, sessionId, target.attachment.id),
    };
    request.current.value.then(value => { if (active) setPreview(value); }, error => { if (active) setError(errorText(error)); });
    return () => { active = false; };
  }, [workspace.id, sessionId, target, attempt]);
  useEffect(() => {
    closeButton.current?.focus({ preventScroll: true });
    function escape(event: KeyboardEvent) {
      // With two split panes open, Escape closes only the preview of the pane in use.
      const pane = panel.current?.closest('.desk-pane');
      const otherPane = pane?.getAttribute('data-active') === 'false' && !!pane.parentElement?.classList.contains('divided');
      if (event.key === 'Escape' && !document.querySelector('dialog[open]') && !otherPane) {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onClose]);

  const path = preview?.path ?? ('path' in target ? target.path : target.attachment.name);
  const parent = 'path' in target ? parentPath(path) : undefined;
  const title = path === '.' ? workspace.name : preview?.name || pathBasename(path);
  async function download() {
    setSaving(true);
    setSaveError('');
    try {
      const complete = 'path' in target ? await window.desktop.downloadArtifact(workspace.id, preview?.path ?? target.path)
        : await window.desktop.downloadMessageAttachment(workspace.id, sessionId, target.attachment.id);
      setSaved(complete);
    } catch (error) { setSaveError(errorText(error)); }
    finally { setSaving(false); }
  }
  function panelMenu(event: React.MouseEvent<HTMLElement>) {
    if ((event.target as Element).closest('.artifact-separator')) return;
    const selected = selectionWithin(event.currentTarget).trim(), linked = pointedContent(event.target).file;
    const filePath = 'path' in target ? (path === '.' ? workspace.cwd : path) : undefined;
    const text = preview?.text !== undefined && preview.kind !== 'directory' ? preview.text : undefined;
    const entries: (MenuEntry | false)[] = [
      !!selected && { label: t('files.copySelection'), icon: <TextSelect size={14} />, onSelect: () => copyWithToast(selected) },
      !!linked && { label: t('files.previewLinked'), icon: <FileText size={14} />, onSelect: () => onOpen(linked) },
      !!linked && { label: t('files.copyLinkedPath'), icon: <Copy size={14} />, onSelect: () => copyWithToast(linked) },
      'separator',
      !!text && { label: t('files.copyContent'), icon: <Copy size={14} />, onSelect: () => copyWithToast(text, t(preview?.truncated ? 'files.copiedPartial' : 'files.copied')) },
      !!filePath && { label: t('files.copyPath'), icon: <Copy size={14} />, onSelect: () => copyWithToast(filePath) },
      { label: t('files.copyName'), icon: <Copy size={14} />, onSelect: () => copyWithToast(title) },
      !!preview && preview.kind !== 'directory' && { label: t('files.downloadOriginal'), icon: <Download size={14} />, onSelect: download },
      'separator',
      preview?.kind === 'markdown' && preview.text !== undefined && { label: t(source ? 'files.showRendered' : 'files.showSource'), icon: <Code size={14} />, onSelect: () => setSource(!source) },
      !!parent && { label: t('files.openParent'), icon: <ArrowUp size={14} />, onSelect: () => onOpen(parent) },
      { label: t('files.reload'), icon: <RefreshCw size={14} />, onSelect: () => { setPreview(undefined); setError(''); setAttempt(value => value + 1); } },
      canGoBack && { label: t('files.back'), icon: <ArrowLeft size={14} />, onSelect: onBack },
      { label: t('files.closePreview'), icon: <X size={14} />, onSelect: onClose },
    ];
    showContextMenu(event, entries, t('files.filePreview'));
  }
  return <aside ref={panel} id={panelId} className="artifact-drawer" aria-label={t('files.filePreview')} data-artifact-path={path} data-artifact-kind={preview?.kind}
    style={width === undefined ? undefined : { width }} onContextMenu={panelMenu}>
    <div className="artifact-separator" role="separator" aria-label={t('files.resizePreview')} aria-controls={panelId} aria-orientation="vertical"
      aria-valuemin={minWidth} aria-valuenow={width} aria-valuetext={width === undefined ? t('files.defaultWidth') : t('files.pixels', { width })} tabIndex={0}
      title={t('files.resizeTitle')} data-dragging={dragging || undefined}
      onDoubleClick={() => settle(undefined)}
      onPointerDown={event => {
        if (!event.isPrimary || event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, startX: event.clientX, startWidth: shown() };
        setDragging(true);
      }}
      onPointerMove={event => {
        const start = drag.current;
        // The handle is on the left edge: moving it left widens the panel.
        if (start?.id === event.pointerId) setWidth(clamp(start.startWidth + start.startX - event.clientX));
      }}
      onPointerUp={event => {
        const start = drag.current;
        if (start?.id !== event.pointerId) return;
        drag.current = null; setDragging(false);
        const next = clamp(start.startWidth + start.startX - event.clientX);
        if (next !== Math.round(start.startWidth)) settle(next); else setWidth(savedWidth());
      }}
      onPointerCancel={event => { if (drag.current?.id === event.pointerId) { drag.current = null; setDragging(false); setWidth(savedWidth()); } }}
      onLostPointerCapture={event => { if (drag.current?.id === event.pointerId) { drag.current = null; setDragging(false); setWidth(savedWidth()); } }}
      onKeyDown={event => {
        if (drag.current || event.altKey || event.ctrlKey || event.metaKey) return;
        const step = event.key === 'ArrowLeft' ? 24 : event.key === 'ArrowRight' ? -24 : 0;
        if (!step) return;
        event.preventDefault();
        settle(clamp(shown() + step));
      }} />
    <div className="artifact-bar">
      <button type="button" className="icon-button" disabled={!canGoBack} aria-label={t('files.back')} onClick={onBack}><ArrowLeft size={16} /></button>
      <span>{t('files.filePreview')}</span>
      <button type="button" className="icon-button" ref={closeButton} aria-label={t('files.closeFilePreview')} onClick={onClose}><X size={17} /></button>
    </div>
    <div className="artifact-heading">
      <div className="artifact-location">
        {'path' in target ? <button onClick={() => onOpen('.')} title={workspace.cwd}><Folder size={13} />{workspace.name}</button> : <span>{t('files.sessionAttachment')}</span>}
        {workspace.kind === 'ssh' && <span>{workspace.host}</span>}
      </div>
      <h2>{title}</h2>
      {'path' in target && <div className="artifact-path"><code>{path === '.' ? workspace.cwd : path}</code>
        {parent && <button className="icon-button" onClick={() => onOpen(parent)} title={t('files.openParent')} aria-label={t('files.openParent')}><ArrowUp size={14} /></button>}
      </div>}
    </div>
    {preview && <div className="artifact-meta"><span>{t(kinds[preview.kind])}</span>
      {preview.kind !== 'directory' && <><span>·</span><span>{sizeLabel(preview.size)}</span>
        {preview.kind === 'markdown' && preview.text !== undefined && <span className="artifact-view-switch" role="group" aria-label={t('files.markdownView')}>
          <button type="button" aria-pressed={!source} onClick={() => setSource(false)}>{t('files.rendered')}</button>
          <button type="button" aria-pressed={source} onClick={() => setSource(true)}>{t('files.source')}</button>
        </span>}
        <button type="button" className="artifact-save" disabled={saving} onClick={() => void download()} aria-label={t('files.downloadOriginal')}>
          {saved ? <Check size={14} /> : <Download size={14} />}{t(saving ? 'files.saving' : saved ? 'files.saved' : 'files.downloadOriginal')}
        </button></>}
    </div>}
    {saveError && <p role="alert" className="artifact-error">{saveError}</p>}
    <div className={'artifact-content' + (preview?.kind === 'pdf' ? ' artifact-content-pdf' : '')}>
      {error ? <div className="artifact-unavailable" role="alert"><FileQuestion size={27} /><strong>{t('files.cannotOpen')}</strong><p>{error}</p>
        <button className="secondary-button" onClick={() => { setError(''); setAttempt(value => value + 1); }}><RefreshCw size={13} />{t('files.retry')}</button>
      </div> : !preview ? <div className="artifact-loading" role="status"><Loader2 size={17} className="rotating" />{t('files.reading')}</div> : <>
        {preview.notice && <p className="artifact-note">{preview.notice}</p>}
        {preview.kind === 'directory' ? <DirectoryView initial={preview} workspaceId={workspace.id} onOpen={onOpen} />
          : preview.kind === 'markdown' && preview.text !== undefined && !source ? <div className="markdown artifact-markdown"><ArtifactReferenceScope workspace={workspace} file={'path' in target ? preview.path : undefined}>
            <ArtifactMarkdown text={preview.text} onOpen={onOpen} inlineImages={'path' in target} /></ArtifactReferenceScope></div>
          : preview.text === '' ? <p className="artifact-note">{t('files.emptyFile')}</p>
          : preview.text !== undefined && preview.kind !== 'document' ? <CodePreview className="artifact-text" text={preview.text} name={preview.name}
            highlight={prefs.previewHighlight && preview.kind !== 'text'} lineNumbers={prefs.previewLineNumbers} wrap={prefs.previewWrap} />
          : preview.text !== undefined ? <pre className="artifact-text artifact-document">{preview.text}</pre>
          : (preview.kind === 'image' || preview.kind === 'pdf' || preview.kind === 'video' || preview.kind === 'audio') && preview.data ? <MediaPreview preview={preview} />
          : <div className="artifact-unavailable"><FileQuestion size={29} /><strong>{t(preview.truncated ? 'files.tooLarge' : 'files.unsupported')}</strong>
            <p>{t('files.downloadToOpen')}</p></div>}
        {preview.truncated && preview.text !== undefined && !preview.notice && <p className="artifact-note">{t('files.partial')}</p>}
      </>}
    </div>
  </aside>;
}
