import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { File, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, Folder, Image as ImageIcon, Loader2, Presentation, X, type LucideIcon } from 'lucide-react';
import type { MessageAttachment } from '../shared/types';
import { attachmentKind, type AttachmentCard, type AttachmentChip, type AttachmentKind } from '../shared/attachments';
import { t } from '../shared/i18n';
import { useArtifactScope } from './ArtifactReferenceScope';
import { ImageView, extensionLabel, type Source } from './ChatImage';
import { attachmentEntry } from './attachment-registry';
import { pathBasename } from './artifact-paths';
import type { ChipToken } from './composer-chips';
import { tip } from './Tooltip';
import './attachment-cards.css';

const icons: Record<AttachmentKind, LucideIcon> = {
  image: FileImage, pdf: FileText, code: FileCode, text: FileText, sheet: FileSpreadsheet, slides: Presentation,
  archive: FileArchive, audio: FileAudio, video: FileVideo, folder: Folder, file: File,
};

function kindLabel(name: string, kind: AttachmentKind) {
  return kind === 'folder' ? t('composer.directory') : extensionLabel(name) || t('composer.file');
}

/** A file card's inside: its kind's icon on a tinted tile (a spinner while it uploads), the name and the kind. */
function CardBody({ name, busy }: { name: string; busy?: boolean }) {
  const kind = attachmentKind(name), Icon = icons[kind];
  return <>
    <span className="attachment-card-tile" data-kind={kind}>{busy ? <Loader2 size={17} className="rotating" aria-hidden="true" /> : <Icon size={18} aria-hidden="true" />}</span>
    <span className="attachment-card-text">
      <span className="attachment-card-name">{name}</span>
      <span className="attachment-card-kind">{busy ? t('composer.uploading') : kindLabel(name, kind)}</span>
    </span>
  </>;
}

type OpenPath = (path: string) => void;
type OpenAttachment = (attachment: MessageAttachment) => void;
interface Shown { attachment?: MessageAttachment; path?: string }

/** How an attachment opens as an image: by its transcript id (thumbnail read on its machine), or by path before the transcript has it. */
function imageSource({ attachment, path }: Shown, sessionId?: string): Source | undefined {
  if (attachment) return attachment.image && sessionId ? { id: attachment.id, sessionId, path: attachment.path } : undefined;
  return path && attachmentKind(path) === 'image' ? { path, explicit: true } : undefined;
}
const nameOf = ({ attachment, path }: Shown) => attachment?.name ?? pathBasename(path ?? '');
const openShown = (shown: Shown, onOpenPath: OpenPath, onOpenAttachment: OpenAttachment) =>
  shown.attachment ? onOpenAttachment(shown.attachment) : shown.path && onOpenPath(shown.path);

/** A user message's attachments, each once: images as thumbnails that enlarge, other files as cards that open in the preview. */
export function MessageAttachmentCards({ cards, onOpenPath, onOpenAttachment }: {
  cards: AttachmentCard<MessageAttachment>[]; onOpenPath: OpenPath; onOpenAttachment: OpenAttachment;
}) {
  const scope = useArtifactScope();
  return <div className="attachment-cards" data-attachment-cards="">{cards.map(card => {
    const name = nameOf(card), title = card.path ?? name, source = scope && imageSource(card, scope.sessionId);
    if (scope && source) return <ImageView key={JSON.stringify([card.key, scope.workspaceId, scope.sessionId, card.attachment?.revision, card.path])}
      workspaceId={scope.workspaceId} source={source} name={name} title={title} variant="card"
      preview={card.path ? attachmentEntry(card.path)?.thumbnail : undefined} onOpen={() => openShown(card, onOpenPath, onOpenAttachment)} />;
    return <button type="button" key={card.key} className="attachment-card attachment-card-file" data-attachment-card="file"
      title={t('files.open', { name: title })} onClick={() => openShown(card, onOpenPath, onOpenAttachment)}><CardBody name={name} /></button>;
  })}</div>;
}

/** An attached file named inside the message text: a compact chip (full path on hover) instead of the long path. */
export function AttachmentChipView({ chip, onOpenPath, onOpenAttachment }: {
  chip: AttachmentChip<MessageAttachment>; onOpenPath: OpenPath; onOpenAttachment: OpenAttachment;
}) {
  const scope = useArtifactScope();
  const name = nameOf(chip), source = scope && imageSource(chip, scope.sessionId);
  if (scope && source) return <ImageView workspaceId={scope.workspaceId} source={source} name={name} title={chip.path} variant="chip"
    preview={attachmentEntry(chip.path)?.thumbnail} onOpen={() => openShown(chip, onOpenPath, onOpenAttachment)} />;
  const Icon = icons[attachmentKind(name)];
  return <button type="button" className="attachment-chip" data-attachment-chip={name} title={chip.path}
    onClick={() => openShown(chip, onOpenPath, onOpenAttachment)}>
    <span className="attachment-chip-icon"><Icon size={13} aria-hidden="true" /></span><span className="attachment-chip-name">{name}</span>
  </button>;
}

/** An attached file in the input box: its card above the text and its chips in it. */
export interface ComposerItem {
  key: string; ids: number[]; name: string; path?: string; image: boolean;
  /** Images count 1, 2, … in the order the text first names them. */
  number?: number; thumbnail?: string; uploading?: boolean;
}
const itemLabel = (item: ComposerItem) => item.number !== undefined ? t('composer.imageLabel', { n: item.number }) : item.name;

/** Files waiting in the input box: images as their own thumbnail (a click enlarges it), other files as cards; each can be taken out. */
export function ComposerAttachments({ items, onRemove, onOpen }: { items: ComposerItem[]; onRemove(item: ComposerItem): void; onOpen(item: ComposerItem): void }) {
  if (!items.length) return null;
  return <div className="composer-attachments" role="list" aria-label={t('composer.attachments')}>
    {items.map(item => <ComposerCard key={item.key} item={item} onRemove={() => onRemove(item)} onOpen={() => onOpen(item)} />)}
  </div>;
}

function ComposerCard({ item, onRemove, onOpen }: { item: ComposerItem; onRemove(): void; onOpen(): void }) {
  const [broken, setBroken] = useState('');
  const { name, path, uploading } = item;
  const thumbnail = item.thumbnail && item.thumbnail !== broken ? item.thumbnail : undefined;
  const label = item.number !== undefined ? itemLabel(item) : undefined;
  const picture = thumbnail ? <img src={thumbnail} alt={name} draggable={false} onError={() => setBroken(item.thumbnail ?? '')} />
    : <span className="attachment-card-placeholder"><ImageIcon size={20} aria-hidden="true" /><span>{extensionLabel(name)}</span></span>;
  return <div role="listitem" className={`attachment-card ${item.image ? 'attachment-card-image' : 'attachment-card-file'}`}
    data-attachment-card={item.image ? 'image' : 'file'} data-thumbnail={item.image ? thumbnail ? 'image' : 'icon' : undefined}
    data-state={uploading ? 'uploading' : 'ready'} data-chip-label={label} aria-busy={uploading || undefined}
    {...tip(name, path !== undefined && path !== name && path)}>
    {!item.image ? <CardBody name={name} busy={uploading} />
      : path && !uploading ? <button type="button" className="attachment-card-open" aria-label={t('composer.openImage', { label: label ?? name, name })} onClick={onOpen}>{picture}</button>
      : picture}
    {label && <span className="attachment-card-badge" aria-hidden="true">{label}</span>}
    {uploading && item.image && <span className="attachment-card-busy" role="status" aria-label={t('composer.uploading')}><Loader2 size={18} className="rotating" aria-hidden="true" /></span>}
    {!uploading && <button type="button" className="attachment-card-remove" aria-label={t('composer.removeAttachment', { name })}
      {...tip(t('composer.removeAttachment', { name }))} onClick={onRemove}><X size={12} strokeWidth={2.5} /></button>}
  </div>;
}

/**
 * The chips over the input box's text. A layer laid out exactly like the textarea's
 * text (same font, width and wrapping, scrolled with it; the text itself transparent)
 * puts each chip on the figure spaces its token holds. Only the chips take the pointer:
 * hovering shows the file, a click selects the chip in the text, a double click opens an image.
 */
export function ComposerChipLayer({ text, tokens, chips, selection, inputRef, onPick, onOpen }: {
  text: string; tokens: ChipToken[]; chips: Map<number, ComposerItem>; selection: readonly [number, number];
  inputRef: RefObject<HTMLTextAreaElement | null>; onPick(token: ChipToken): void; onOpen(item: ComposerItem): void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const sync = useCallback(() => {
    const input = inputRef.current, element = layer.current;
    if (!input || !element) return;
    element.style.width = input.clientWidth + 'px';
    if (element.scrollTop !== input.scrollTop) element.scrollTop = input.scrollTop;
  }, [inputRef]);
  useLayoutEffect(sync);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const observer = new ResizeObserver(sync);
    observer.observe(input);
    input.addEventListener('scroll', sync);
    return () => { observer.disconnect(); input.removeEventListener('scroll', sync); };
  }, [inputRef, sync]);
  const parts: ReactNode[] = [];
  let from = 0;
  for (const token of tokens) {
    parts.push(text.slice(from, token.start));
    from = token.end;
    const item = chips.get(token.id);
    if (!item) { parts.push(text.slice(token.start, token.end)); continue; }
    const kind = attachmentKind(item.name), Icon = item.image ? ImageIcon : icons[kind];
    const selected = selection[0] < selection[1] && selection[0] <= token.start && token.end <= selection[1];
    parts.push(<span key={token.start} className="composer-chip" data-selected={selected || undefined}>
      {text.slice(token.start, token.end)}
      <span className="composer-chip-face" data-chip-label={itemLabel(item)} data-chip-path={item.path} data-state={item.uploading ? 'uploading' : 'ready'}
        {...tip(item.name, item.uploading ? t('composer.uploading') : item.path !== item.name && item.path)}
        onMouseDown={event => { event.preventDefault(); onPick(token); }}
        onDoubleClick={() => { if (item.image && item.path && !item.uploading) onOpen(item); }}>
        <span className="composer-chip-icon">{item.uploading ? <Loader2 size={12} className="rotating" aria-hidden="true" />
          : item.thumbnail ? <img src={item.thumbnail} alt="" draggable={false} /> : <Icon size={12} aria-hidden="true" />}</span>
        <span className="composer-chip-label">{itemLabel(item)}</span>
      </span>
    </span>);
  }
  parts.push(text.slice(from) + '\u200b');
  // A wheel turned over a chip scrolls this layer: the textarea follows.
  return <div ref={layer} className="composer-chip-layer" aria-hidden="true"
    onScroll={() => { const input = inputRef.current; if (input && layer.current && input.scrollTop !== layer.current.scrollTop) input.scrollTop = layer.current.scrollTop; }}>
    {parts}
  </div>;
}
