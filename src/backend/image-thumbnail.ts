import type { ArtifactPreview } from '../shared/types';
import { quoteShell } from './transport';
import { t } from '../shared/i18n';

export const THUMB_EDGE = 240;
export const THUMB_BYTES = 256 * 1024;
export const THUMB_INPUT_BYTES = 32 * 1024 * 1024;
export const THUMB_INPUT_PIXELS = 16 * 1024 * 1024;

// Restrict the decoder, not just the filename: in particular, never hand PDF,
// SVG or a URL to a tool which might follow references or run a delegate.
export const pillowThumbnail = `import io, sys
from PIL import Image, ImageOps
Image.MAX_IMAGE_PIXELS = ${THUMB_INPUT_PIXELS}
with Image.open(sys.stdin.buffer, formats=('PNG','JPEG','GIF','WEBP','BMP','ICO','AVIF')) as im:
    if im.width * im.height > Image.MAX_IMAGE_PIXELS: sys.exit(1)
    frame = im.convert('RGBA')
    frame.thumbnail((${THUMB_EDGE}, ${THUMB_EDGE}), Image.LANCZOS)
    frame = ImageOps.exif_transpose(frame)
    frame.info.clear()
    out = io.BytesIO()
    frame.save(out, format='PNG')
    if out.tell() <= ${THUMB_BYTES}: sys.stdout.buffer.write(out.getvalue())`;

/** stdin is either the verified target descriptor or an explicitly supplied local attachment.
 * Only a freshly encoded first frame may leave stdout; no converter means no body. */
export const thumbnailShell = `(
cd / || exit 1
ulimit -t 8
if [ -x /usr/bin/sips ] && [ "$(uname -s)" = Darwin ]; then
  umask 077
  dir=$(mktemp -d /tmp/lectern-thumb.XXXXXXXX) || exit 1
  trap 'rm -rf "$dir"' 0
  trap 'exit 1' HUP INT TERM
  # ImageIO needs a named, seekable input. Never reopen the workspace path.
  head -c "$size" > "$dir/input" || exit 1
  sig=$(od -An -tx1 -N12 "$dir/input" | tr -d ' \\n')
  case "$sig" in 89504e470d0a1a0a*|ffd8ff*|474946383761*|474946383961*|52494646????????57454250|424d*|00000100*) ;; *) exit 0;; esac
  props=$(/usr/bin/sips -g format -g pixelWidth -g pixelHeight "$dir/input" 2>/dev/null) || exit 0
  fit=$(printf '%s\\n' "$props" | awk '$1=="format:"{f=$2} $1=="pixelWidth:"{w=$2} $1=="pixelHeight:"{h=$2} END{if (f ~ /^(png|jpeg|gif|webp|bmp|ico)$/ && w ~ /^[0-9]+$/ && h ~ /^[0-9]+$/ && w*h>0 && w*h<=${THUMB_INPUT_PIXELS}) print (w+0>${THUMB_EDGE} || h+0>${THUMB_EDGE}) ? "scale" : "keep"}')
  case "$fit" in scale) set -- -Z ${THUMB_EDGE};; keep) set --;; *) exit 0;; esac
  /usr/bin/sips "$@" -s format png "$dir/input" --out "$dir/thumb.png" >/dev/null 2>&1 || exit 0
  [ -f "$dir/thumb.png" ] && [ "$(wc -c < "$dir/thumb.png")" -le ${THUMB_BYTES} ] || exit 0
  head -c ${THUMB_BYTES} "$dir/thumb.png"
elif command -v python3 >/dev/null 2>&1; then
  python3 -I -c ${quoteShell(pillowThumbnail)} 2>/dev/null || :
fi
)`;

/** Check both wire and pixel budgets before exposing anything to the renderer.
 * Drop ancillary chunks (profiles/text/animation); thumbnails contain only pixels. */
export function thumbnailPreview(path: string, name: string, size: number, bytes: Buffer): ArtifactPreview {
  const base = { path, name, size, truncated: false };
  const fallback: ArtifactPreview = { ...base, kind: 'binary', mime: 'application/octet-stream', notice: t('artifacts.thumbnailFailed') };
  if (bytes.length < 45 || bytes.length > THUMB_BYTES || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return fallback;
  const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
  if (!w || !h || w > THUMB_EDGE || h > THUMB_EDGE) return fallback;
  const chunks = [bytes.subarray(0, 33)];
  let pixels = false;
  for (let i = 33; i + 12 <= bytes.length;) {
    const end = i + 12 + bytes.readUInt32BE(i), type = bytes.toString('latin1', i + 4, i + 8);
    if (end > bytes.length) break;
    if (type === 'IDAT') pixels = true;
    if (['PLTE', 'tRNS', 'IDAT', 'IEND'].includes(type)) chunks.push(bytes.subarray(i, end));
    if (type === 'IEND' && end === i + 12 && end === bytes.length && pixels) {
      return { ...base, kind: 'image', mime: 'image/png', data: new Uint8Array(Buffer.concat(chunks)) };
    }
    i = end;
  }
  return fallback;
}

/** Finished thumbnails (and failures) by file, valid while the file's stamp
 * (size, device, inode, mode, mtime and ctime) is unchanged: an unchanged image
 * is neither decoded nor sent again. At most `limit` entries of ≤ THUMB_BYTES each. */
export class ThumbnailCache {
  private readonly entries = new Map<string, { stamp: string; preview: ArtifactPreview }>();
  constructor(private readonly limit = 48) {}
  get(key: string) { return this.entries.get(key); }
  set(key: string, stamp: string, preview: ArtifactPreview) {
    this.entries.delete(key);
    this.entries.set(key, { stamp, preview });
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }
  clear() { this.entries.clear(); }
}
