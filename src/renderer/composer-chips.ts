// Attached files inside the input box's text. Each @-mention of an attached file
// is one token in the textarea: figure spaces (fixed width, no line break inside)
// with the chip's id hidden after the first one in invisible tag characters,
//   U+2007 U+E0001 <id digits> U+E002D <width digits> U+E007F U+2007 × (width - 1)
// A layer over the textarea draws the chip (the file's name) on those spaces.
// The token never changes once typed, so native undo, redo and drag keep working.
// The draft (what is sent, saved and restored) has the @-mention in its place.
import { findMentions, mentionFor } from '../shared/attachments';
import { isRelativePath, pathFromCwd } from './artifact-paths';

const space = ' ';
const digitZero = 0xE0030;
const head = / \u{E0001}([\u{E0030}-\u{E0039}]{1,9})\u{E002D}([\u{E0030}-\u{E0039}]{1,2})\u{E007F}/gu;
const tokenChar = /[ \u{E0001}\u{E002D}\u{E0030}-\u{E0039}\u{E007F}]/u;
const maxWidth = 60;

export interface ChipToken { start: number; end: number; id: number }

const digits = (value: number) => [...String(value)].map(d => String.fromCodePoint(digitZero + Number(d))).join('');
const valueOf = (tags: string) => Number([...tags].map(c => c.codePointAt(0)! - digitZero).join(''));

/** The textarea text of one chip, `width` figure spaces wide. */
export function chipToken(id: number, width: number): string {
  const w = Math.max(1, Math.min(maxWidth, Math.round(width) || 1));
  return space + '\u{E0001}' + digits(id) + '\u{E002D}' + digits(w) + '\u{E007F}' + space.repeat(w - 1);
}

/** The well-formed tokens in a text, in order; `known` drops ids this window never gave out. */
export function chipTokens(text: string, known: (id: number) => boolean = () => true): ChipToken[] {
  const tokens: ChipToken[] = [];
  if (!text.includes('\u{E0001}')) return tokens;
  for (const match of text.matchAll(head)) {
    const id = valueOf(match[1]), width = valueOf(match[2]);
    const tail = match.index + match[0].length, end = tail + width - 1;
    if (width < 1 || end > text.length || text.slice(tail, end) !== space.repeat(width - 1) || !known(id)) continue;
    tokens.push({ start: match.index, end, id });
  }
  return tokens;
}

/** What a draft needs to turn its attachment mentions into chips. */
export interface ChipSource {
  attached(path: string): boolean;
  /** The chip id for this mention exactly as written (`raw`), so the draft comes back unchanged. */
  idFor(raw: string, path: string): number;
  /** The chip's width in figure spaces. */
  widthFor(path: string): number;
}

/** The textarea text for a draft: every mention of an attached file becomes its chip. */
export function displayFromDraft(draft: string, source: ChipSource): string {
  let text = '', from = 0;
  for (const mention of findMentions(draft)) {
    if (!source.attached(mention.path)) continue;
    const raw = draft.slice(mention.start, mention.end);
    text += draft.slice(from, mention.start) + chipToken(source.idFor(raw, mention.path), source.widthFor(mention.path));
    from = mention.end;
  }
  return text + draft.slice(from);
}

/**
 * The draft for a textarea text: chips become their @-mentions. A chip moved
 * against other text gets the space a mention needs to be read as one (before
 * it, and after an unquoted one). `mentionOf` gives nothing for a file still
 * uploading: it is not sent. displayFromDraft followed by this returns the draft
 * unchanged.
 */
export function draftFromDisplay(text: string, mentionOf: (id: number) => string | undefined, known?: (id: number) => boolean): string {
  let draft = '', from = 0, open = false;
  const add = (part: string) => {
    if (!part) return;
    if (open && !/^[\s"]/u.test(part)) draft += ' ';
    draft += part;
    open = false;
  };
  for (const token of chipTokens(text, known)) {
    add(text.slice(from, token.start));
    from = token.end;
    const mention = mentionOf(token.id);
    if (mention === undefined) continue;
    if (draft && !/\s$/u.test(draft)) draft += ' ';
    draft += mention;
    open = !mention.startsWith('@"');
  }
  add(text.slice(from));
  return draft;
}

/**
 * The draft as sent while Claude Code works elsewhere than the folder (after a `cd`): it reads an
 * @-mention from its current directory, so a chip of a folder file (`pathOf`: picked from the @ list or
 * found by the reference check, relative to the folder) goes as that file's absolute path under
 * `launch`, the folder's. Attachments (absolute already) and typed text stay as written.
 */
export function sentFromDisplay(text: string, mentionOf: (id: number) => string | undefined, pathOf: (id: number) => string | undefined,
  launch: string, known?: (id: number) => boolean): string {
  return draftFromDisplay(text, id => {
    const mention = mentionOf(id), path = pathOf(id);
    return mention !== undefined && path && isRelativePath(path) ? mentionFor(pathFromCwd(launch, path)) : mention;
  }, known);
}

/**
 * A textarea edit (`previous` → `next`, any kind: typing, input method, undo,
 * drag, paste) with chips kept whole. The changed span is widened to whole old
 * chips; tokens in what was put there are chips again (an undo brings one back),
 * and when the edit cut into a chip, what is left of it goes too. Returns the
 * cleaned text, the changed span in it and a map for offsets in `next`.
 */
export function reconcileChips(previous: string, next: string, known: (id: number) => boolean) {
  const old = chipTokens(previous, known);
  let start = 0;
  const limit = Math.min(previous.length, next.length);
  while (start < limit && previous[start] === next[start]) start++;
  let tail = 0;
  while (tail < limit - start && previous[previous.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  // Never split a surrogate pair: both strings agree on whole characters outside the span.
  if (start > 0 && /[\uD800-\uDBFF]/.test(previous[start - 1])) start--;
  if (tail > 0 && /[\uDC00-\uDFFF]/.test(previous[previous.length - tail])) tail--;
  let oldEnd = previous.length - tail;
  for (const token of old) {
    if (token.start < start && start < token.end) start = token.start;
    if (token.start < oldEnd && oldEnd < token.end) oldEnd = token.end;
  }
  tail = previous.length - oldEnd;
  const end = next.length - tail;
  const touched = old.some(token => token.start >= start && token.end <= oldEnd);
  const middle = next.slice(start, end);
  if (!touched) return { text: next, start, end, position: (offset: number) => offset };
  // Keep whole tokens and anything that is not token text; drop the pieces of broken ones.
  const kept = chipTokens(middle, known);
  let cleaned = '', from = 0;
  const removed: [number, number][] = [];
  const strip = (part: string, offset: number) => {
    let index = 0;
    for (const char of part) {
      if (tokenChar.test(char) || /^[\uD800-\uDFFF]$/.test(char)) removed.push([offset + index, offset + index + char.length]);
      else cleaned += char;
      index += char.length;
    }
  };
  for (const token of kept) {
    strip(middle.slice(from, token.start), start + from);
    cleaned += middle.slice(token.start, token.end);
    from = token.end;
  }
  strip(middle.slice(from), start + from);
  const text = next.slice(0, start) + cleaned + next.slice(end);
  const position = (offset: number) => {
    let shift = 0;
    for (const [a, b] of removed) {
      if (offset >= b) shift += b - a;
      else if (offset > a) shift += offset - a;
    }
    return offset - shift;
  };
  return { text, start, end: start + cleaned.length, position };
}

/**
 * A selection moved out of chips: a caret inside one goes to the edge it was
 * heading for (the nearer edge for a click), a range grows to whole chips. A
 * range end that moved backwards into a chip gives it up instead, so shrinking
 * a selection with Shift + arrows passes over a chip like over one character.
 */
export function snapSelection(tokens: readonly ChipToken[], start: number, end: number, previous?: readonly [number, number], pointer = false): [number, number] {
  const inside = (offset: number) => tokens.find(token => token.start < offset && offset < token.end);
  if (start === end) {
    const token = inside(start);
    if (!token) return [start, end];
    const before = previous && previous[0] === previous[1] ? previous[0] : undefined;
    const forward = pointer || before === undefined || before === start ? start - token.start >= token.end - start : start > before;
    const edge = forward ? token.end : token.start;
    return [edge, edge];
  }
  const startToken = inside(start), endToken = inside(end);
  const nextStart = !startToken ? start : !pointer && previous && start > previous[0] ? startToken.end : startToken.start;
  const nextEnd = !endToken ? end : !pointer && previous && end < previous[1] ? endToken.start : endToken.end;
  return nextStart <= nextEnd ? [nextStart, nextEnd] : [nextEnd, nextEnd];
}

/** Tokens with these ids taken out of the text, each with one space next to it when it sat between two. */
export function removeChips(text: string, tokens: readonly ChipToken[], drop: (token: ChipToken) => boolean) {
  let result = '', from = 0;
  for (const token of tokens) {
    if (!drop(token)) continue;
    let start = token.start, end = token.end;
    const before = start === 0 || /\s/u.test(text[start - 1]), after = end === text.length || /\s/u.test(text[end]);
    if (before && text[end] === ' ') end++;
    else if (after && text[start - 1] === ' ' && start - 1 >= from) start--;
    result += text.slice(from, start);
    from = end;
  }
  return result + text.slice(from);
}

/** The text that puts chips at `offset`, spaced from the words around them like an inserted @-mention. */
export function chipInsertion(text: string, offset: number, tokens: readonly string[]) {
  const before = offset > 0 && !/\s/u.test(text[offset - 1]) ? ' ' : '';
  const after = offset < text.length && /\s/u.test(text[offset]) ? '' : ' ';
  return before + tokens.join(' ') + after;
}

/** One entry per file, in the order the text first names it, with the ids of all its chips. */
export function chipOrder<T extends { key: string }>(tokens: readonly ChipToken[], info: (id: number) => T | undefined) {
  const items: (T & { ids: number[] })[] = [];
  const byKey = new Map<string, T & { ids: number[] }>();
  for (const token of tokens) {
    const entry = info(token.id);
    if (!entry) continue;
    const seen = byKey.get(entry.key);
    if (seen) { if (!seen.ids.includes(token.id)) seen.ids.push(token.id); continue; }
    const item = { ...entry, ids: [token.id] };
    byKey.set(entry.key, item);
    items.push(item);
  }
  return items;
}

/**
 * The mentions in a draft put into the box (restored, put back, a queued message
 * to edit) that may name files not known yet: each path once, folders (with
 * their slash) and over-long paths left out. Those a reference check finds
 * become chips; typed mentions are never checked.
 */
export function mentionCandidates(draft: string, known: (path: string) => boolean): string[] {
  const paths = new Set<string>();
  for (const { path } of findMentions(draft)) if (!known(path) && !path.endsWith('/') && path.length <= 1024) paths.add(path);
  return [...paths];
}

/**
 * The edit that turns a mention being completed (`start`…`end` in the text) into
 * its chip: the chip then one space, unless a space already follows; the caret
 * goes past that space either way, as after completing a word.
 */
export function completionEdit(text: string, start: number, end: number, token: string) {
  const spaced = /^\s/u.test(text.slice(end));
  const insertion = token + (spaced ? '' : ' ');
  return { start, end, insertion, caret: start + insertion.length + (spaced ? 1 : 0) };
}
