// Files pasted or dropped into the composer become @-mentions of a path on the
// conversation's machine.

export const maxAttachmentBytes = 100 * 1024 * 1024;

/** The composer's @-mention for a path, quoted like @-completion when needed. */
export function mentionFor(path: string): string {
  return /^[\p{L}\p{N}\p{M}_./~-]+$/u.test(path) ? '@' + path : `@"${path}"`;
}

/** Mentions inserted over the selection, separated from the text around them by spaces. */
export function insertMentions(value: string, start: number, end: number, mentions: string[]): { text: string; caret: number } {
  const before = value.slice(0, start), after = value.slice(end);
  const inserted = (before && !/\s$/u.test(before) ? ' ' : '') + mentions.map(mentionFor).join(' ') + (/^\s/u.test(after) ? '' : ' ');
  return { text: before + inserted + after, caret: before.length + inserted.length };
}

/** Mentions added at the end of a draft that is not on screen. */
export function appendMentions(value: string, mentions: string[]): string {
  return insertMentions(value, value.length, value.length, mentions).text;
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
