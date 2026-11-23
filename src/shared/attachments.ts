// Files pasted or dropped into the composer become @-mentions of a path on the
// conversation's machine.

export const maxAttachmentBytes = 100 * 1024 * 1024;

/** The composer's @-mention for a path, quoted like @-completion when needed. */
export function mentionFor(path: string): string {
  return /^[\p{L}\p{N}\p{M}_./~-]+$/u.test(path) ? '@' + path : `@"${path}"`;
}

/**
 * Whether a paste carrying files should attach them. Copied spreadsheet cells
 * or rich text often carry a picture of themselves as well: with text present
 * and no file from disk, the text is what the user meant.
 */
export function pasteAttaches(files: number, paths: string[], text: string): boolean {
  if (!files) return false;
  return paths.some(Boolean) || !text.trim();
}

/** An @-mention in text: `@path` or `@"path with spaces"`, at the start or after whitespace. */
export interface Mention { start: number; end: number; path: string }
export function findMentions(text: string): Mention[] {
  const result: Mention[] = [];
  for (const match of text.matchAll(/(^|\s)@(?:"([^"\n]+)"|([^\s"]+))/gu)) {
    const start = match.index + match[1].length;
    result.push({ start, end: match.index + match[0].length, path: match[2] ?? match[3] });
  }
  return result;
}

/** A file the composer copied to its machine: `<tmp>/lectern-attachments-<uid>/<8 characters>/<name>`. */
export function isUploadedAttachment(path: string): boolean {
  return /\/lectern-attachments-\d+\/[A-Za-z0-9]{8}\/[^/]+$/.test(path);
}

/** Whether a mention (as typed, maybe relative) names an attachment's recorded path (absolute, maybe resolved). */
export function samePath(recorded: string, mentioned: string): boolean {
  // macOS: /var and /tmp are /private/var and /private/tmp.
  const plain = (path: string) => path.replace(/^\/private(?=\/(?:var|tmp|etc)\/)/, '');
  const a = plain(recorded), b = plain(mentioned).replace(/^\.\//, '');
  if (a === b) return true;
  if (b.startsWith('~/')) return a.endsWith(b.slice(1));
  return !b.startsWith('/') && !!b && a.endsWith('/' + b);
}

interface AttachmentLike { id: string; path?: string; image?: true; directory?: true }
/** A file an @-mention names, shown in its place as a chip; `mention` is the text it stands for (and copies as). */
export interface MentionChip<T> { start: number; end: number; path: string; mention: string; attachment?: T }
/** A file in the row above a user message's text. */
export interface FileRowItem<T> { key: string; path?: string; attachment?: T }

/**
 * How a user message shows its files, like the input box it was written in:
 * every @-mention of a known file stays where it is as a chip (copied as the
 * mention). Above the text, a row shows each image named in it once, in the
 * order the text names them, and every attached file the text does not name;
 * a file named in the text is not repeated there as a card (its chip already
 * says it). A mention counts when the transcript recorded its file, or when
 * `known` says so (a Lectern attachment, a file the reference check found).
 * Images embedded in the message keep their own place in the text.
 */
export function messageFileLayout<T extends AttachmentLike>(text: string, attachments: readonly T[], known: (path: string) => boolean) {
  const files = attachments.filter(file => file.path || !file.image);
  const chips: MentionChip<T>[] = [];
  for (const mention of findMentions(text)) {
    const attachment = files.find(file => file.path && samePath(file.path, mention.path));
    if (attachment || known(mention.path)) chips.push({ ...mention, mention: text.slice(mention.start, mention.end), attachment });
  }
  const row: FileRowItem<T>[] = [], shown = new Set<string>();
  for (const chip of chips) {
    const key = chip.attachment?.id ?? 'path:' + chip.path;
    if (shown.has(key)) continue;
    shown.add(key);
    const image = chip.attachment ? !!chip.attachment.image : attachmentKind(chip.path) === 'image';
    if (image) row.push({ key, path: chip.attachment?.path ?? chip.path, attachment: chip.attachment });
  }
  for (const file of files) {
    if (shown.has(file.id)) continue;
    shown.add(file.id);
    row.push({ key: file.id, path: file.path, attachment: file });
  }
  return { chips, row };
}

/**
 * Whether a reference check (artifacts' resolveReferences) found the file an
 * @-mention names where Claude Code reads it: relative to the folder, never a
 * file of that name found somewhere below it. A path inside the folder comes
 * back relative to it; one outside, as the real absolute path. A folder
 * (written with its slash) is not a file.
 */
export function confirmsMention(mentioned: string, found: { path: string } | string | null | undefined): boolean {
  if (!found || typeof found !== 'object' || !mentioned || mentioned.endsWith('/')) return false;
  const plain = (path: string) => path.replace(/^\/private(?=\/(?:var|tmp|etc)\/)/, '').replace(/^(?:\.\/)+/, '');
  const a = plain(found.path), b = plain(mentioned);
  if (a === b) return true;
  // Absolute, home and parent paths are never searched for: what came back is that file.
  if (b.startsWith('/') || b.startsWith('~/')) return a.startsWith('/') ? a.endsWith(b.replace(/^~/, '')) : b.endsWith('/' + a);
  if (b.startsWith('../')) return a.startsWith('/') && a.endsWith('/' + b.replace(/^(?:\.\.\/)+/, ''));
  return false;
}

/** File names a conversation's user messages already use: of the files they mention and their attachments. */
export function messageFileNames(messages: readonly { role: string; text: string; attachments?: readonly { name: string }[] }[]): string[] {
  return messages.flatMap(message => message.role !== 'user' ? [] : [
    ...findMentions(message.text).map(mention => mention.path.split('/').pop() ?? ''), ...(message.attachments ?? []).map(file => file.name)]);
}

const imageTypes: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/tiff': 'tiff',
  'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/heic': 'heic',
};
const fileTypes: Record<string, string> = {
  'text/plain': 'txt', 'text/markdown': 'md', 'text/html': 'html', 'text/csv': 'csv', 'application/json': 'json', 'application/pdf': 'pdf',
  'application/zip': 'zip', 'application/xml': 'xml', 'text/xml': 'xml',
};

/**
 * Whether a file came without a name of its own: clipboard data (a screenshot,
 * copied image pixels) that Chromium calls "image.png", or nothing at all. A
 * file from disk (`fromDisk`) keeps its name, even that one.
 */
export function needsName(name: string, fromDisk: boolean): boolean {
  return !fromDisk && (!name.trim() || /^image\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/i.test(name));
}

/**
 * Lectern's name for a file that has none: image1.png, image2.jpg, … for
 * pictures, file1.txt, file2, … for the rest (the extension from its type). The
 * number follows every one this conversation already uses (`used`: file names
 * in its text and messages) and the last one given for that kind (`given`), so
 * it never repeats; the caller keeps `number` in `given`.
 */
export function generatedName(mime: string, original: string, used: Iterable<string>, given: Partial<Record<'image' | 'file', number>> = {}) {
  const type = mime.toLowerCase().split(';')[0].trim();
  const image = type.startsWith('image/') || attachmentKind(original) === 'image';
  const stem = image ? 'image' : 'file';
  const own = /\.([a-z0-9]{1,8})$/i.exec(original)?.[1].toLowerCase();
  const extension = (image ? imageTypes[type] : fileTypes[type]) ?? own ?? (image ? 'png' : '');
  let number = given[stem] ?? 0;
  const pattern = new RegExp(`^${stem}(\\d{1,6})(?:\\.[^./]*)?$`, 'i');
  for (const name of used) {
    const match = pattern.exec(name);
    if (match) number = Math.max(number, Number(match[1]));
  }
  number++;
  return { name: stem + number + (extension ? '.' + extension : ''), number, kind: stem } as const;
}

export type AttachmentKind = 'image' | 'pdf' | 'code' | 'text' | 'sheet' | 'slides' | 'archive' | 'audio' | 'video' | 'folder' | 'file';
const kinds: [AttachmentKind, RegExp][] = [
  ['image', /\.(?:png|jpe?g|gif|webp|bmp|avif|ico|svg|heic|tiff?)$/i],
  ['pdf', /\.pdf$/i],
  ['sheet', /\.(?:csv|tsv|xlsx?|ods|numbers|parquet)$/i],
  ['slides', /\.(?:pptx?|odp|key)$/i],
  ['archive', /\.(?:zip|tar|gz|tgz|bz2|xz|7z|rar)$/i],
  ['audio', /\.(?:mp3|m4a|wav|flac|ogg|opus|aac)$/i],
  ['video', /\.(?:mp4|m4v|mov|mkv|webm|avi)$/i],
  ['text', /\.(?:txt|md|mdx|markdown|rst|log|docx?|odt|rtf|tex|srt|vtt)$/i],
  ['code', /\.(?:[cm]?[jt]sx?|json[cl]?|ya?ml|toml|xml|html?|css|scss|vue|svelte|py|ipynb|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|lua|sh|zsh|bash|fish|sql|proto|graphql|ini|conf|cfg|diff|patch)$/i],
];
/** The kind of file a name suggests, for its card's icon; a trailing slash is a folder. */
export function attachmentKind(name: string): AttachmentKind {
  if (/[\\/]$/.test(name)) return 'folder';
  return kinds.find(([, pattern]) => pattern.test(name))?.[0] ?? 'file';
}
