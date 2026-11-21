import { File, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, Folder, Loader2, Presentation, X, type LucideIcon } from 'lucide-react';
import type { MessageAttachment } from '../shared/types';
import { attachmentKind, type AttachmentCard, type AttachmentChip, type AttachmentKind } from '../shared/attachments';
import { t } from '../shared/i18n';
import { useArtifactScope } from './ArtifactReferenceScope';
import { ImageView, extensionLabel, type Source } from './ChatImage';
import { attachmentEntry } from './attachment-registry';
import { pathBasename } from './artifact-paths';
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

export interface UploadCard { key: string; name: string; thumbnail?: string }

/** Files waiting in the input box: images as their own thumbnail, other files as cards; each can be taken out. */
export function ComposerAttachments({ files, uploads, onRemove }: { files: string[]; uploads: UploadCard[]; onRemove(path: string): void }) {
  if (!files.length && !uploads.length) return null;
  return <div className="composer-attachments" role="list" aria-label={t('composer.attachments')}>
    {files.map(path => {
      const entry = attachmentEntry(path);
      return <ComposerCard key={path} name={entry?.name ?? pathBasename(path)} title={path} thumbnail={entry?.thumbnail} onRemove={() => onRemove(path)} />;
    })}
    {uploads.map(upload => <ComposerCard key={upload.key} name={upload.name} thumbnail={upload.thumbnail} uploading />)}
  </div>;
}

function ComposerCard({ name, title, thumbnail, uploading, onRemove }: { name: string; title?: string; thumbnail?: string; uploading?: boolean; onRemove?: () => void }) {
  const image = !!thumbnail;
  return <div role="listitem" className={`attachment-card ${image ? 'attachment-card-image' : 'attachment-card-file'}`}
    data-attachment-card={image ? 'image' : 'file'} data-thumbnail={image ? 'image' : undefined} data-state={uploading ? 'uploading' : 'ready'} aria-busy={uploading || undefined}
    {...tip(name, title !== name && title)}>
    {image ? <img src={thumbnail} alt={name} draggable={false} /> : <CardBody name={name} busy={uploading} />}
    {uploading && image && <span className="attachment-card-busy" role="status" aria-label={t('composer.uploading')}><Loader2 size={18} className="rotating" aria-hidden="true" /></span>}
    {onRemove && <button type="button" className="attachment-card-remove" aria-label={t('composer.removeAttachment', { name })}
      {...tip(t('composer.removeAttachment', { name }))} onClick={onRemove}><X size={12} strokeWidth={2.5} /></button>}
  </div>;
}
