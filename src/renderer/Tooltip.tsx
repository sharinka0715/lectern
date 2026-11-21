import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Hover card props: a short name and, optionally, what it means in more detail
 * (lines separated by "\n"). Shown by <TooltipHost/> instead of the native title,
 * which appears late and holds one plain line.
 */
export function tip(title: string, detail?: string | false) {
  return { "data-tip": title, ...(detail ? { "data-tip-detail": detail } : {}) };
}

const delay = 300;
type Shown = { element: HTMLElement; title: string; detail?: string };
const read = (element: HTMLElement): Shown => ({ element, title: element.dataset.tip ?? "", detail: element.dataset.tipDetail });

/** One floating card for every element with `data-tip`: on hover after a moment, or at once on keyboard focus. */
export function TooltipHost() {
  const [shown, setShown] = useState<Shown>();
  const [place, setPlace] = useState<{ left: number; top: number; below: boolean }>();
  const card = useRef<HTMLDivElement>(null);
  const visible = useRef(false);
  visible.current = !!shown;

  useEffect(() => {
    let timer = 0, current: HTMLElement | undefined, where: DOMRect | undefined, x = 0, y = 0;
    const hide = () => { window.clearTimeout(timer); timer = 0; current = undefined; setShown(undefined); };
    const owner = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>("[data-tip]") ?? undefined : undefined;
    const arm = (element: HTMLElement) => {
      window.clearTimeout(timer);
      current = element;
      where = element.getBoundingClientRect();
      // Moving from one button to the next while a card is up shows the next at once.
      timer = window.setTimeout(() => {
        timer = 0;
        // React may have replaced the element meanwhile (stop turning back into send):
        // take whatever now sits under the pointer.
        const target = current?.isConnected ? current : owner(document.elementFromPoint(x, y));
        if (!target) return;
        current = target;
        setShown(read(target));
      }, visible.current ? 0 : delay);
    };
    const over = (event: PointerEvent) => {
      x = event.clientX; y = event.clientY;
      const element = owner(event.target);
      if (element === current) return;
      if (!element) { window.clearTimeout(timer); timer = 0; current = undefined; setShown(undefined); return; }
      arm(element);
    };
    // A card cancelled while the pointer stayed put comes back with the next movement.
    const move = (event: PointerEvent) => {
      x = event.clientX; y = event.clientY;
      const element = owner(event.target);
      if (element && !timer && !visible.current) arm(element);
    };
    const out = (event: PointerEvent) => { if (!event.relatedTarget) hide(); };
    const focus = (event: FocusEvent) => {
      const element = owner(event.target);
      if (element && (event.target as Element).matches(":focus-visible")) { current = element; setShown(read(element)); }
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    // Only a scroll that moves the element (or focus leaving it) ends its card: the chat
    // scrolls to its latest message all through a reply, and must not cancel the composer's cards.
    const scrolled = (event: Event) => {
      if (!current || !(event.target instanceof Node) || !event.target.contains(current)) return;
      const now = current.getBoundingClientRect();
      if (!where || now.top !== where.top || now.left !== where.left) hide();
    };
    const left = (event: FocusEvent) => { if (current && event.target instanceof Node && current.contains(event.target)) hide(); };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerout", out);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", left);
    document.addEventListener("keydown", key, true);
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("blur", hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", left);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  // Figures in a card (countdowns, usage) follow the element while it is shown.
  useEffect(() => {
    if (!shown) return;
    const timer = window.setInterval(() => {
      if (!shown.element.isConnected || !shown.element.dataset.tip) { setShown(undefined); return; }
      const next = read(shown.element);
      if (next.title !== shown.title || next.detail !== shown.detail) setShown(next);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [shown]);

  // Above the element, centred and kept on screen; below it when there is no room above.
  useLayoutEffect(() => {
    if (!shown || !card.current) { setPlace(undefined); return; }
    const target = shown.element.getBoundingClientRect(), box = card.current.getBoundingClientRect();
    const left = Math.min(Math.max(8, target.left + target.width / 2 - box.width / 2), window.innerWidth - box.width - 8);
    const above = target.top - box.height - 8;
    setPlace(above >= 8 ? { left, top: above, below: false } : { left, top: Math.min(target.bottom + 8, window.innerHeight - box.height - 8), below: true });
  }, [shown]);

  if (!shown) return null;
  return createPortal(<div ref={card} className="hover-tip" role="tooltip" data-below={place?.below || undefined}
    style={place ? { left: place.left, top: place.top } : { left: 0, top: 0, visibility: "hidden" }}>
    <strong>{shown.title}</strong>
    {shown.detail?.split("\n").filter(Boolean).map((line, index) => <p key={index}>{line}</p>)}
  </div>, document.body);
}
