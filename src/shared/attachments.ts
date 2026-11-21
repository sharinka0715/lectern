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

/**
 * The composer's text and attached files share one draft string: the files are
 * @-mentions after the text (`text @a @b `), exactly what Claude Code is sent.
 * The input box shows `text` and the files as cards.
 */
export function joinDraft(text: string, files: string[]): string {
  if (!files.length) return text;
  return (text ? text + ' ' : '') + files.map(mentionFor).join(' ') + ' ';
}

/** The inverse of joinDraft. Mentions of attached files anywhere in the draft become files, each once. */
export function splitDraft(draft: string, attached: (path: string) => boolean): { text: string; files: string[] } {
  const mentions = findMentions(draft).filter(mention => attached(mention.path));
  if (!mentions.length) return { text: draft, files: [] };
  const files: string[] = [];
  let text = '', from = 0;
  for (const mention of mentions) {
    // The space joinDraft put before a mention goes with it; a mention with
    // none before it (at the start or after a line break) takes the one after.
    const before = mention.start - 1 >= from && draft[mention.start - 1] === ' ';
    text += draft.slice(from, before ? mention.start - 1 : mention.start);
    from = mention.end + (!before && draft[mention.end] === ' ' ? 1 : 0);
    if (!files.includes(mention.path)) files.push(mention.path);
  }
  const rest = draft.slice(from);
  return { text: text + (rest === ' ' ? '' : rest), files };
}

/** Files added to the draft after those it already has. */
export function addDraftFiles(draft: string, files: string[], attached: (path: string) => boolean): string {
  const parts = splitDraft(draft, attached);
  return joinDraft(parts.text, [...parts.files, ...files.filter(file => !parts.files.includes(file))]);
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

interface AttachmentLike { id: string; path?: string; image?: true }
export interface AttachmentChip<T> { start: number; end: number; path: string; attachment?: T }
export interface AttachmentCard<T> { key: string; path?: string; attachment?: T }

/**
 * How a user message shows its attachments, each once. Mentions of attached
 * files that end the text (as the composer sends them) leave the text and
 * become cards; mentions inside the text become compact chips. Attachments no
 * mention names are cards too. A mention counts when the transcript recorded
 * its file, or before that when `attached` knows the path. Images embedded
 * in the message keep their own place in the text.
 */
export function messageAttachmentLayout<T extends AttachmentLike>(text: string, attachments: readonly T[], attached: (path: string) => boolean) {
  const files = attachments.filter(file => file.path || !file.image);
  const mentions = findMentions(text)
    .map(mention => ({ ...mention, attachment: files.find(file => file.path && samePath(file.path, mention.path)) }))
    .filter(mention => mention.attachment || attached(mention.path));
  let first = mentions.length, cut = text.length;
  while (first > 0 && !text.slice(mentions[first - 1].end, cut).trim()) cut = mentions[--first].start;
  const chips: AttachmentChip<T>[] = mentions.slice(0, first);
  const cards: AttachmentCard<T>[] = [];
  const shown = new Set<string>(chips.map(chip => chip.attachment?.id ?? 'path:' + chip.path));
  for (const mention of mentions.slice(first)) {
    const key = mention.attachment?.id ?? 'path:' + mention.path;
    if (shown.has(key)) continue;
    shown.add(key);
    cards.push({ key, path: mention.attachment?.path ?? mention.path, attachment: mention.attachment });
  }
  for (const file of files) {
    if (shown.has(file.id)) continue;
    shown.add(file.id);
    cards.push({ key: file.id, path: file.path, attachment: file });
  }
  return { text: first < mentions.length ? text.slice(0, cut).trimEnd() : text, chips, cards };
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
