import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Columns2, Rows2, X } from "lucide-react";
import {
  chatDragType,
  closeSplit,
  currentChatDrag,
  dropChat,
  focusChat,
  planChatDrop,
  readDraggedChat,
  setDesktop,
  splitChat,
  useDesktopState,
  type ChatTarget,
  type SplitEdge,
} from "./desktop-state";
import type { ChatView } from "../shared/types";
import { t } from '../shared/i18n';

export function SplitButtons({
  view,
  alternative,
  connect,
}: {
  view: ChatView;
  alternative: ChatTarget | null;
  connect(target: ChatTarget): boolean | Promise<boolean>;
}) {
  const state = useDesktopState();
  const open = (edge: SplitEdge) => {
    const ready = alternative ? connect(alternative) : true;
    if (ready === true) splitChat(alternative, edge, view);
    else if (ready) void ready.then(connected => { if (connected) splitChat(alternative, edge, view); });
  };
  return state.split ? (
    <>
      <button
        className="icon-button"
        aria-label={t('workbench.toggleDirection')}
        title={t('workbench.toggleDirection')}
        onClick={() =>
          setDesktop({
            direction: state.direction === "rows" ? "columns" : "rows",
          })
        }
      >
        {state.direction === "rows" ? (
          <Columns2 size={16} />
        ) : (
          <Rows2 size={16} />
        )}
      </button>
      <button
        className="icon-button"
        aria-label={t('workbench.closePane')}
        title={t('workbench.closePane')}
        onClick={() => closeSplit(view)}
      >
        <X size={15} />
      </button>
    </>
  ) : (
    <button
      className="icon-button"
      aria-label={t('workbench.openSideBySide')}
      title={t('workbench.openSideBySide')}
      onClick={() => open("right")}
    >
      <Columns2 size={16} />
    </button>
  );
}

export function SplitWorkspace({
  view,
  children,
  second,
}: {
  view: ChatView;
  children: ReactNode;
  second?: ReactNode;
}) {
  const state = useDesktopState();
  const group = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ width: 1000, height: 800 });
  // undefined: no conversation is being dragged; null: one from elsewhere, not known until the drop.
  const [dragChat, setDragChat] = useState<ChatTarget | null>();
  const [over, setOver] = useState<SplitEdge | null>(null);
  const [changing, setChanging] = useState<number | null>(null);
  const handle = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = group.current;
    if (!el) return;
    const resize = () =>
      setArea({ width: el.clientWidth, height: el.clientHeight });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    return () => observer.disconnect();
  }, [view]);
  if (view === "secondary") return <>{children}</>;
  const rows = area.width < 770 || state.direction === "rows";
  const minimum = Math.max(
    0.25,
    Math.min(
      0.5,
      (rows ? 235 : 345) / Math.max(1, (rows ? area.height : area.width) - 6),
    ),
  );
  const cap = (n: number) => Math.max(minimum, Math.min(1 - minimum, n));
  const ratio = cap(changing ?? state.ratio);
  const pointerRatio = (e: React.PointerEvent) => {
    const r = group.current!.getBoundingClientRect();
    return cap(
      rows ? (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width,
    );
  };
  function drop(e: React.DragEvent, edge: SplitEdge) {
    e.preventDefault();
    e.stopPropagation();
    setOver(null);
    setDragChat(undefined);
    const item = readDraggedChat(e.dataTransfer);
    if (item) dropChat(item, edge);
  }
  // The only conversation on screen cannot split off a copy of itself.
  const onlyItself = !state.split && dragChat !== undefined && planChatDrop(state, dragChat, "right").kind === "none";
  return (
    <div
      ref={group}
      className={"split-workspace" + (state.split ? " divided" : "")}
      data-direction={rows ? "rows" : "columns"}
      style={{ "--pane-ratio": ratio } as React.CSSProperties}
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes(chatDragType)) {
          e.preventDefault();
          setDragChat(currentChatDrag());
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(chatDragType)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = onlyItself ? "none" : "copy";
        }
      }}
      onDragLeave={(e) => {
        if (!(
          e.relatedTarget instanceof Node &&
          e.currentTarget.contains(e.relatedTarget)
        )) {
          setDragChat(undefined);
          setOver(null);
        }
      }}
      onDragEnd={() => {
        setDragChat(undefined);
        setOver(null);
      }}
    >
      <div
        className="desk-pane"
        data-view="primary"
        data-active={state.active === "primary"}
        onPointerDownCapture={() => focusChat("primary")}
        onFocusCapture={() => focusChat("primary")}
      >
        {children}
      </div>
      {state.split && (
        <>
          <div
            className="split-separator"
            role="separator"
            aria-label={t('workbench.resizeSplit')}
            aria-orientation={rows ? "horizontal" : "vertical"}
            aria-valuemin={Math.round(minimum * 100)}
            aria-valuemax={Math.round((1 - minimum) * 100)}
            aria-valuenow={Math.round(100 * ratio)}
            tabIndex={0}
            onPointerDown={(e) => {
              if (e.button !== 0 || !e.isPrimary) return;
              e.preventDefault();
              e.currentTarget.focus();
              e.currentTarget.setPointerCapture(e.pointerId);
              handle.current = e.pointerId;
              setChanging(ratio);
            }}
            onPointerMove={(e) => {
              if (handle.current === e.pointerId) setChanging(pointerRatio(e));
            }}
            onPointerUp={(e) => {
              if (handle.current === e.pointerId) {
                setDesktop({ ratio: pointerRatio(e) });
                handle.current = null;
                setChanging(null);
              }
            }}
            onLostPointerCapture={() => {
              handle.current = null;
              setChanging(null);
            }}
            onKeyDown={(e) => {
              const keys = rows
                ? ["ArrowUp", "ArrowDown"]
                : ["ArrowLeft", "ArrowRight"];
              const i = keys.indexOf(e.key);
              if (i >= 0 || e.key === "Home" || e.key === "End") {
                e.preventDefault();
                setDesktop({
                  ratio: cap(
                    e.key === "Home"
                      ? 0
                      : e.key === "End"
                        ? 1
                        : ratio + (i ? 0.05 : -0.05),
                  ),
                });
              }
            }}
          />
          <div
            className="desk-pane"
            data-view="secondary"
            data-active={state.active === "secondary"}
            onPointerDownCapture={() => focusChat("secondary")}
            onFocusCapture={() => focusChat("secondary")}
          >
            {second}
          </div>
        </>
      )}
      {onlyItself && (
        <div className="split-drop-zones single" role="status">
          <div className="split-drop-hint">{t('workbench.alreadyShown')}</div>
        </div>
      )}
      {dragChat !== undefined && !onlyItself && (
        <div
          className={"split-drop-zones " + (state.split ? "two" : "")}
          data-axis={rows ? "y" : "x"}
        >
          {(state.split
            ? rows
              ? ["top", "bottom"]
              : ["left", "right"]
            : ["left", "right", "top", "bottom"]
          ).map((e) => {
            const edge = e as SplitEdge,
              label = t(({
                left: 'workbench.edgeLeft',
                right: 'workbench.edgeRight',
                top: 'workbench.edgeTop',
                bottom: 'workbench.edgeBottom',
              } as const)[edge]);
            const plan = planChatDrop(state, dragChat ?? null, edge);
            return (
              <div
                key={edge}
                className={"split-drop " + edge + (over === edge ? " over" : "") + (plan.kind === "none" ? " disabled" : "") + (plan.kind === "merge" ? " merge" : "")}
                data-drop-plan={plan.kind}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setOver(edge);
                }}
                onDragOver={(event) => {
                  if (plan.kind !== "none") return;
                  // Its own side: nothing to drop.
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = "none";
                }}
                onDrop={(event) => drop(event, edge)}
              >
                {plan.kind === "merge" ? t('workbench.mergeSingle') : t(plan.kind === "none" ? 'workbench.alreadyHere' : state.split ? 'workbench.openAt' : 'workbench.splitAt', { edge: label })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
