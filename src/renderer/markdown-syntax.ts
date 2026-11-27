import type { Link, Parent, PhrasingContent, Root, RootContent } from 'mdast';
import type { Processor } from 'unified';

/** One fix-up of a parsed reply. `read` parses inline text again, every fix-up applied. */
type Step = (tree: Root, source: string, read: (text: string) => PhrasingContent[] | undefined) => void;
type Positioned = { position?: { start: { offset?: number }; end: { offset?: number } } };
const offsets = (node: Positioned | undefined) => {
  const start = node?.position?.start.offset, end = node?.position?.end.offset;
  return start === undefined || end === undefined ? undefined : [start, end] as const;
};
function withoutPositions<T>(node: T): T {
  if (node && typeof node === 'object') {
    delete (node as Positioned).position;
    for (const child of (node as { children?: unknown[] }).children ?? []) withoutPositions(child);
  }
  return node;
}

/**
 * Reply Markdown as models write it, after GFM and math parsing, in this order: a bare link ends at
 * CJK punctuation (autolinkEnds), one `$` is a formula only as Pandoc reads it (dollarMath), and
 * `~` is never a strikethrough (keepTildes). Text read again goes through all three.
 */
export function replySyntax(this: Processor) {
  const processor = this, steps: Step[] = [autolinkEnds, dollarMath, keepTildes];
  const run = (tree: Root, source: string) => { for (const step of steps) step(tree, source, read); };
  // Read as the middle of a line: a zero-width space first (as a character reference, so it counts
  // as punctuation for `_` emphasis) keeps "5. Then" or "# x" from starting a block.
  function read(text: string) {
    const source = '&#8203;' + text, tree = processor.parse(source) as Root;
    run(tree, source);
    const [only] = tree.children;
    if (tree.children.length !== 1 || only.type !== 'paragraph') return;
    const first = only.children[0];
    if (first?.type !== 'text' || !first.value.startsWith('\u200b')) return;
    first.value = first.value.slice(1);
    if (!first.value) only.children.shift();
    return withoutPositions(only).children;
  }
  return (tree: Root, file: { value?: unknown }) => run(tree, String(file.value ?? ''));
}

// CJK and fullwidth punctuation, curly quotes and the ellipsis: where linkify-it ends a bare link.
const linkStop = /[\u2018-\u201f\u2026\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/u;
/** GFM's own end of a bare link: no trailing ?!.,:*_~ or quote, no unmatched closing parenthesis. */
function trimLink(text: string) {
  for (;;) {
    const last = text.at(-1);
    if (last && `?!.,:*_~'"`.includes(last)) text = text.slice(0, -1);
    else if (last === ')' && text.split('(').length < text.split(')').length) text = text.slice(0, -1);
    else return text;
  }
}
/** A private-use character `text` does not have: marks where a link held out of a reread goes back. */
function holderFor(text: string) {
  let code = 0xe000;
  while (text.includes(String.fromCharCode(code))) code++;
  return String.fromCharCode(code);
}
function putBack(nodes: PhrasingContent[], link: Link, holder: string): PhrasingContent[] {
  return nodes.flatMap((node): PhrasingContent[] => {
    if ('children' in node) { (node as Parent).children = putBack((node as Parent).children as PhrasingContent[], link, holder); return [node]; }
    if (node.type !== 'text' || !node.value.includes(holder)) return [node];
    return node.value.split(holder).flatMap((value, i) => [...(i ? [structuredClone(link)] : []), ...(value ? [{ type: 'text' as const, value }] : [])]);
  });
}
/**
 * GFM runs a bare link on to the next space, which in Chinese can be a sentence away: in
 * "**http://x/**。从你…" the link takes the `**` that closes the bold and the text after it. A bare
 * link ends at CJK punctuation instead, then at GFM's trailing punctuation, and the text holding it
 * (paragraph, heading or table cell) is read again with the link held out, so `**…**` pairs up.
 * CJK letters stay inside: https://zh.wikipedia.org/wiki/数学 is one link.
 */
const autolinkEnds: Step = (tree, source, read) => {
  /** Returns the text it read again (that box's old children are gone), else undefined. */
  function walk(parent: Parent, box: Parent | undefined): Parent | undefined {
    const holds = parent.type === 'paragraph' || parent.type === 'heading' || parent.type === 'tableCell' ? parent : box;
    for (const child of parent.children) {
      const at = child.type === 'link' ? offsets(child) : undefined;
      if (at && holds && child.type === 'link' && !/^[<[]/.test(source[at[0]] ?? '')) {
        const raw = source.slice(at[0], at[1]), stop = raw.search(linkStop), kept = stop < 0 ? raw : trimLink(raw.slice(0, stop));
        const first = offsets(holds.children[0] as RootContent), last = offsets(holds.children.at(-1) as RootContent);
        if (stop > 0 && kept && first && last && child.url.endsWith(raw)) {
          const before = source.slice(first[0], at[0]), after = source.slice(at[0] + kept.length, last[1]), holder = holderFor(before + after);
          const nodes = read(before + holder + after);
          const link: Link = { type: 'link', url: child.url.slice(0, child.url.length - raw.length) + kept, title: null, children: [{ type: 'text', value: kept }] };
          if (nodes) { holds.children = putBack(nodes, link, holder) as typeof holds.children; return holds; }
        }
      }
      const done = 'children' in child ? walk(child as Parent, holds) : undefined;
      if (done && done !== child) return done;
    }
  }
  walk(tree, undefined);
};

/**
 * remark-math reads every `$…$` as a formula, but replies also write prices and shell variables
 * ("costs $5 and $10", "$HOME and $PATH"). One `$` opens a formula only as Pandoc reads it: no
 * space just inside either `$`, and no digit right after the closing one. Otherwise that `$` is
 * text and the rest of its parent is read again from after it (a later `$x$` stays a formula).
 * `$$…$$` is always a formula; alone in a paragraph it is set as a display formula.
 */
const dollarMath: Step = (tree, source, read) => {
  function reread(parent: Parent, index: number, from: number) {
    const last = offsets(parent.children.at(-1) as RootContent), to = last?.[1] ?? from, rest = source.slice(from, to);
    let replacement: RootContent[] = [{ type: 'text', value: source.slice(from - 1, to) }];
    const nodes = rest.trim() && parent.type !== 'link' && parent.type !== 'linkReference' ? read(rest) : undefined;
    if (!rest.trim()) replacement = [{ type: 'text', value: '$' + rest }];
    else if (nodes) replacement = [{ type: 'text', value: '$' }, ...nodes];
    parent.children.splice(index, parent.children.length - index, ...replacement as never[]);
  }
  function walk(parent: Parent) {
    for (let i = 0; i < parent.children.length; i++) {
      const child = parent.children[i];
      if (child.type === 'inlineMath') {
        const at = offsets(child);
        if (!at || source.startsWith('$$', at[0])) continue;
        const inner = source.slice(at[0] + 1, at[1] - 1);
        if (inner && !/^\s|\s$/u.test(inner) && !/\d/u.test(source[at[1]] ?? '')) continue;
        reread(parent, i, at[0] + 1);
        return;
      }
      if ('children' in child) walk(child as Parent);
    }
    if (parent.type === 'paragraph') {
      const shown = parent.children.filter(child => child.type !== 'text' || child.value.trim());
      const [only] = shown, at = only && offsets(only);
      if (shown.length === 1 && only.type === 'inlineMath' && at && source.startsWith('$$', at[0]))
        only.data = { ...only.data, hProperties: { ...only.data?.hProperties, className: ['language-math', 'math-display'] } };
    }
  }
  walk(tree);
};

/** GFM strikethrough off. Models write "~" for ranges and approximations ("20~100 steps",
 * "~5%"), which remark-gfm reads as a deletion. Each deletion goes back to its own tildes
 * from the source and its children stay as parsed (code spans, links). Adjacent text is
 * merged again so a path such as "~/a" is still one text node for linkFileText. */
const keepTildes: Step = (tree, source) => {
  function walk(parent: Parent) {
    const children = parent.children.flatMap((child): RootContent[] => {
      if ('children' in child) walk(child as Parent);
      if (child.type !== 'delete') return [child];
      const raw = source.slice(child.position?.start.offset ?? 0, child.position?.end.offset ?? 0);
      const open = /^~+/.exec(raw)?.[0] ?? '~', close = /~+$/.exec(raw)?.[0] ?? open;
      return [{ type: 'text', value: open }, ...child.children, { type: 'text', value: close }];
    });
    const merged: RootContent[] = [];
    for (const child of children) {
      const last = merged.at(-1);
      if (last?.type === 'text' && child.type === 'text') {
        merged[merged.length - 1] = { type: 'text', value: last.value + child.value,
          position: last.position && child.position && { start: last.position.start, end: child.position.end } };
      } else merged.push(child);
    }
    parent.children = merged as typeof parent.children;
  }
  walk(tree);
};
