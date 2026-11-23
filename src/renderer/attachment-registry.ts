import { attachmentKind, isUploadedAttachment, mentionFor } from '../shared/attachments';
import { pathBasename } from './artifact-paths';

/**
 * Files this window attached through the input box, by the path Claude Code is
 * sent: the card's name and a small thumbnail made here from the file itself.
 * The draft keeps only @-mentions; this tells which of them are attachments
 * (uploads are recognized by their path even without an entry).
 */
interface Entry { name: string; thumbnail?: string }
const entries = new Map<string, Entry>();
const limit = 200;

export function rememberAttachment(path: string, entry: Entry) {
  const old = entries.get(path);
  if (old?.thumbnail && old.thumbnail !== entry.thumbnail) URL.revokeObjectURL(old.thumbnail);
  entries.delete(path);
  entries.set(path, entry);
  for (const [key, value] of entries) {
    if (entries.size <= limit) break;
    if (value.thumbnail) URL.revokeObjectURL(value.thumbnail);
    entries.delete(key);
  }
}

export const attachmentEntry = (path: string) => entries.get(path);
export const isAttachedPath = (path: string) => entries.has(path) || isUploadedAttachment(path);

/**
 * What each chip in the input box's text stands for (see composer-chips.ts): an
 * @-mention as written, or a file still uploading (no mention yet; `thumbnail`
 * until its path has an entry above). Ids are never reused in this window, so
 * a chip brought back by undo still finds its file.
 */
export interface Chip { name: string; mention?: string; path?: string; thumbnail?: string; state?: 'uploading' | 'failed' }
const chips = new Map<number, Chip>(), chipIds = new Map<string, number>();
let nextChip = 1;
const chipLimit = 2000;

function addChip(chip: Chip) {
  const id = nextChip++;
  chips.set(id, chip);
  for (const [old, entry] of chips) {
    if (chips.size <= chipLimit) break;
    chips.delete(old);
    if (entry.mention !== undefined && chipIds.get(entry.mention) === old) chipIds.delete(entry.mention);
  }
  return id;
}
/** The chip of a mention as written (`@path` or `@"path"`). */
export function chipFor(mention: string, path: string) {
  const known = chipIds.get(mention);
  if (known !== undefined && chips.has(known)) return known;
  const id = addChip({ name: pathBasename(path), mention, path });
  chipIds.set(mention, id);
  return id;
}
/** A chip for a file that is still being uploaded. */
export const uploadingChip = (name: string) => addChip({ name, state: 'uploading' });
export const chipEntry = (id: number) => chips.get(id);
export const knownChip = (id: number) => chips.has(id);
/** The mention a chip sends; nothing while its file is uploading or after the upload failed. */
export const chipMention = (id: number) => chips.get(id)?.mention;
/** An uploaded file's chip now stands for its path; the same mention typed or pasted later finds this chip. */
export function settleChip(id: number, path: string) {
  const mention = mentionFor(path);
  updateChip(id, { mention, path, state: undefined });
  if (!chipIds.has(mention)) chipIds.set(mention, id);
}
export function updateChip(id: number, change: Partial<Chip>) {
  const chip = chips.get(id);
  if (chip) chips.set(id, { ...chip, ...change });
}

/** A small PNG of an image file (its short side 128 px at most), as a blob URL; nothing for other files. */
export async function localThumbnail(file: File): Promise<string | undefined> {
  if (!file.type.startsWith('image/') && attachmentKind(file.name) !== 'image') return;
  if (file.size > 32 * 1024 * 1024) return;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    if (!width || !height || width * height > 16 * 1024 * 1024) return;
    const scale = Math.min(1, 128 / Math.min(width, height), 512 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    canvas.width = canvas.height = 0;
    return blob ? URL.createObjectURL(blob) : undefined;
  } catch {
    return undefined;
  } finally { bitmap?.close(); }
}
