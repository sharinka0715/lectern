import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { composerLock, focusReturnStep, noteFocus, type FocusEvent as FocusNote, type FocusMemory, type FocusPlace, type Selection } from './composer-focus';

interface Options {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** This chat's input area: the box with its controls, and the cards shown with or in place of it. */
  area: HTMLElement | null;
  canType: boolean;
  /** The chat the box belongs to: a return pending for another chat is dropped. */
  scope: string;
  /** A permission, question or trust card is shown: the box waits for it. */
  card: boolean;
}

/** The parts of an input area the focus comes back from: the box's form, the cards, the queue and rewind panels above it. */
const areaParts = 'form.composer, .question-card, .directory-trust-card, .turn-queue, .rewind-panel';

/**
 * Keeps the keyboard in the input box across the moments nothing can be sent
 * from it. The box the user is in is not disabled (`lock.holding`): it keeps
 * the focus, the caret and the selection, and what is typed meanwhile, an input
 * method's composition included, goes into the draft; only sending waits (the
 * caller keeps `aria-disabled` on it and the send button disabled). A box
 * without the focus is disabled as before. A focus that falls out of the input
 * area to nowhere — a card answered and gone, a send or stop button disabled or
 * replaced, a menu closed, the box itself replaced by a question card — comes
 * back to the box (caret and selection as they were) once it can be typed into
 * again, unless the user has clicked or focused anything else meanwhile. Each
 * split pane's input area keeps its own; one never takes the focus from the other.
 */
export function useComposerFocus({ inputRef, area, canType, scope, card }: Options) {
  const [focused, setFocused] = useState(false);
  const memory = useRef<FocusMemory>({ away: false });
  const latest = useRef({ area, canType, scope, card });
  latest.current = { area, canType, scope, card };
  // React detaches the ref before it removes the box (a question card replacing it): match it by place too.
  const isBox = useCallback((node: EventTarget | null): node is HTMLTextAreaElement => node === inputRef.current ||
    (node instanceof HTMLTextAreaElement && !!latest.current.area?.contains(node) && node.matches('form.composer textarea')), [inputRef]);
  const place = useCallback((node: EventTarget | null): FocusPlace => {
    if (isBox(node)) return 'input';
    return node instanceof Element && latest.current.area?.contains(node) && node.closest(areaParts) ? 'area' : 'other';
  }, [isBox]);
  const apply = useCallback(() => {
    const input = inputRef.current, { canType, scope, card } = latest.current, active = document.activeElement;
    const step = focusReturnStep(memory.current, { scope, active: !active || active === document.body ? 'none' : place(active),
      typeable: !!input && canType && !card && !input.disabled });
    if (!step || step === 'wait') return;
    const { selection, text } = memory.current.pending!;
    memory.current = { ...memory.current, pending: undefined };
    if (step === 'drop' || !input) return;
    input.focus({ preventScroll: true });
    if (selection && text === input.value) input.setSelectionRange(...selection);
  }, [inputRef, place]);
  const note = useCallback((event: FocusNote) => { memory.current = noteFocus(memory.current, event); }, []);

  useEffect(() => {
    let timer = 0;
    const pointerdown = (event: PointerEvent) => note({ kind: 'pointerdown', place: place(event.target) });
    const focusin = (event: FocusEvent) => {
      note({ kind: 'focusin' });
      if (isBox(event.target)) setFocused(true);
    };
    const focusout = (event: FocusEvent) => {
      const from = event.target;
      // Switching to another window keeps the element focused in its document.
      if (from instanceof Element && document.activeElement === from) return;
      if (isBox(from)) setFocused(false);
      if (event.relatedTarget) return;
      const box = isBox(from) ? from : undefined;
      const selection: Selection | undefined = box && [box.selectionStart, box.selectionEnd, box.selectionDirection];
      note({ kind: 'dropped', from: place(from), scope: latest.current.scope, selection, text: box?.value });
      // Once the change that dropped it has settled (a new card takes the focus itself, in an effect).
      clearTimeout(timer);
      timer = window.setTimeout(apply);
    };
    const listeners = [['pointerdown', pointerdown], ['focusin', focusin], ['focusout', focusout]] as const;
    for (const [type, listener] of listeners) document.addEventListener(type, listener as EventListener, true);
    return () => {
      clearTimeout(timer);
      for (const [type, listener] of listeners) document.removeEventListener(type, listener as EventListener, true);
    };
  }, [isBox, place, apply, note]);
  // Every change may be the one that makes the box typeable again.
  useEffect(apply);

  /** Bring the focus to the box now or once it can be typed into, unless it is (or goes) somewhere else. */
  const request = useCallback(() => { note({ kind: 'request', scope: latest.current.scope }); apply(); }, [note, apply]);
  return { lock: composerLock({ canType, focused }), request };
}
