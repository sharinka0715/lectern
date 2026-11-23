// Where the keyboard goes when the input box cannot send for a moment (a
// message being sent, a reply starting or ending, a setting switch, a card).
// The DOM wiring is in useComposerFocus.ts; the decisions are here.

/**
 * How the input box is locked while nothing can be sent from it. A disabled
 * textarea loses the focus, and the caret with it, for good; so the box the
 * user is in stays as it is (`holding`): typing, an input method included, goes
 * on into the draft, and only sending, queueing and steering wait. A box
 * without the focus is disabled.
 */
export function composerLock(input: { canType: boolean; focused: boolean }) {
  return { disabled: !input.canType && !input.focused, holding: !input.canType && input.focused };
}

/**
 * Where a focus or a click is, seen from one chat's input area: its input box,
 * the rest of that area (the box's buttons and menus, the permission, question
 * and trust cards that stand in for it, the queue and rewind panels above it),
 * or anywhere else (the sidebar, the terminal, the transcript, the other split
 * pane, a dialog).
 */
export type FocusPlace = 'input' | 'area' | 'other';
export type Selection = [start: number, end: number, direction: 'forward' | 'backward' | 'none'];

export interface FocusMemory {
  /** The focus fell out of the input area to nowhere: it goes back to the input box once that can be typed into. */
  pending?: { scope: string; selection?: Selection; text?: string };
  /** The last click was outside the input area: a focus it drops was the user's choice. */
  away: boolean;
}

export type FocusEvent =
  | { kind: 'pointerdown'; place: FocusPlace }
  | { kind: 'focusin' }
  /** The focus left `from` for no element (its control was removed or disabled; not a switch to another window). */
  | { kind: 'dropped'; from: FocusPlace; scope: string; selection?: Selection; text?: string }
  /** The chat asks for the box (after a send, after refusing a permission). */
  | { kind: 'request'; scope: string };

export function noteFocus(memory: FocusMemory, event: FocusEvent): FocusMemory {
  switch (event.kind) {
    case 'pointerdown':
      return event.place === 'other' ? { away: true } : { ...memory, away: false };
    case 'focusin':
      // The focus has a home again (the box itself, or a place someone chose).
      return { away: false };
    case 'dropped':
      if (event.from === 'other' || memory.away) return memory;
      return { away: false, pending: { scope: event.scope, selection: event.selection, text: event.text } };
    case 'request':
      // A send that finishes after the user clicked elsewhere does not call them back.
      if (memory.away) return memory;
      return { ...memory, pending: memory.pending?.scope === event.scope ? memory.pending : { scope: event.scope } };
  }
}

/**
 * What a pending return does now: `focus` the box, `wait` until it can be
 * typed into, or `drop` it (another chat is shown, or the focus is somewhere
 * again, including the box itself). Undefined when nothing is pending.
 */
export function focusReturnStep(memory: FocusMemory, now: { scope: string; typeable: boolean; active: FocusPlace | 'none' }) {
  if (!memory.pending) return undefined;
  if (memory.pending.scope !== now.scope || now.active !== 'none') return 'drop' as const;
  return now.typeable ? 'focus' as const : 'wait' as const;
}
