import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { File, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, Folder, Image as ImageIcon, Loader2, Presentation, X, type LucideIcon } from 'lucide-react';
import type { MessageAttachment } from '../shared/types';
import { attachmentKind, type AttachmentKind, type FileRowItem, type MentionChip } from '../shared/attachments';
import { t } from '../shared/i18n';
import { useArtifactScope } from './ArtifactReferenceScope';
import { ImageView, extensionLabel, type Source } from './ChatImage';
import { attachmentEntry } from './attachment-registry';
import { pathBasename, type OpenPath } from './artifact-paths';
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
function CardBody({ name, busy, kind = attachmentKind(name) }: { name: string; busy?: boolean; kind?: AttachmentKind }) {
  const Icon = icons[kind];
  return <>
    <span className="attachment-card-tile" data-kind={kind}>{busy ? <Loader2 size={17} className="rotating" aria-hidden="true" /> : <Icon size={18} aria-hidden="true" />}</span>
    <span className="attachment-card-text">
      <span className="attachment-card-name">{name}</span>
      <span className="attachment-card-kind">{busy ? t('composer.uploading') : kindLabel(name, kind)}</span>
    </span>
  </>;
}

type OpenAttachment = (attachment: MessageAttachment) => void;
interface Shown { attachment?: MessageAttachment; path?: string }

/** How an attachment opens as an image: by its transcript id (thumbnail read on its machine), or by path before the transcript has it. */
function imageSource({ attachment, path }: Shown, sessionId?: string): Source | undefined {
  if (attachment) return attachment.image && sessionId ? { id: attachment.id, sessionId, path: attachment.path } : undefined;
  return path && attachmentKind(path) === 'image' ? { path, explicit: true } : undefined;
}
const nameOf = ({ attachment, path }: Shown) => attachment?.name ?? pathBasename(path ?? '');
/** The kind its icon shows: a folder Claude Code attached as one keeps the folder icon. */
const kindOf = ({ attachment }: Shown, name: string) => attachmentKind(attachment?.directory ? name + '/' : name);
const openShown = (shown: Shown, onOpenPath: OpenPath, onOpenAttachment: OpenAttachment) =>
  shown.attachment ? onOpenAttachment(shown.attachment) : shown.path && onOpenPath(shown.path);

/** The row above a user message's text: its images as thumbnails that enlarge, attached files it does not name as cards that open in the preview. */
export function MessageAttachmentCards({ cards, onOpenPath, onOpenAttachment }: {
  cards: FileRowItem<MessageAttachment>[]; onOpenPath: OpenPath; onOpenAttachment: OpenAttachment;
}) {
  const scope = useArtifactScope();
  return <div className="attachment-cards" data-attachment-cards="">{cards.map(card => {
    const name = nameOf(card), title = card.path ?? name, source = scope && imageSource(card, scope.sessionId);
    if (scope && source) return <ImageView key={JSON.stringify([card.key, scope.workspaceId, scope.sessionId, card.attachment?.revision, card.path])}
      workspaceId={scope.workspaceId} source={source} name={name} title={title} variant="card"
      preview={card.path ? attachmentEntry(card.path)?.thumbnail : undefined} onOpen={() => openShown(card, onOpenPath, onOpenAttachment)} />;
    return <button type="button" key={card.key} className="attachment-card attachment-card-file" data-attachment-card="file"
      title={t('files.open', { name: title })} onClick={() => openShown(card, onOpenPath, onOpenAttachment)}><CardBody name={name} kind={kindOf(card, name)} /></button>;
  })}</div>;
}

/**
 * A file an @-mention in a user message names, in its place: a chip like the
 * input box's (its name, an image's thumbnail) that opens it. Its text is the
 * mention, kept in the page but not drawn (the name is drawn by CSS and is not
 * text), so a selection across it copies the @path.
 */
export function MessageFileChip({ chip, onOpenPath, onOpenAttachment }: {
  chip: MentionChip<MessageAttachment>; onOpenPath: OpenPath; onOpenAttachment: OpenAttachment;
}) {
  const scope = useArtifactScope();
  const name = nameOf(chip), title = chip.attachment?.path ?? chip.path, source = scope && imageSource(chip, scope.sessionId);
  if (scope && source) return <ImageView workspaceId={scope.workspaceId} source={source} name={name} title={title} variant="chip" mention={chip.mention}
    preview={attachmentEntry(chip.path)?.thumbnail} onOpen={() => openShown(chip, onOpenPath, onOpenAttachment)} />;
  const Icon = icons[kindOf(chip, name)];
  return <button type="button" className="attachment-chip" data-attachment-chip={name} data-mention={chip.mention} title={title}
    aria-label={t('files.open', { name: title })} onClick={() => openShown(chip, onOpenPath, onOpenAttachment)}>
    <span className="attachment-chip-icon"><Icon size={13} aria-hidden="true" /></span><ChipText name={name} mention={chip.mention} />
  </button>;
}
/** A chip's name, drawn but not text, then the mention it stands for, text but not drawn (as ImageView's chip). */
const ChipText = ({ name, mention }: { name: string; mention: string }) =>
  <><span className="attachment-chip-name" data-label={name} /><span className="attachment-chip-source">{mention}</span></>;

/** An attached file in the input box: its card above the text and its chips in it. */
export interface ComposerItem {
  key: string; ids: number[]; name: string; path?: string; image: boolean;
  /** The full path shown on hover (a path relative to the folder, joined to it). */
  title?: string; thumbnail?: string; uploading?: boolean;
}

/** Files in the input box, in the order its text names them: images as their own thumbnail (a click enlarges it), other files as cards that open in the preview; each can be taken out. */
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
  const detail = item.title ?? path;
  const picture = thumbnail ? <img src={thumbnail} alt={name} draggable={false} onError={() => setBroken(item.thumbnail ?? '')} />
    : <span className="attachment-card-placeholder"><ImageIcon size={20} aria-hidden="true" /><span>{extensionLabel(name)}</span></span>;
  const openable = !!path && !uploading;
  return <div role="listitem" className={`attachment-card ${item.image ? 'attachment-card-image' : 'attachment-card-file'}`}
    data-attachment-card={item.image ? 'image' : 'file'} data-thumbnail={item.image ? thumbnail ? 'image' : 'icon' : undefined}
    data-state={uploading ? 'uploading' : 'ready'} aria-busy={uploading || undefined}
    {...tip(name, detail !== undefined && detail !== name && detail)}>
    {!item.image ? <CardBody name={name} busy={uploading} /> : !openable ? picture : null}
    {openable && <button type="button" className="attachment-card-open" data-opens={item.image ? 'image' : 'file'}
      aria-label={item.image ? t('composer.openImage', { name }) : t('files.open', { name: detail ?? name })} onClick={onOpen}>{item.image && picture}</button>}
    {uploading && item.image && <span className="attachment-card-busy" role="status" aria-label={t('composer.uploading')}><Loader2 size={18} className="rotating" aria-hidden="true" /></span>}
    {!uploading && <button type="button" className="attachment-card-remove" aria-label={t('composer.removeAttachment', { name })}
      {...tip(t('composer.removeAttachment', { name }))} onClick={onRemove}><X size={12} strokeWidth={2.5} /></button>}
  </div>;
}

/**
 * The chips over the input box's text. A layer laid out exactly like the textarea's
 * text (same font, width and wrapping, scrolled with it; the text itself transparent)
 * puts each chip on the figure spaces its token holds. Only the chips take the pointer:
 * hovering shows the file, a click selects the chip in the text, a double click opens
 * the file (an image larger, another file in the preview).
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
    const detail = item.title ?? item.path;
    parts.push(<span key={token.start} className="composer-chip" data-selected={selected || undefined}>
      {text.slice(token.start, token.end)}
      <span className="composer-chip-face" data-chip-label={item.name} data-chip-path={item.path} data-state={item.uploading ? 'uploading' : 'ready'}
        {...tip(item.name, item.uploading ? t('composer.uploading') : detail !== item.name && detail)}
        onMouseDown={event => { event.preventDefault(); onPick(token); }}
        onDoubleClick={() => { if (item.path && !item.uploading) onOpen(item); }}>
        <span className="composer-chip-icon">{item.uploading ? <Loader2 size={12} className="rotating" aria-hidden="true" />
          : item.thumbnail ? <img src={item.thumbnail} alt="" draggable={false} /> : <Icon size={12} aria-hidden="true" />}</span>
        <span className="composer-chip-label">{item.name}</span>
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
