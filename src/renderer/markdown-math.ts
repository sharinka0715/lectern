import type { Element } from 'hast';
// KaTeX's styles load once from main.tsx, which also installs installFormulaCopy (the tests import this file in Node).

/** KaTeX: an invalid formula shows its source, `\href` and other trusted commands stay off. */
export const katexOptions = { throwOnError: false, strict: 'ignore', trust: false, maxExpand: 1000 } as const;

const katexClasses = new Set(['katex', 'katex-display', 'katex-error']);
/** A formula KaTeX rendered (or could not): other rehype passes leave its inside alone. */
export function isKatex(element: Element) {
  const classes = element.properties.className;
  return Array.isArray(classes) && classes.some(name => katexClasses.has(String(name)));
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
