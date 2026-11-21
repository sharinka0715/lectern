import { execFile } from 'node:child_process';
import { extname, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { THUMB_BYTES, THUMB_EDGE, THUMB_INPUT_BYTES, THUMB_INPUT_PIXELS, pillowThumbnail, thumbnailPreview, thumbnailShell } from '../backend/image-thumbnail';
import type { ArtifactPreview } from '../shared/types';
import type { TranscriptAttachment } from '../core/transcript-attachments';
import { artifactMediaType, isStaticSvg, MEDIA_BYTES, officeExtensions, TEXT_BYTES } from '../backend/artifact-media';
import { extractOfficeText } from '../backend/office-preview';
import { t } from '../shared/i18n';

export function attachmentBytes(attachment: TranscriptAttachment) {
  if (attachment.data === undefined || !attachment.encoding) throw new Error(t('main.attachmentNeedsSource'));
  return Buffer.from(attachment.data, attachment.encoding);
}

// nativeImage decodes PNG/JPEG on every desktop platform, but does not read GIF.
// Only ask it to allocate a bitmap after checking the encoded dimensions.
function nativeDimensions(bytes: Buffer, mime: string) {
  if (mime === 'image/png' && bytes.length >= 33 && bytes.readUInt32BE(8) === 13 && bytes.toString('latin1', 12, 16) === 'IHDR') {
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  if (mime !== 'image/jpeg') return;
  for (let p = 2; p + 4 <= bytes.length;) {
    if (bytes[p++] !== 0xff) return;
    while (bytes[p] === 0xff) p++;
    const marker = bytes[p++];
    if (p + 2 > bytes.length || marker === 0xda || marker === 0xd9) return;
    const n = bytes.readUInt16BE(p);
    if (n < 2 || p + n > bytes.length) return;
    if ([0xc0, 0xc1, 0xc2].includes(marker) && n >= 8) return [bytes.readUInt16BE(p + 5), bytes.readUInt16BE(p + 3)];
    p += n;
  }
}

async function localThumbnail(bytes: Buffer, mime: string): Promise<Buffer> {
  const dims = nativeDimensions(bytes, mime);
  if (dims) {
    const [w, h] = dims;
    if (!w || !h || w * h > THUMB_INPUT_PIXELS) return Buffer.alloc(0);
    // macOS always has sips: keep full-sized image decode off the event loop.
    // Other desktops can still thumbnail PNG/JPEG without any system converter.
    if (process.platform !== 'darwin' && process.versions.electron) {
      const { nativeImage } = await import('electron');
      const image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) return Buffer.alloc(0);
      const { width, height } = image.getSize();
      const ratio = Math.min(1, THUMB_EDGE / Math.max(width, height));
      // Always re-encode, even if the original is small (no raw bytes or metadata).
      return image.resize({ width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) }).toPNG();
    }
  }
  const win = process.platform === 'win32';
  // Embedded data is already local. Never send it back to the workspace, or start
  // the user's SSH connection to decode a transcript attachment.
  return new Promise(resolve => {
    const child = execFile(win ? 'python.exe' : '/bin/sh', win ? ['-I', '-c', pillowThumbnail] : ['-c', `size=${bytes.length}\n${thumbnailShell}`],
      { cwd: parse(tmpdir()).root, encoding: 'buffer', windowsHide: true, timeout: 10_000, maxBuffer: THUMB_BYTES },
      (error, stdout) => resolve(error ? Buffer.alloc(0) : stdout));
    child.stdin?.on('error', () => { /* Missing tool or a rejected image may close stdin early. */ });
    child.stdin?.end(bytes);
  });
}

export class AttachmentThumbnails {
  // Keys contain the transcript's content hash, never the large base64 string.
  // Include in-flight promises and negative results. Keep at most 12 MiB of PNGs.
  private readonly cache = new Map<string, Promise<ArtifactPreview>>();
  constructor(private readonly encode = localThumbnail) {}
  clear() { this.cache.clear(); }
  preview(attachment: TranscriptAttachment): Promise<ArtifactPreview> {
    const { data, encoding, ref } = attachment;
    if (ref.path || data === undefined || !encoding) throw new Error(t('main.attachmentNeedsSource'));
    const key = ref.revision && JSON.stringify([ref.revision, ref.name, encoding]);
    let result = key ? this.cache.get(key) : undefined;
    if (!result) result = (async () => {
      const size = Buffer.byteLength(data, encoding);
      let png: Buffer = Buffer.alloc(0);
      if (ref.image && size && size <= THUMB_INPUT_BYTES) {
        const bytes = attachmentBytes(attachment), mime = artifactMediaType(bytes);
        if (mime?.startsWith('image/')) png = await this.encode(bytes, mime).catch(() => Buffer.alloc(0));
      }
      return thumbnailPreview(ref.name, ref.name, size, png);
    })();
    if (key) {
      if (this.cache.has(key)) this.cache.delete(key);
      else result.catch(() => { if (this.cache.get(key) === result) this.cache.delete(key); });
      this.cache.set(key, result);
      if (this.cache.size > 48) this.cache.delete(this.cache.keys().next().value!);
    }
    return result;
  }
}

export async function attachmentPreview(attachment: TranscriptAttachment): Promise<ArtifactPreview> {
  const { ref, mime } = attachment;
  if (attachment.data === undefined || !attachment.encoding) throw new Error(t('main.attachmentNoPreview'));
  const size = Buffer.byteLength(attachment.data, attachment.encoding);
  const info = { name: ref.name, path: ref.name, mime, size, truncated: false };
  if (size > MEDIA_BYTES) return { ...info, kind: 'binary', truncated: true, notice: t('main.attachmentTooLarge') };
  const data = attachmentBytes(attachment);
  const extension = extname(ref.name).toLowerCase();
  const media = artifactMediaType(data) ?? ((mime === 'image/svg+xml' || extension === '.svg') && isStaticSvg(data) ? 'image/svg+xml' : undefined);
  if (media) return { ...info, kind: media === 'application/pdf' ? 'pdf' : 'image', mime: media, data: new Uint8Array(data) };
  if (officeExtensions.has(extension)) {
    try {
      return { ...info, kind: 'document', mime: 'text/plain', ...await extractOfficeText(ref.name, data) };
    } catch { return { ...info, kind: 'binary', notice: t('main.attachmentNoText') }; }
  }
  if (mime.startsWith('text/') || attachment.encoding === 'utf8' || mime === 'image/svg+xml') {
    const truncated = size > TEXT_BYTES;
    try {
      const text = new TextDecoder('utf8', { fatal: true }).decode(data.subarray(0, TEXT_BYTES), { stream: truncated });
      return { ...info, kind: mime === 'text/markdown' ? 'markdown' : 'text', text, truncated };
    } catch { /* Preserve bytes for download when the claimed text encoding is invalid. */ }
  }
  return { ...info, kind: 'binary' };
}
