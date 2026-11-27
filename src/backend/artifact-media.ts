import { SaxesParser } from 'saxes';

export const TEXT_BYTES = 256 * 1024;
export { LARGE_TEXT_BYTES, TEXT_OPEN_BYTES } from '../shared/preview-limits';
/** What a preview reads of a text file over TEXT_OPEN_BYTES before the user opens it: enough to tell text from the rest. */
export const SNIFF_BYTES = 64 * 1024;
export const MEDIA_BYTES = 12 * 1024 * 1024;
export const officeExtensions = new Set(['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp']);
export const mediaExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.pdf']);
/** Audio and video are read whole like images, under a larger bound, then played from memory. */
export const AV_BYTES = 64 * 1024 * 1024;
export const avExtensions = new Set(['.mp4', '.m4v', '.mov', '.webm', '.ogv', '.mkv', '.mp3', '.wav', '.ogg', '.oga', '.opus', '.m4a', '.aac', '.flac']);

/** Containers Chromium can play, identified from the file's own header; the extension only settles Ogg and MPEG audio. */
export function avMediaType(bytes: Buffer, ext: string): string | undefined {
  const prefix = bytes.subarray(0, 12).toString('latin1');
  if (bytes.length >= 12 && prefix.slice(4, 8) === 'ftyp') {
    const brand = prefix.slice(8, 12);
    if (/^M4[AB] $/.test(brand)) return 'audio/mp4';
    if (brand === 'qt  ') return 'video/quicktime';
    if (/^(?:isom|iso[2-9]|mp4[12]|avc1|M4V[ P]|dash|mmp4|3gp[4-6]|3g2[abc])$/.test(brand)) return ext === '.m4a' ? 'audio/mp4' : 'video/mp4';
    return;
  }
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3) {
    const header = bytes.subarray(0, 64).toString('latin1');
    return header.includes('webm') ? 'video/webm' : header.includes('matroska') ? 'video/x-matroska' : undefined;
  }
  if (prefix.startsWith('OggS')) return ext === '.ogv' ? 'video/ogg' : 'audio/ogg';
  if (prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WAVE') return 'audio/wav';
  if (prefix.startsWith('fLaC')) return 'audio/flac';
  if (prefix.startsWith('ID3')) return ext === '.aac' ? 'audio/aac' : 'audio/mpeg';
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    const layer = bytes[1] & 0x06;
    if (ext === '.mp3' && layer) return 'audio/mpeg';
    if (ext === '.aac' && !layer) return 'audio/aac';
  }
}

export function artifactMediaType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  const prefix = bytes.subarray(0, 12).toString('latin1');
  if (/^GIF8[79]a/.test(prefix)) return 'image/gif';
  if (prefix.startsWith('RIFF') && prefix.endsWith('WEBP')) return 'image/webp';
  if (bytes.length >= 14 && prefix.startsWith('BM') && bytes.readUInt32LE(10) >= 14) return 'image/bmp';
  if (bytes.length >= 22 && bytes.readUInt32LE(0) === 0x10000 && bytes.readUInt16LE(4) > 0) return 'image/x-icon';
  if (bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const end = Math.min(bytes.length, bytes.readUInt32BE(0), 256);
    for (let at = 8; at + 4 <= end; at += 4) {
      if (at !== 12 && /^avi[fs]$/.test(bytes.toString('ascii', at, at + 4))) return 'image/avif';
    }
  }
  if (prefix.startsWith('%PDF-')) return 'application/pdf';
}

const elements = new Set('svg g defs path rect circle ellipse line polyline polygon text tspan linearGradient radialGradient stop clipPath title desc'.split(' '));
const attributes = new Set('id class version width height x y dx dy x1 y1 x2 y2 cx cy r rx ry fx fy d points viewBox preserveAspectRatio transform opacity fill-opacity fill-rule stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset stroke-opacity clip-rule font-family font-size font-style font-weight text-anchor dominant-baseline gradientUnits gradientTransform offset stop-opacity'.split(' '));
const paint = new Set(['fill', 'stroke', 'color', 'stop-color']);
const fragment = /^url\(\s*#[A-Za-z_][\w.-]*\s*\)$/;
const color = /^(?:#[0-9a-f]{3,8}|[a-z]+|(?:rgb|hsl)a?\([0-9.,%\s+\-/]+\))$/i;

/** Accept only fully parsed static SVG. Other SVG remains viewable as escaped source text. */
export function isStaticSvg(bytes: Buffer): boolean {
  if (!bytes.length || bytes.length > TEXT_BYTES) return false;
  let root = false, count = 0, depth = 0;
  const reject = () => { throw new Error('SVG requires source preview'); };
  try {
    const parser = new SaxesParser({ xmlns: true });
    parser.on('doctype', reject);
    parser.on('processinginstruction', reject);
    parser.on('xmldecl', declaration => {
      if (declaration.encoding && !/^utf-8$/i.test(declaration.encoding)) reject();
    });
    parser.on('opentag', tag => {
      if (++count > 10000 || ++depth > 64 || tag.prefix || tag.uri !== 'http://www.w3.org/2000/svg' || !elements.has(tag.local)) reject();
      if (!root && tag.local !== 'svg') reject();
      root = true;
      for (const attr of Object.values(tag.attributes)) {
        if (attr.name === 'xmlns' && attr.value === 'http://www.w3.org/2000/svg') continue;
        if (attr.prefix || attr.uri) reject();
        if (paint.has(attr.name)) {
          if (!color.test(attr.value) && !fragment.test(attr.value)) reject();
        } else if (attr.name === 'clip-path') {
          if (!fragment.test(attr.value) && attr.value !== 'none') reject();
        } else if (!attributes.has(attr.name)) reject();
      }
    });
    parser.on('closetag', () => { depth--; });
    parser.write(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).close();
    return root;
  } catch { return false; }
}
