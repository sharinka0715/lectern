/**
 * New content fades in and removed content fades out (content-fade.css).
 *
 * A MutationObserver sees which elements React adds and removes. Only some of
 * them count (the rules): a message, a block of a reply, a card above the input
 * box. An added one gets `data-fade="in"` once (a CSS animation, then the
 * attribute goes); a removed one is put back where it was with `data-leaving`
 * (inert, hidden from assistive technology) until its fade-out ends. An addition
 * that takes a removed element's place (same parent, same pairing key: the
 * "sending" bubble and the saved one, a paragraph that became a list) changes in
 * place: neither fades. Nothing fades in a quiet batch (a conversation shown for
 * the first time or again, an older page, another reply detail) or with reduced
 * motion.
 */
export const FADE_ENTER_MS = 200;
export const FADE_LEAVE_MS = 180;
/** After a view first shows content: what arrives meanwhile (the read catching up) does not fade. */
export const FADE_SETTLE_MS = 600;
/** More removals at once (another page, a long rewind) go at once. */
export const MAX_LEAVING = 12;

/** collapse: fades and gives back its height; pin: fades where it was, out of the flow; fade: fades only (already positioned). */
export type LeaveMode = 'collapse' | 'pin' | 'fade';

export interface FadeRemoval<N> { node: N; previous: N | null; next: N | null }
/** One childList change, as MutationRecord reports it. */
export interface FadeRecord<N> { target: N; added: readonly N[]; removed: readonly FadeRemoval<N>[] }

export interface FadeRules<N> {
  /** Fades in when it appears under this parent. */
  enters(node: N, parent: N): boolean;
  /** Fades out when it leaves this parent. */
  leaves(node: N, parent: N): LeaveMode | undefined;
  /** An addition and a removal under the same parent with the same key are one element changing. */
  pairKey(node: N, parent: N): string | undefined;
  /** A stand-in ("waiting for Claude…"): what replaces it is new, and it leaves at once. */
  placeholder(node: N): boolean;
  /** The node's parent now (null: detached). */
  parentOf(node: N): N | null;
}

export interface FadeLeave<N> extends FadeRemoval<N> { parent: N; mode: LeaveMode }
export interface FadePlan<N> { enter: N[]; leave: FadeLeave<N>[] }

/**
 * What a batch of childList changes adds and removes for good, and which of those fade.
 * A node first seen removed was there before the batch: still attached at the end, it only
 * moved. A node first seen added is new: detached at the end, it came and went.
 */
export function planFades<N>(records: readonly FadeRecord<N>[], rules: FadeRules<N>, live: boolean): FadePlan<N> {
  const first = new Map<N, { added: true; parent: N } | { added: false; removal: FadeRemoval<N>; parent: N }>();
  for (const record of records) {
    for (const removal of record.removed) if (!first.has(removal.node)) first.set(removal.node, { added: false, removal, parent: record.target });
    for (const node of record.added) if (!first.has(node)) first.set(node, { added: true, parent: record.target });
  }
  const parents = new Map<N, { added: N[]; removed: FadeRemoval<N>[] }>();
  const at = (parent: N) => parents.get(parent) ?? parents.set(parent, { added: [], removed: [] }).get(parent)!;
  for (const [node, event] of first) {
    const now = rules.parentOf(node);
    if (event.added && now === event.parent) at(event.parent).added.push(node);
    else if (!event.added && now === null) at(event.parent).removed.push(event.removal);
  }
  const plan: FadePlan<N> = { enter: [], leave: [] };
  for (const [parent, { added, removed }] of parents) {
    const paired = new Set<N>();
    for (const { node } of removed) {
      if (rules.placeholder(node)) continue;
      const key = rules.pairKey(node, parent);
      const match = key === undefined ? undefined : added.find(item => !paired.has(item) && rules.pairKey(item, parent) === key);
      if (match !== undefined) paired.add(match).add(node);
    }
    if (!live) continue;
    for (const node of added) if (!paired.has(node) && rules.enters(node, parent)) plan.enter.push(node);
    for (const removal of removed) {
      const mode = paired.has(removal.node) || rules.placeholder(removal.node) ? undefined : rules.leaves(removal.node, parent);
      if (mode) plan.leave.push({ ...removal, parent, mode });
    }
  }
  if (plan.leave.length > MAX_LEAVING) plan.leave = [];
  return plan;
}

let motionQuery: MediaQueryList | undefined;
/** The system asks for less motion: nothing fades (content-fade.css has no rule for it, nothing gets the attributes). */
export const prefersReducedMotion = () => typeof matchMedia === 'function' && (motionQuery ??= matchMedia('(prefers-reduced-motion: reduce)')).matches;

const has = (element: Element | null | undefined, name: string) => !!element?.classList.contains(name);
const domParent = (node: Node) => node.parentNode;
const placeholder = (node: Node) => node instanceof Element && node.hasAttribute('data-fade-placeholder');

/** The conversation: messages, the blocks of a reply (paragraphs, code, list items, table rows),
 * tool and activity rows, images, the task list, and the jump-to-latest button. */
export const transcriptFades: FadeRules<Node> = {
  enters(node, parent) {
    if (!(node instanceof Element) || !(parent instanceof Element)) return false;
    if (has(parent, 'conversation')) return has(node, 'message') || has(node, 'conversation-tasks');
    if (has(parent, 'conversation-tasks')) return node.tagName === 'LI';
    if (has(parent, 'message')) return has(node, 'message-footer');
    if (has(parent, 'message-content') || has(parent, 'activity-rows')) return true;
    if (has(parent, 'transcript-area')) return has(node, 'scroll-latest');
    // Reply text only (not a tool's details): its blocks, then items of its lists and rows of its tables.
    const markdown = parent.closest('.markdown');
    if (!markdown || !has(markdown.parentElement, 'message-content')) return false;
    return parent === markdown || (node.tagName === 'LI' && (parent.tagName === 'UL' || parent.tagName === 'OL')) ||
      (node.tagName === 'TR' && parent.tagName === 'TBODY');
  },
  leaves(node, parent) {
    if (!(node instanceof Element) || !(parent instanceof Element)) return;
    if (has(parent, 'conversation') && has(node, 'message')) return 'collapse';
    if (has(parent, 'transcript-area') && has(node, 'scroll-latest')) return 'fade';
  },
  pairKey(node, parent) {
    if (!(node instanceof Element) || !(parent instanceof Element) || has(parent, 'transcript-area')) return;
    // The "sending" bubble and the saved one, a preview and the saved reply: one message.
    if (has(parent, 'conversation')) return has(node, 'message') ? `message:${node.getAttribute('data-role')}` : undefined;
    return 'block';
  },
  placeholder,
  parentOf: domParent,
};

/** Above the input box: question, permission and trust cards, bars, the progress pill, the queue
 * and rewind panels; the input box itself fades in again after a question. Leaving ones stay pinned
 * where they were while the input area settles to its new height. */
export const DOCK_ITEMS = 'section.question-card, .directory-trust-card, .resume-bar, .turn-progress, section.turn-queue, section.rewind-panel';
export const dockFades: FadeRules<Node> = {
  enters: node => node instanceof Element && node.matches(`${DOCK_ITEMS}, form.composer`),
  leaves: node => node instanceof Element && node.matches(DOCK_ITEMS) ? 'pin' : undefined,
  pairKey: () => undefined,
  placeholder,
  parentOf: domParent,
};

/** Where a pinned element was, relative to its container's bottom-left corner. */
export interface PinnedBox { left: number; bottom: number; width: number; height: number }

interface FadeOptions {
  /** Watch the whole subtree (the conversation) or only the container's children (the input area). */
  subtree: boolean;
  /** The box a `pin` element had before this change; without one it collapses in place. */
  pinned?: (element: Element) => PinnedBox | undefined;
  /** After elements were put back to fade out. */
  onLeave?: (leaving: HTMLElement[]) => void;
}

/** Applies the rules to one container (see the top of this file). */
export class FadeController {
  private observer: MutationObserver;
  private settleUntil = 0;
  private known = new WeakSet<Node>();
  /** Elements put back to fade out (their own insertion and removal are not React's), and their timers. */
  private ghosts = new WeakSet<Node>();
  private timers = new Map<Element, number>();

  constructor(private root: Element, private rules: FadeRules<Node>, private options: FadeOptions) {
    this.observer = new MutationObserver(records => this.apply(records, this.settled));
    this.observer.observe(root, { childList: true, subtree: options.subtree });
    root.addEventListener('animationend', this.finished);
    root.addEventListener('animationcancel', this.finished);
  }

  private get settled() { return performance.now() >= this.settleUntil; }

  /** Content shows for the first time (or again): it, and what follows within the settle time, does not fade. */
  settle(ms = FADE_SETTLE_MS) { this.settleUntil = performance.now() + ms; }

  /** Apply the changes React just made, from componentDidUpdate: quiet for history and new views. */
  flush(live: boolean) {
    const records = this.observer.takeRecords();
    if (records.length) this.apply(records, live && this.settled);
  }

  /** Fade these in now (already in the page, e.g. a first message sent from a new chat). */
  enter(elements: Iterable<Element>) {
    if (prefersReducedMotion()) return;
    for (const element of elements) this.fadeIn(element);
  }

  dispose() {
    this.observer.disconnect();
    this.root.removeEventListener('animationend', this.finished);
    this.root.removeEventListener('animationcancel', this.finished);
    for (const [ghost, timer] of this.timers) { window.clearTimeout(timer); ghost.remove(); }
    this.timers.clear();
  }

  private finished = (event: Event) => {
    const target = event.target;
    if (target instanceof Element && target.getAttribute('data-fade') === 'in' && /^lectern-(fade|rise)-in$/.test((event as AnimationEvent).animationName))
      target.removeAttribute('data-fade');
  };

  private fadeIn(element: Element) {
    this.known.add(element);
    element.setAttribute('data-fade', 'in');
  }

  private apply(records: MutationRecord[], live: boolean) {
    const batch: FadeRecord<Node>[] = [];
    for (const record of records) {
      if (record.type !== 'childList') continue;
      const added = [...record.addedNodes].filter(node => node instanceof Element && !this.ghosts.has(node));
      const removed: FadeRemoval<Node>[] = [];
      let previous = record.previousSibling;
      for (const node of record.removedNodes) {
        if (node instanceof Element && !this.ghosts.has(node)) removed.push({ node, previous, next: record.nextSibling });
        previous = node;
      }
      if (added.length || removed.length) batch.push({ target: record.target, added, removed });
    }
    if (!batch.length) return;
    const motion = live && !prefersReducedMotion();
    const plan = planFades(batch, this.rules, motion);
    for (const node of plan.enter) if (!this.known.has(node) && node instanceof Element) this.fadeIn(node);
    for (const record of batch) for (const node of record.added) this.known.add(node);
    if (!plan.leave.length) return;
    // Last removed first, each after the sibling it followed: consecutive ones keep their order.
    const leaving: HTMLElement[] = [];
    for (const { node, parent, previous, next, mode } of plan.leave.reverse()) {
      if (!(node instanceof HTMLElement) || node.isConnected) continue;
      if (previous && previous.parentNode === parent) parent.insertBefore(node, previous.nextSibling);
      else if (next && next.parentNode === parent) parent.insertBefore(node, next);
      else continue;
      this.leave(node, mode);
      leaving.push(node);
    }
    if (leaving.length) this.options.onLeave?.(leaving);
  }

  private leave(element: HTMLElement, mode: LeaveMode) {
    const box = mode === 'pin' ? this.options.pinned?.(element) : undefined;
    if (mode === 'pin' && !box) mode = 'collapse';
    if (box) Object.assign(element.style, { left: `${box.left}px`, bottom: `${box.bottom}px`, width: `${box.width}px`, height: `${box.height}px` });
    element.removeAttribute('data-fade');
    element.setAttribute('data-leaving', mode);
    element.setAttribute('aria-hidden', 'true');
    element.inert = true;
    this.ghosts.add(element);
    this.timers.set(element, window.setTimeout(() => {
      this.timers.delete(element);
      element.remove();
    }, FADE_LEAVE_MS + 40));
  }
}
