import type { Element } from 'hast';
import type { Parent, PhrasingContent, Root, RootContent } from 'mdast';
import type { Processor } from 'unified';
// KaTeX's styles load once from main.tsx, which also installs installFormulaCopy (the tests import this file in Node).

/** KaTeX: an invalid formula shows its source, `\href` and other trusted commands stay off. */
export const katexOptions = { throwOnError: false, strict: 'ignore', trust: false, maxExpand: 1000 } as const;

const katexClasses = new Set(['katex', 'katex-display', 'katex-error']);
/** A formula KaTeX rendered (or could not): other rehype passes leave its inside alone. */
export function isKatex(element: Element) {
  const classes = element.properties.className;
  return Array.isArray(classes) && classes.some(name => katexClasses.has(String(name)));
}
type Position = { start: { offset?: number }; end: { offset?: number } };
const offsets = (node: { position?: Position }) => {
  const start = node.position?.start.offset, end = node.position?.end.offset;
  return start === undefined || end === undefined ? undefined : [start, end] as const;
};
function withoutPositions<T>(node: T): T {
  if (node && typeof node === 'object') {
    delete (node as { position?: unknown }).position;
    for (const child of (node as { children?: unknown[] }).children ?? []) withoutPositions(child);
  }
  return node;
}

/**
 * remark-math reads every `$…$` as a formula, but replies also write prices and shell variables
 * ("costs $5 and $10", "$HOME and $PATH"). One `$` opens a formula only as Pandoc reads it: no
 * space just inside either `$`, and no digit right after the closing one. Otherwise that `$` is
 * text and the rest of its parent is read again from after it (a later `$x$` stays a formula).
 * `$$…$$` is always a formula; alone in a paragraph it is set as a display formula.
 */
type Transform = (tree: Root, file: { value?: unknown }) => void;
/** `also`: the remark transforms after this one, applied to text read again here (the parser
 * already knows GFM and math syntax; the processor's run would go on to HTML). */
export function dollarMath(this: Processor, { also = [] }: { also?: Transform[] } = {}) {
  const processor = this;
  const transform: Transform = (tree, file) => {
    const source = String(file.value ?? '');
    function reread(parent: Parent, index: number, from: number) {
      const last = offsets(parent.children.at(-1) as RootContent), to = last?.[1] ?? from;
      const rest = source.slice(from, to);
      let replacement: RootContent[] = [{ type: 'text', value: source.slice(from - 1, to) }];
      if (!rest.trim()) replacement = [{ type: 'text', value: '$' + rest }];
      else if (parent.type !== 'link' && parent.type !== 'linkReference') {
        // Read as the middle of a line: a zero-width space first (as a character reference, so it
        // counts as punctuation for `_` emphasis) keeps "5. Then" or "# x" from starting a block.
        const text = '&#8203;' + rest, read = processor.parse(text) as Root;
        for (const step of [transform, ...also]) step(read, { value: text });
        const [only] = read.children;
        if (read.children.length === 1 && only.type === 'paragraph') {
          const first = only.children[0];
          if (first?.type === 'text' && first.value.startsWith('\u200b')) {
            first.value = first.value.slice(1);
            if (!first.value) only.children.shift();
            replacement = [{ type: 'text', value: '$' }, ...withoutPositions(only).children as PhrasingContent[]];
          }
        }
      }
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
        if ('children' in child) walk(child);
      }
      if (parent.type === 'paragraph') {
        const shown = parent.children.filter(child => child.type !== 'text' || child.value.trim());
        const [only] = shown, at = only && offsets(only);
        if (shown.length === 1 && only.type === 'inlineMath' && at && source.startsWith('$$', at[0])) {
          only.data = { ...only.data, hProperties: { ...only.data?.hProperties, className: ['language-math', 'math-display'] } };
        }
      }
    }
    walk(tree);
  };
  return transform;
}

/** The formula (its display block, if it has one) holding `node`. */
function formulaAround(node: Node | null) {
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest<HTMLElement>('.katex-display') ?? element?.closest<HTMLElement>('.katex') ?? undefined;
}
/** Runs `read` while each formula under `root` shows its TeX as text (`$…$`, or `$$…$$` on its own
 * line), so innerText and a selection's text give the source once, not KaTeX's glyphs plus its
 * MathML. Synchronous, so nothing paints in between; React's nodes are put back as they were. */
function withFormulaSource<T>(root: ParentNode, read: () => T): T {
  const undo: (() => void)[] = [];
  for (const formula of root.querySelectorAll<HTMLElement>('.katex')) {
    const tex = formula.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (tex == null || formula.parentElement?.closest('.katex')) continue;
    const source = document.createElement('span'), display = formula.parentElement?.classList.contains('katex-display');
    source.textContent = display ? `$$${tex}$$` : `$${tex}$`;
    const shown = formula.style.display;
    formula.after(source);
    formula.style.display = 'none';
    undo.push(() => { source.remove(); formula.style.display = shown; });
  }
  try { return read(); } finally { for (const step of undo.reverse()) step(); }
}
/** The visible text of `element`, formulas as their TeX. */
export function textWithFormulas(element: HTMLElement) { return withFormulaSource(element, () => element.innerText); }
/** The selected text, formulas as their TeX: a selection that starts or ends inside a formula takes all of it. */
export function selectionWithFormulas(selection: Selection) {
  if (!selection.rangeCount) return selection.toString();
  const range = selection.getRangeAt(0), start = formulaAround(range.startContainer), end = formulaAround(range.endContainer);
  if (start) range.setStartBefore(start);
  if (end) range.setEndAfter(end);
  const common = range.commonAncestorContainer, root = common instanceof Element ? common : common.parentElement;
  return root ? withFormulaSource(root, () => selection.toString()) : selection.toString();
}
/** Copying a selection with a formula puts its TeX on the clipboard as text, with the rest as usual. */
export function installFormulaCopy() {
  document.addEventListener('copy', event => {
    const selection = getSelection();
    if (!selection?.rangeCount || selection.isCollapsed || !event.clipboardData) return;
    const range = selection.getRangeAt(0);
    if (!formulaAround(range.startContainer) && !formulaAround(range.endContainer) && !range.cloneContents().querySelector('.katex')) return;
    const text = selectionWithFormulas(selection), html = document.createElement('div');
    html.append(selection.getRangeAt(0).cloneContents());
    event.clipboardData.setData('text/plain', text);
    event.clipboardData.setData('text/html', html.innerHTML);
    event.preventDefault();
  });
}
