/**
 * Text streamed onto the end of a reply fades in (content-fade.css, `[data-text-fade]`).
 *
 * The block fade (content-fade.ts) moves whole paragraphs, list items and rows; most streamed text
 * grows at the end of a paragraph already there. For each reply this keeps the text already shown
 * (visible characters only: no whitespace, nothing invisible) and, when the reply changes, aligns
 * it with the text now: characters that were shown stay as they are, whatever element now holds
 * them (a paragraph that became a list, a preview replaced by the saved reply, `**bold` once its
 * closing `**` arrives); only the others fade in, once. A fade still running when the text changes
 * again goes on where it was (a new span with a negative delay), not from the start.
 *
 * The fading characters go in spans of their own, split off React's text node (which keeps the
 * text before them). React later sets that node's whole text or removes it: before anything is
 * painted, the observer's records say so and the spans go (the node then holds all its text), or
 * else the text goes back into the node (`appendData`), then the reply is read and wrapped again.
 * A span goes when its animation ends.
 */
export const TEXT_FADE_MS = 320;
/** Edits between the text shown and the text now beyond which nothing fades (too different to tell). */
export const MAX_TEXT_EDITS = 1024;

const INVISIBLE = /[\s\p{Default_Ignorable_Code_Point}]/gu;
const INVISIBLE_ONE = /^[\s\p{Default_Ignorable_Code_Point}]$/u;
/** The characters that count: whitespace and invisible ones (joiners, variation selectors) do not. */
export const visibleText = (text: string) => text.replace(INVISIBLE, '');

/** Where each visible character (UTF-16 unit, as in `visibleText`) of `text` is. */
export function visibleOffsets(text: string): number[] {
  const at: number[] = [];
  for (let i = 0; i < text.length;) {
    const code = text.codePointAt(i)!, size = code > 0xffff ? 2 : 1;
    const invisible = code < 0x80 ? code === 32 || (code >= 9 && code <= 13) : INVISIBLE_ONE.test(String.fromCodePoint(code));
    if (!invisible) for (let unit = 0; unit < size; unit++) at.push(i + unit);
    i += size;
  }
  return at;
}

/** A stretch of characters kept: from `from` in the text shown before, at `to` in the text now. */
export interface Kept { from: number; to: number; length: number }
/** Characters [from, to) of the visible text, fading in since `at` (performance.now()). */
export interface Fading { from: number; to: number; at: number }

/** Characters handed to the diff after the common start, all alignments so far: a reply growing at its
 * end costs none, a change near its end only that tail (tests read it instead of timing it). */
export const alignWork = { units: 0 };

/**
 * The characters of `next` that are those of `shown`, in order: the common start, then the longest
 * common subsequence of the rest (Myers' O(ND) diff). Ties keep the earlier characters, so text
 * added at the end is what is new. Undefined when more than `maxEdits` edits apart.
 */
export function alignShown(shown: string, next: string, maxEdits = MAX_TEXT_EDITS): Kept[] | undefined {
  let start = 0;
  const end = Math.min(shown.length, next.length);
  while (start < end && shown.charCodeAt(start) === next.charCodeAt(start)) start++;
  const kept: Kept[] = start ? [{ from: 0, to: 0, length: start }] : [];
  if (start === shown.length || start === next.length) return kept;
  alignWork.units += shown.length + next.length - 2 * start;
  const rest = commonRuns(shown.slice(start), next.slice(start), maxEdits);
  if (!rest) return undefined;
  for (const run of rest) kept.push({ from: run.from + start, to: run.to + start, length: run.length });
  return kept;
}

function commonRuns(a: string, b: string, maxEdits: number): Kept[] | undefined {
  const n = a.length, m = b.length, max = Math.min(n + m, maxEdits), offset = max + 1;
  // v[offset + k]: how far along `a` the path on diagonal k (x - y) reaches; -1: not reached.
  const v = new Int32Array(2 * max + 3).fill(-1), trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    const before = trace[d], at = (k: number) => before[k + d + 1];
    for (let k = -d; k <= d; k += 2) {
      let x = d ? reach(at, k, n, m).x : 0;
      if (x < 0) { v[offset + k] = -1; continue; }
      let y = x - k;
      while (x < n && y < m && a.charCodeAt(x) === b.charCodeAt(y)) { x++; y++; }
      v[offset + k] = x;
      if (x === n && y === m) return backtrack(trace, n, m);
    }
  }
  return undefined;
}

/** One edit onto diagonal k from the step before (`at`): an insertion from k + 1 or a deletion from
 * k - 1, whichever stays inside both texts and reaches further (the insertion on a tie). */
function reach(at: (k: number) => number, k: number, n: number, m: number) {
  const down = at(k + 1), right = at(k - 1) < 0 ? -1 : at(k - 1) + 1;
  const downOk = down >= 0 && down - k <= m, rightOk = right >= 0 && right <= n;
  if (downOk && (!rightOk || down >= right)) return { x: down, from: k + 1 };
  return rightOk ? { x: right, from: k - 1 } : { x: -1, from: k };
}

/** The diagonal stretches of the path found: `trace[d]` holds V[-d-1 … d+1] before step d. */
function backtrack(trace: Int32Array[], n: number, m: number): Kept[] {
  const runs: Kept[] = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const before = trace[d], at = (k: number) => before[k + d + 1];
    let px = 0, py = 0;
    if (d) { const { from } = reach(at, x - y, n, m); px = at(from); py = px - from; }
    const length = Math.min(x - px, y - py);
    if (length > 0) runs.push({ from: x - length, to: y - length, length });
    x = px; y = py;
  }
  return runs.reverse();
}

/**
 * What fades once the text shown went from `shown` to `next`: fades still running (by `now`) carried
 * to where their characters are now, and the characters not shown before, from `now`. In order;
 * neighbours that started together merge. Text too different to tell (see MAX_TEXT_EDITS) shows as it is.
 */
export function planTextFades(shown: string, next: string, fading: readonly Fading[], now: number, duration = TEXT_FADE_MS): Fading[] {
  const kept = alignShown(shown, next);
  if (!kept) return [];
  const plan: Fading[] = [];
  for (const fade of fading) {
    if (now - fade.at >= duration) continue;
    for (const run of kept) {
      const from = Math.max(fade.from, run.from), to = Math.min(fade.to, run.from + run.length);
      if (from < to) plan.push({ from: from - run.from + run.to, to: to - run.from + run.to, at: fade.at });
    }
  }
  let at = 0;
  for (const run of [...kept, { from: shown.length, to: next.length, length: 0 }]) {
    if (run.to > at) plan.push({ from: at, to: run.to, at: now });
    at = Math.max(at, run.to + run.length);
  }
  plan.sort((x, y) => x.from - y.from);
  const merged: Fading[] = [];
  for (const fade of plan) {
    const last = merged.at(-1);
    if (last && last.to === fade.from && last.at === fade.at) last.to = fade.to;
    else merged.push({ ...fade });
  }
  return merged;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** `index` moved to the edge of the character (grapheme cluster: an emoji sequence, a letter and its
 * marks) it falls inside: back to its start, or on to its end. A span never splits one. */
export function graphemeEdge(text: string, index: number, forward: boolean): number {
  if (index <= 0 || index >= text.length) return index;
  const low = Math.max(0, index - 32);
  for (const { index: at, segment } of graphemes.segment(text.slice(low, index + 32))) {
    const start = low + at, end = start + segment.length;
    if (end > index) return start === index || !forward ? start : end;
  }
  return index;
}

/** The text tracked in a reply: its own Markdown (not a tool's details, not the waiting stand-in). */
const REPLY_TEXT = ':scope > .message-content > .markdown:not([data-fade-placeholder])';
interface Ledger { shown: string; fading: Fading[] }
/** One of React's text nodes split here: the text left in it, and the nodes after it holding the rest. */
interface Split { kept: string; rest: (Text | HTMLElement)[]; changed: boolean }
interface TextRun { node: Text; start: number; length: number }

/** A reply's visible text and the text nodes holding it, in order. */
function replyText(message: Element) {
  const runs: TextRun[] = [];
  let text = '';
  for (const block of message.querySelectorAll(REPLY_TEXT)) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const visible = visibleText(node.data);
      if (!visible) continue;
      runs.push({ node, start: text.length, length: visible.length });
      text += visible;
    }
  }
  return { text, runs };
}

/** The text fades of one conversation (see the top of this file), driven by content-fade.ts. */
export class TextFades {
  private ledgers = new WeakMap<Element, Ledger>();
  private splits = new Map<Text, Split>();
  private started = new WeakMap<Element, number>();
  private sweepTimer?: number;

  /** `sync` applies React's changes not yet seen; `done` drops the records of the changes made here. */
  constructor(private root: Element, private hooks: { sync(): void; done(): void }) {
    root.addEventListener('animationend', this.ended);
    root.addEventListener('animationcancel', this.ended);
  }

  /** React's changes (and the messages that took another's place): the replies they touched are
   * read again, and when `live` what is new there fades in. */
  update(records: readonly MutationRecord[], pairs: readonly (readonly [Node, Node])[], live: boolean) {
    const touched = new Set<Element>();
    for (const [gone, came] of pairs) {
      const ledger = gone instanceof Element ? this.ledgers.get(gone) : undefined;
      if (ledger && came instanceof Element) { this.ledgers.set(came, ledger); touched.add(came); }
    }
    for (const record of records) {
      if (record.type === 'characterData') { const split = this.splits.get(record.target as Text); if (split) split.changed = true; }
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      if (!target?.classList.contains('conversation')) { const message = target?.closest('.message'); if (message) touched.add(message); }
      // A new message: what it shows now fades in with it, what comes later fades as text.
      else if (live) for (const node of record.addedNodes) if (node instanceof Element && node.classList.contains('message')) touched.add(node);
    }
    const now = performance.now();
    for (const message of touched) this.read(message, live, now);
  }

  dispose() {
    window.clearTimeout(this.sweepTimer);
    this.root.removeEventListener('animationend', this.ended);
    this.root.removeEventListener('animationcancel', this.ended);
    this.splits.clear();
  }

  private read(message: Element, live: boolean, now: number) {
    if (message.getAttribute('data-role') === 'user') return;
    this.unwrap(message);
    const ledger = this.ledgers.get(message);
    if (!message.isConnected || message.hasAttribute('data-leaving') || (!ledger && !live)) return;
    const { text, runs } = replyText(message);
    if (!ledger || !live) { this.ledgers.set(message, { shown: text, fading: [] }); return; }
    const plan = planTextFades(ledger.shown, text, ledger.fading, now);
    ledger.shown = text;
    ledger.fading = this.wrap(runs, plan, now);
    if (ledger.fading.length) this.schedule();
  }

  /** Puts the planned fades in spans; a block fading in as a whole (a new paragraph, a new reply)
   * does not fade twice. Returns the fades put in place. */
  private wrap(runs: readonly TextRun[], plan: readonly Fading[], now: number): Fading[] {
    const applied: Fading[] = [];
    let first = 0;
    for (const run of runs) {
      const end = run.start + run.length, pieces: Fading[] = [];
      while (first < plan.length && plan[first].to <= run.start) first++;
      for (let i = first; i < plan.length && plan[i].from < end; i++)
        pieces.push({ from: Math.max(plan[i].from, run.start) - run.start, to: Math.min(plan[i].to, end) - run.start, at: plan[i].at });
      if (!pieces.length || run.node.parentElement?.closest('[data-fade="in"]')) continue;
      this.split(run.node, pieces, now);
      for (const piece of pieces) applied.push({ from: piece.from + run.start, to: piece.to + run.start, at: piece.at });
    }
    return applied;
  }

  /** Splits React's text node: it keeps the text before the first piece; after it, a span for each
   * piece (a fade started earlier goes on where it was: a negative delay) and text nodes between. */
  private split(node: Text, pieces: readonly Fading[], now: number) {
    const data = node.data, offsets = visibleOffsets(data), parts: { start: number; end: number; at: number }[] = [];
    for (const piece of pieces) {
      const start = graphemeEdge(data, offsets[piece.from], false), end = graphemeEdge(data, offsets[piece.to - 1] + 1, true);
      const last = parts.at(-1);
      if (last && start < last.end) { last.end = Math.max(last.end, end); last.at = Math.min(last.at, piece.at); }
      else parts.push({ start, end, at: piece.at });
    }
    const rest: (Text | HTMLElement)[] = [];
    let cursor = parts[0].start;
    for (const part of parts) {
      if (part.start > cursor) rest.push(document.createTextNode(data.slice(cursor, part.start)));
      const span = document.createElement('span'), elapsed = Math.round(now - part.at);
      // When the fade started (performance.now(), ms): a fade going on keeps it.
      span.setAttribute('data-text-fade', String(Math.round(part.at)));
      if (elapsed > 0) span.style.animationDelay = `-${elapsed}ms`;
      span.textContent = data.slice(part.start, part.end);
      this.started.set(span, part.at);
      rest.push(span);
      cursor = part.end;
    }
    if (cursor < data.length) rest.push(document.createTextNode(data.slice(cursor)));
    node.deleteData(parts[0].start, data.length - parts[0].start);
    node.after(...rest);
    this.splits.set(node, { kept: node.data, rest, changed: false });
  }

  /** Before React's text is read again: each split node in `message` (and any no longer in the page)
   * gets its text back, unless React has since set its text or removed it; our nodes go. */
  private unwrap(message: Element) {
    for (const [node, split] of this.splits) {
      if (node.isConnected && !message.contains(node)) continue;
      this.splits.delete(node);
      const parent = node.parentNode;
      if (parent && !split.changed && node.data === split.kept && split.rest.every(part => part.parentNode === parent))
        node.appendData(split.rest.map(part => part.textContent).join(''));
      for (const part of split.rest) part.remove();
    }
  }

  /** A span whose fade is over becomes text again, joined with the text next to it (React's node first). */
  private release(span: HTMLElement) {
    for (const [node, split] of this.splits) {
      const index = split.rest.indexOf(span);
      if (index < 0) continue;
      // React changed it since: the update that follows (already queued) reads it again.
      if (!node.parentNode || split.changed || node.data !== split.kept) return false;
      const text = document.createTextNode(span.textContent ?? '');
      span.replaceWith(text);
      const nodes = [node, ...split.rest];
      nodes[index + 1] = text;
      for (let i = nodes.length - 1; i > 0; i--) {
        const before = nodes[i - 1], after = nodes[i];
        if (before instanceof Text && after instanceof Text) { before.appendData(after.data); after.remove(); nodes.splice(i, 1); }
      }
      split.rest = nodes.slice(1);
      split.kept = node.data;
      if (!split.rest.length) this.splits.delete(node);
      return true;
    }
    return false;
  }

  private ended = (event: Event) => {
    const span = event.target;
    if (!(span instanceof HTMLElement) || !span.hasAttribute('data-text-fade') || (event as AnimationEvent).animationName !== 'lectern-text-in') return;
    this.hooks.sync();
    this.release(span);
    this.hooks.done();
  };

  /** Spans whose animation never ran (a hidden pane, reduced motion turned on meanwhile) go too. */
  private schedule() {
    window.clearTimeout(this.sweepTimer);
    this.sweepTimer = window.setTimeout(this.sweep, TEXT_FADE_MS + 1000);
  }

  private sweep = () => {
    this.sweepTimer = undefined;
    this.hooks.sync();
    const now = performance.now();
    let released = false;
    for (const split of [...this.splits.values()]) for (const part of [...split.rest])
      if (part instanceof HTMLElement && now - (this.started.get(part) ?? 0) >= TEXT_FADE_MS && this.release(part)) released = true;
    this.hooks.done();
    if (released && this.splits.size) this.schedule();
  };
}
