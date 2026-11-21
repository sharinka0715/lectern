import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Download, Image as ImageIcon, X } from 'lucide-react';
import { showContextMenu } from './ContextMenu';
import type { ArtifactPreview, MessageAttachment } from '../shared/types';
import { useArtifactResolution, useArtifactScope } from './ArtifactReferenceScope';
import { queueThumbnail } from './thumbnail-queue';
import { t } from '../shared/i18n';

type Source = { path: string } | { id: string; sessionId: string };
type ImageAction = 'copy' | 'download';

export function AttachmentImage({ attachment, onOpen }: { attachment: MessageAttachment; onOpen: (attachment: MessageAttachment) => void }) {
  const scope = useArtifactScope();
  if (attachment.path) return <WorkspaceImage name={attachment.name} path={attachment.path} explicit onOpen={() => onOpen(attachment)} />;
  if (!scope?.sessionId) return <span>{attachment.name}</span>;
  return <ImageView key={JSON.stringify([scope.workspaceId, scope.sessionId, attachment.id, attachment.revision])}
    workspaceId={scope.workspaceId} source={{ id: attachment.id, sessionId: scope.sessionId }} name={attachment.name} onOpen={() => onOpen(attachment)} />;
}

export function WorkspaceImage({ name, path, fallback, onOpen }: { name: string; path: string; explicit?: boolean; fallback?: string; onOpen: (path: string) => void }) {
  const scope = useArtifactScope();
  const { match, ref } = useArtifactResolution(path);
  // Outside the folder (an absolute path): opened on request, never thumbnailed in the background.
  const outside = match === 'outside' ? ref : match && typeof match === 'object' && match.path.startsWith('/') ? match.path : undefined;
  if (outside) return <button type="button" className="artifact-link" title={t('files.open', { name: outside })} data-file-path={outside} onClick={() => onOpen(outside)}>{t('files.view', { name })}</button>;
  if (!scope || !match || typeof match !== 'object') return <span>{fallback || name}</span>;
  return <ImageView key={JSON.stringify([scope.workspaceId, scope.sessionId, match.path])} workspaceId={scope.workspaceId}
    source={{ path: match.path }} name={name} onOpen={() => onOpen(match.path)} />;
}

async function copyPixels(image: HTMLImageElement) {
  const { naturalWidth: width, naturalHeight: height } = image;
  if (!width || !height) throw new Error(t('files.imageNotLoaded'));
  if (width * height > 64 * 1024 * 1024) throw new Error(t('files.imageTooLarge'));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error(t('files.cannotReadPixels'));
    context.drawImage(image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error(t('files.cannotMakeClipboard'))), 'image/png'));
    await window.desktop.copyImage(new Uint8Array(await blob.arrayBuffer()));
  } finally { canvas.width = canvas.height = 0; }
}

function imageUrl(preview: ArtifactPreview) {
  if (preview.kind !== 'image' || !preview.data) throw new Error(preview.notice || t('files.notImage'));
  return URL.createObjectURL(new Blob([new Uint8Array(preview.data)], { type: preview.mime }));
}

function ImageView({ workspaceId, source, name, onOpen }: { workspaceId: string; source: Source; name: string; onOpen: () => void }) {
  const frame = useRef<HTMLSpanElement>(null);
  const fullImage = useRef<HTMLImageElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [thumbnail, setThumbnail] = useState('');
  const [original, setOriginal] = useState('');
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [actualSize, setActualSize] = useState(false);
  const path = 'path' in source ? source.path : undefined;
  const id = 'id' in source ? source.id : undefined;
  const sessionId = 'id' in source ? source.sessionId : undefined;
  const readOriginal = useCallback(() => path !== undefined ? window.desktop.previewInlineImage(workspaceId, path)
    : window.desktop.previewMessageAttachment(workspaceId, sessionId!, id!), [workspaceId, path, sessionId, id]);

  useEffect(() => {
    let retired = false, url: string | undefined, cancel: (() => void) | undefined;
    const observer = new IntersectionObserver(entries => {
      if (retired) return;
      if (!entries.at(-1)?.isIntersecting) { cancel?.(); cancel = undefined; return; }
      cancel ??= queueThumbnail(async () => {
        observer.disconnect();
        try {
          const preview = path !== undefined ? await window.desktop.previewInlineImageThumbnail(workspaceId, path)
            : await window.desktop.previewMessageAttachmentThumbnail(workspaceId, sessionId!, id!);
          if (retired) return;
          url = imageUrl(preview);
          setThumbnail(url);
        } catch { /* 单张图片失败不影响文字或后续缩略图。 */ }
      });
    }, { root: frame.current?.closest('.conversation-scroll') });
    observer.observe(frame.current!);
    return () => { retired = true; cancel?.(); observer.disconnect(); if (url) URL.revokeObjectURL(url); };
  }, [workspaceId, path, sessionId, id]);

  useLayoutEffect(() => { if (expanded) dialog.current?.showModal(); }, [expanded]);
  useEffect(() => {
    if (!expanded) return;
    let retired = false, url: string | undefined;
    void readOriginal().then(preview => {
      if (retired) return;
      url = imageUrl(preview);
      setOriginal(url);
    }).catch(error => { if (!retired) setLoadError(error instanceof Error ? error.message : String(error)); });
    return () => { retired = true; if (url) URL.revokeObjectURL(url); };
  }, [expanded, readOriginal]);

  function contextMenu(event: MouseEvent) {
    showContextMenu(event, [
      { label: t('files.copyImage'), icon: <Copy size={14} />, onSelect: () => act('copy') },
      { label: t('files.downloadImage'), icon: <Download size={14} />, onSelect: () => act('download') },
      !expanded && { label: t('files.zoom'), icon: <ImageIcon size={14} />, onSelect: () => { setActualSize(false); setActionError(''); setExpanded(true); } },
    ], t('files.imageActions'));
  }
  async function act(action: ImageAction) {
    setActionError('');
    try {
      if (action === 'download') {
        if ('path' in source) await window.desktop.downloadArtifact(workspaceId, source.path);
        else await window.desktop.downloadMessageAttachment(workspaceId, source.sessionId, source.id);
        return;
      }
      const displayed = fullImage.current;
      const image = displayed ?? new Image();
      const temporary = displayed ? undefined : imageUrl(await readOriginal());
      try {
        if (temporary) image.src = temporary;
        await image.decode();
        await copyPixels(image);
      } finally { if (temporary) URL.revokeObjectURL(temporary); }
    } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
  }
  const errorNotice = actionError && <span role="alert" className="chat-image-error">{actionError}</span>;
  return <span className="chat-image" ref={frame} data-chat-image={name}>
    <button type="button" className="chat-image-open" aria-label={t('files.zoomName', { name })} title={name}
      onContextMenu={contextMenu} onClick={() => { setActualSize(false); setActionError(''); setExpanded(true); }}>
      {thumbnail ? <img alt={name} src={thumbnail} draggable={false} onError={() => setThumbnail('')} /> : <ImageIcon size={19} aria-hidden="true" />}
    </button>
    {!expanded && errorNotice}
    {expanded && createPortal(<dialog className="chat-image-dialog" ref={dialog} aria-label={t('files.imagePreview', { name })}
      onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}
      onClose={() => { setExpanded(false); setOriginal(''); setLoadError(''); }}>
      <div className="chat-image-dialog-bar"><span>{name}</span>
        <button type="button" className="icon-button" title={t('files.copyImage')} disabled={!original || !!loadError} onClick={() => void act('copy')}><Copy size={17} /></button>
        <button type="button" className="icon-button" title={t('files.downloadImage')} onClick={() => void act('download')}><Download size={17} /></button>
        <button type="button" className="icon-button" autoFocus aria-label={t('files.closeImage')} onClick={() => dialog.current?.close()}><X size={19} /></button>
      </div>
      <div className="chat-image-canvas" data-actual-size={actualSize}>
        {loadError ? <span className="chat-image-status" role="alert">{loadError} <button type="button" className="artifact-link" onClick={() => { dialog.current?.close(); onOpen(); }}>{t('files.viewFile')}</button></span>
          : original ? <button type="button" aria-label={t(actualSize ? 'files.fitWindow' : 'files.actualSize')} title={t(actualSize ? 'files.fitWindow' : 'files.actualSize')} onClick={() => setActualSize(!actualSize)} onContextMenu={contextMenu}>
            <img ref={fullImage} src={original} alt={name} draggable={false} onError={() => setLoadError(t('files.decodeFailed'))} />
          </button> : <span role="status" className="chat-image-status chat-image-loading">
            {thumbnail && <img src={thumbnail} alt="" draggable={false} />}{t('files.loadingOriginal')}
          </span>}
      </div>
      {errorNotice}
    </dialog>, document.body)}
  </span>;
}
