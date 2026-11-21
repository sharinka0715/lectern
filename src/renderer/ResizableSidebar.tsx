import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { t } from '../shared/i18n';

const storageKey = "lectern.sidebar.width";
const defaultWidth = 304;
const minWidth = 208;
const maxWidth = 480;
const minChatWidth = 500;

function loadWidth() {
  try {
    const saved = Number(localStorage.getItem(storageKey));
    if (Number.isInteger(saved) && saved >= minWidth && saved <= maxWidth) return saved;
  } catch { /* A read-only profile can still resize for this window. */ }
  return defaultWidth;
}

export function ResizableSidebar({ children }: { children: ReactNode }) {
  const sidebar = useRef<HTMLElement>(null);
  const drag = useRef<{ id: number; startX: number; startWidth: number } | null>(null);
  const [preferred, setPreferred] = useState(loadWidth);
  const [draft, setDraft] = useState<number | null>(null);
  const [available, setAvailable] = useState(() => window.innerWidth);

  useLayoutEffect(() => {
    // The group contains the sidebar and the chat panes. Each pane holds its
    // own activity and file panels, which dock or overlay within the pane.
    const group = sidebar.current!.parentElement!;
    const measure = () => setAvailable(group.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(group);
    return () => observer.disconnect();
  }, []);

  const limit = Math.max(minWidth, Math.min(maxWidth, available - minChatWidth));
  const clamp = (value: number) => Math.max(minWidth, Math.min(limit, Math.round(value)));
  const width = clamp(draft ?? preferred);
  useLayoutEffect(() => {
    const frame = sidebar.current?.closest<HTMLElement>(".desktop-window");
    frame?.style.setProperty("--titlebar-rail-width", width + "px");
  }, [width]);

  function remember(value: number) {
    setPreferred(value);
    try { localStorage.setItem(storageKey, String(value)); } catch { /* Keep the in-memory preference. */ }
  }
  function stopDrag() {
    drag.current = null;
    setDraft(null);
  }

  return (
    <aside ref={sidebar} id="workspace-sidebar" className="sidebar" style={{ width }}>
      {children}
      <div
        className="sidebar-separator"
        role="separator"
        aria-label={t('workbench.resizeSidebar')}
        aria-controls="workspace-sidebar"
        aria-orientation="vertical"
        aria-valuemin={minWidth}
        aria-valuemax={limit}
        aria-valuenow={width}
        aria-valuetext={t('workbench.pixels', { width })}
        title={t('workbench.resizeSidebarTitle')}
        onDoubleClick={() => remember(defaultWidth)}
        tabIndex={0}
        data-dragging={draft !== null || undefined}
        onPointerDown={event => {
          if (!event.isPrimary || event.button !== 0 || drag.current) return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { id: event.pointerId, startX: event.clientX, startWidth: width };
          setDraft(width);
        }}
        onPointerMove={event => {
          const start = drag.current;
          if (start?.id === event.pointerId) setDraft(clamp(start.startWidth + event.clientX - start.startX));
        }}
        onPointerUp={event => {
          const start = drag.current;
          if (start?.id !== event.pointerId) return;
          const next = clamp(start.startWidth + event.clientX - start.startX);
          if (next !== start.startWidth) remember(next);
          stopDrag();
        }}
        onPointerCancel={event => { if (drag.current?.id === event.pointerId) stopDrag(); }}
        onLostPointerCapture={event => { if (drag.current?.id === event.pointerId) stopDrag(); }}
        onKeyDown={event => {
          if (drag.current || event.altKey || event.ctrlKey || event.metaKey) return;
          let next: number;
          switch (event.key) {
            case "ArrowLeft": next = clamp(width - 16); break;
            case "ArrowRight": next = clamp(width + 16); break;
            case "Home": next = minWidth; break;
            case "End": next = limit; break;
            default: return;
          }
          event.preventDefault();
          if (next !== width) remember(next);
        }}
      />
    </aside>
  );
}
