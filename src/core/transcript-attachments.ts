import { createHash } from 'node:crypto';
import { joinList, t } from '../shared/i18n';
import type { MessageAttachment } from '../shared/types';
import type { JsonRecord } from './jsonl';

export interface TranscriptAttachment {
  ref: MessageAttachment;
  blockIndex: number;
  mime: string;
  data?: string;
  encoding?: 'base64' | 'utf8';
}

const imageTypes = new Map([
  ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/gif', 'gif'], ['image/webp', 'webp'],
  ['image/bmp', 'bmp'], ['image/avif', 'avif'],
]);

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}
function nameFor(value: unknown) {
  if (typeof value === 'string') return value.split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f<>:"|?*]/g, '_').slice(0, 180);
}

/** Keep the large native body in the transcript reader. Only the small reference travels with snapshots. */
export function transcriptAttachments(key: string, blocks: JsonRecord[]): TranscriptAttachment[] {
  const result: TranscriptAttachment[] = [];
  function collect(block: JsonRecord, blockIndex: number) {
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      for (const item of block.content) {
        const child = record(item);
        if (child.type !== 'tool_result') collect(child, blockIndex);
      }
      return;
    }
    if (!['image', 'document', 'file', 'directory', 'pdf_reference', 'selected_lines', 'resource', 'resource_link', 'file_reference'].includes(String(block.type))) return;
    const source = record(block.source);
    const uri = block.uri ?? record(block.resource).uri ?? source.url;
    let path = block.filePath ?? block.file_path ?? block.path ?? source.path ?? block.directoryPath ??
      (source.data === undefined ? block.filename ?? block.relativePath : undefined);
    if (!path && typeof uri === 'string' && /^file:\/\//i.test(uri)) {
      try {
        const url = new URL(uri);
        if (!url.hostname || url.hostname === 'localhost') path = decodeURIComponent(url.pathname);
      } catch { /* Unsupported or invalid native URL. */ }
    }
    const id = `${key}:attachment:${result.length}`;
    const mime = typeof source.media_type === 'string' ? source.media_type.toLowerCase() : 'application/octet-stream';
    const image = block.type === 'image' || mime.startsWith('image/');
    if (typeof path === 'string' && path && !/[\u0000-\u001f]/.test(path)) {
      const preview = image || (block.type !== 'directory' && /\.(png|jpe?g|gif|webp|bmp|avif|ico|svg)$/i.test(path));
      result.push({ ref: { id, name: nameFor(path) || path, path, ...(preview && { image: true }), ...(block.type === 'directory' && { directory: true }) }, blockIndex, mime });
    } else {
      const embedded = (source.type === 'base64' || source.type === 'text') && typeof source.data === 'string' ? source.data : undefined;
      if (embedded === undefined) return;
      const ext = imageTypes.get(mime) ?? (mime === 'application/pdf' ? 'pdf' : mime.startsWith('text/') ? 'txt' : 'bin');
      const name = nameFor(block.filename) || nameFor(block.title) || `${t(block.type === 'image' ? 'core.image' : 'core.attachment')}-${result.length + 1}.${ext}`;
      const revision = image && key ? createHash('sha256').update(mime).update(embedded).digest('hex') : undefined;
      result.push({ ref: { id, name, ...(image && { image: true }), ...(revision && { revision }) }, blockIndex, mime,
        data: embedded, encoding: source.type === 'base64' ? 'base64' : 'utf8' });
    }
  }
  blocks.forEach(collect);
  return result;
}

