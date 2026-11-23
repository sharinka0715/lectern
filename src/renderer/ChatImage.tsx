import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Download, Image as ImageIcon, ImageOff, X } from 'lucide-react';
import { showContextMenu } from './ContextMenu';
import type { ArtifactPreview, MessageAttachment } from '../shared/types';
import { useArtifactResolution, useArtifactScope } from './ArtifactReferenceScope';
import { queueThumbnail } from './thumbnail-queue';
import { t } from '../shared/i18n';

/** A file's extension as a short label (`PNG`), or nothing. */
export function extensionLabel(name: string) {
  return /\.([a-z0-9]{1,5})$/i.exec(name)?.[1].toUpperCase() ?? '';
}

/** A workspace image by path (`explicit`: an attached file, read only when the user opens it), or a
 * transcript attachment by id (with `path` when it was attached by path: opened and saved from there). */
export type Source = { path: string; explicit?: boolean } | { id: string; sessionId: string; path?: string };
type ImageAction = 'copy' | 'download';
/** `inline`: the chat's own thumbnail; `card`: an attachment card above a user message; `chip`: a file named inside its text. */
export type ImageVariant = 'inline' | 'card' | 'chip';

export function AttachmentImage({ attachment, onOpen }: { attachment: MessageAttachment; onOpen: (attachment: MessageAttachment) => void }) {
  const scope = useArtifactScope();
  if (!scope?.sessionId) return attachment.path ? <WorkspaceImage name={attachment.name} path={attachment.path} explicit onOpen={() => onOpen(attachment)} />
    : <span>{attachment.name}</span>;
  // An image attached by path is thumbnailed on its machine like the activity card's, inside the folder or not.
  return <ImageView key={JSON.stringify([scope.workspaceId, scope.sessionId, attachment.id, attachment.revision, attachment.path])}
    workspaceId={scope.workspaceId} source={{ id: attachment.id, sessionId: scope.sessionId, path: attachment.path }} name={attachment.name}
    title={attachment.path} onOpen={() => onOpen(attachment)} />;
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

/** An error as the user should read it, without Electron's "Error invoking remote method" wrapper. */
const readable = (error: unknown) => (error instanceof Error ? error.message : String(error))
  .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

/** Copies the image shown (or, with none, the original read now) to the clipboard. */
async function copyImage(shown: HTMLImageElement | null, readOriginal: () => Promise<ArtifactPreview>) {
  const image = shown ?? new Image();
  const temporary = shown ? undefined : imageUrl(await readOriginal());
  try {
    if (temporary) image.src = temporary;
    await image.decode();
    await copyPixels(image);
  } finally { if (temporary) URL.revokeObjectURL(temporary); }
}

/**
 * An image's original in a modal over the window: fitted to it (a click shows the
 * actual size), with copy and download. Esc, the close button or a click beside the
 * image closes it and focus goes back where it was. The thumbnail shows while the
 * original loads; when it cannot be read or decoded the reason and "View file" show instead.
 */
export function ImagePreviewDialog({ name, thumbnail, readOriginal, download, onViewFile, onClose }: {
  name: string; thumbnail?: string; readOriginal: () => Promise<ArtifactPreview>; download: () => Promise<unknown>;
  onViewFile: () => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const fullImage = useRef<HTMLImageElement>(null);
  const [original, setOriginal] = useState('');
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [actualSize, setActualSize] = useState(false);
  useLayoutEffect(() => { if (dialog.current && !dialog.current.open) dialog.current.showModal(); }, []);
  useEffect(() => {
    let retired = false, url: string | undefined;
    void readOriginal().then(preview => {
      if (retired) return;
      url = imageUrl(preview);
      setOriginal(url);
    }).catch(error => { if (!retired) setLoadError(readable(error)); });
    return () => { retired = true; if (url) URL.revokeObjectURL(url); };
  }, [readOriginal]);
  async function act(action: ImageAction) {
    setActionError('');
    try {
      if (action === 'download') await download();
      else await copyImage(fullImage.current, readOriginal);
    } catch (error) { setActionError(readable(error)); }
  }
  function contextMenu(event: MouseEvent) {
    showContextMenu(event, [
      { label: t('files.copyImage'), icon: <Copy size={14} />, onSelect: () => act('copy') },
      { label: t('files.downloadImage'), icon: <Download size={14} />, onSelect: () => act('download') },
    ], t('files.imageActions'));
  }
  return createPortal(<dialog className="chat-image-dialog" ref={dialog} aria-label={t('files.imagePreview', { name })}
    onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}
    onClose={onClose}>
    <div className="chat-image-dialog-bar"><span>{name}</span>
      <button type="button" className="icon-button" title={t('files.copyImage')} disabled={!original || !!loadError} onClick={() => void act('copy')}><Copy size={17} /></button>
      <button type="button" className="icon-button" title={t('files.downloadImage')} onClick={() => void act('download')}><Download size={17} /></button>
      <button type="button" className="icon-button" autoFocus aria-label={t('files.closeImage')} onClick={() => dialog.current?.close()}><X size={19} /></button>
    </div>
    <div className="chat-image-canvas" data-actual-size={actualSize}>
      {loadError ? <span className="chat-image-status chat-image-failed" role="alert"><ImageOff size={40} aria-hidden="true" />
        <span>{loadError} <button type="button" className="artifact-link" onClick={() => { dialog.current?.close(); onViewFile(); }}>{t('files.viewFile')}</button></span></span>
        : original ? <button type="button" aria-label={t(actualSize ? 'files.fitWindow' : 'files.actualSize')} title={t(actualSize ? 'files.fitWindow' : 'files.actualSize')} onClick={() => setActualSize(!actualSize)} onContextMenu={contextMenu}>
          <img ref={fullImage} src={original} alt={name} draggable={false} onError={() => setLoadError(t('files.decodeFailed'))} />
        </button> : <span role="status" className="chat-image-status chat-image-loading">
          {thumbnail && <img src={thumbnail} alt="" draggable={false} />}{t('files.loadingOriginal')}
        </span>}
    </div>
    {actionError && <span role="alert" className="chat-image-error">{actionError}</span>}
  </dialog>, document.body);
}

export function ImageView({ workspaceId, source, name, onOpen, variant = 'inline', title, preview }: {
  workspaceId: string; source: Source; name: string; onOpen: () => void;
  variant?: ImageVariant; title?: string;
  /** A thumbnail the caller already has (and owns), shown until this view reads its own. */
  preview?: string;
}) {
  const frame = useRef<HTMLSpanElement>(null);
  const [thumbnail, setThumbnail] = useState('');
  const [actionError, setActionError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const path = source.path;
  const id = 'id' in source ? source.id : undefined;
  const sessionId = 'id' in source ? source.sessionId : undefined;
  // Attached files may sit outside the folder: their originals are read like a file the user opens.
  const explicit = 'id' in source ? path !== undefined : !!source.explicit;
  const readOriginal = useCallback(() => path !== undefined && explicit ? window.desktop.previewArtifact(workspaceId, path)
    : path !== undefined && id === undefined ? window.desktop.previewInlineImage(workspaceId, path)
    : window.desktop.previewMessageAttachment(workspaceId, sessionId!, id!), [workspaceId, path, sessionId, id, explicit]);
  const download = useCallback(() => path === undefined && id !== undefined ? window.desktop.downloadMessageAttachment(workspaceId, sessionId!, id)
    : window.desktop.downloadArtifact(workspaceId, path!), [workspaceId, path, sessionId, id]);

  useEffect(() => {
    let retired = false, url: string | undefined, cancel: (() => void) | undefined;
    const observer = new IntersectionObserver(entries => {
      if (retired) return;
      if (!entries.at(-1)?.isIntersecting) { cancel?.(); cancel = undefined; return; }
      cancel ??= queueThumbnail(async () => {
        observer.disconnect();
        try {
          const result = id === undefined ? await window.desktop.previewInlineImageThumbnail(workspaceId, path!)
            : await window.desktop.previewMessageAttachmentThumbnail(workspaceId, sessionId!, id);
          if (retired) return;
          url = imageUrl(result);
          setThumbnail(url);
        } catch { /* 单张图片失败不影响文字或后续缩略图。 */ }
      });
    }, { root: frame.current?.closest('.conversation-scroll') });
    observer.observe(frame.current!);
    return () => { retired = true; cancel?.(); observer.disconnect(); if (url) URL.revokeObjectURL(url); };
  }, [workspaceId, path, sessionId, id]);

  function contextMenu(event: MouseEvent) {
    showContextMenu(event, [
      { label: t('files.copyImage'), icon: <Copy size={14} />, onSelect: () => act('copy') },
      { label: t('files.downloadImage'), icon: <Download size={14} />, onSelect: () => act('download') },
      !expanded && { label: t('files.zoom'), icon: <ImageIcon size={14} />, onSelect: () => { setActionError(''); setExpanded(true); } },
    ], t('files.imageActions'));
  }
  async function act(action: ImageAction) {
    setActionError('');
    try {
      if (action === 'download') await download();
      else await copyImage(null, readOriginal);
    } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
  }
  const errorNotice = actionError && <span role="alert" className="chat-image-error">{actionError}</span>;
  const shown = thumbnail || (!previewFailed && preview) || '';
  const image = shown && <img alt={name} src={shown} draggable={false} onError={() => thumbnail ? setThumbnail('') : setPreviewFailed(true)} />;
  const zoom = { 'aria-label': t('files.zoomName', { name }), title: title ?? name, onContextMenu: contextMenu,
    onClick: () => { setActionError(''); setExpanded(true); } };
  const frameProps = variant === 'card' ? { className: 'attachment-card attachment-card-image', 'data-attachment-card': 'image', 'data-thumbnail': shown ? 'image' : 'icon' }
    : variant === 'chip' ? { className: 'attachment-chip-frame', 'data-attachment-chip': name, 'data-thumbnail': shown ? 'image' : 'icon' }
    : { className: 'chat-image', 'data-chat-image': name };
  return <span ref={frame} {...frameProps}>
    {variant === 'card' ? <button type="button" className="attachment-card-open" {...zoom}>
      {image || <span className="attachment-card-placeholder"><ImageIcon size={20} aria-hidden="true" /><span>{extensionLabel(name)}</span></span>}
    </button> : variant === 'chip' ? <button type="button" className="attachment-chip" {...zoom}>
      <span className="attachment-chip-icon">{image || <ImageIcon size={13} aria-hidden="true" />}</span><span className="attachment-chip-name">{name}</span>
    </button> : <button type="button" className="chat-image-open" {...zoom}>
      {image || <ImageIcon size={19} aria-hidden="true" />}
    </button>}
    {!expanded && errorNotice}
    {expanded && <ImagePreviewDialog name={name} thumbnail={shown} readOriginal={readOriginal} download={download}
      onViewFile={onOpen} onClose={() => setExpanded(false)} />}
  </span>;
}
