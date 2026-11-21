import { attachmentKind, isUploadedAttachment } from '../shared/attachments';

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
