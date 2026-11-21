import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Folder,
  PanelLeft,
  Server,
} from "lucide-react";
import type { ChatView, Workspace } from "../shared/types";
import {
  orderProjects,
  sameChat,
  setDesktop,
  showChat,
  useDesktopState,
  type ChatTarget,
} from "./desktop-state";
import "./window-titlebar.css";
import { t } from '../shared/i18n';

type Trail = { entries: ChatTarget[]; index: number };
const emptyTrail: Trail = { entries: [], index: -1 };

function rememberVisit(trail: Trail, target: ChatTarget | null): Trail {
  if (!target || sameChat(trail.entries[trail.index] ?? null, target))
    return trail;
  const entries = trail.entries.slice(0, trail.index + 1);
  const last = entries.at(-1);
  // Opening a directory first publishes its ID and then its discovered conversation.
  if (last?.workspaceId === target.workspaceId && !last.sessionId)
    entries.pop();
  entries.push(target);
  if (entries.length > 100) entries.shift();
  return { entries, index: entries.length - 1 };
}

export function WindowTitlebar({
  workspaces,
  platform,
}: {
  workspaces: Workspace[];
  platform: string;
}) {
  const state = useDesktopState();
  const selected = state.panes[state.active];
  const workspace = workspaces.find((w) => w.id === selected?.workspaceId);
  const [trails, setTrails] = useState<Record<ChatView, Trail>>({
    primary: emptyTrail,
    secondary: emptyTrail,
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const ordered = orderProjects(workspaces, state.projectOrder);

  useLayoutEffect(() => {
    setTrails((previous) => {
      const primary = rememberVisit(previous.primary, state.panes.primary);
      const secondary = state.split
        ? rememberVisit(previous.secondary, state.panes.secondary)
        : emptyTrail;
      return primary === previous.primary && secondary === previous.secondary
        ? previous
        : { primary, secondary };
    });
  }, [state.panes, state.split]);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    const menu = menuRef.current;
    const item =
      menu?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
      menu?.querySelector<HTMLButtonElement>("button");
    item?.focus({ preventScroll: true });
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target) &&
        !triggerRef.current?.contains(event.target)
      )
        setMenuOpen(false);
    };
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("blur", close);
    function close() {
      setMenuOpen(false);
    }
    return () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("blur", close);
    };
  }, [menuOpen]);

  const trail = trails[state.active];
  // Back and forward skip a conversation the other pane shows: one conversation, one pane.
  const otherPane = state.split ? state.panes[state.active === "primary" ? "secondary" : "primary"] : null;
  const nextIndex = (step: 1 | -1) => {
    for (
      let i = trail.index + step;
      i >= 0 && i < trail.entries.length;
      i += step
    ) {
      const entry = trail.entries[i];
      if (entry.sessionId && sameChat(entry, otherPane)) continue;
      if (workspaces.some((w) => w.id === entry.workspaceId))
        return i;
    }
    return -1;
  };
  function navigate(index: number) {
    if (index < 0) return;
    setMenuOpen(false);
    setTrails((previous) => ({
      ...previous,
      [state.active]: { ...trail, index },
    }));
    showChat(state.active, trail.entries[index]);
  }
  function closeMenu() {
    setMenuOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }
  function choose(item: Workspace) {
    closeMenu();
    if (item.id !== workspace?.id)
      showChat(state.active, {
        workspaceId: item.id,
        sessionId: "",
        title: "",
      });
  }

  const back = nextIndex(-1);
  const forward = nextIndex(1);
  const sidebarLabel = state.sidebarOpen ? t('workbench.collapseSidebar') : t('workbench.expandSidebar');
  return (
    <header
      className="window-titlebar"
      data-platform={platform}
      aria-label={t('workbench.titlebar')}
    >
      <div className="window-titlebar-safe">
        <div
          className="window-navigation"
          data-sidebar={state.sidebarOpen ? "open" : "closed"}
        >
          <button
            type="button"
            className="icon-button"
            aria-label={t('workbench.back')}
            title={t('workbench.back')}
            disabled={back < 0}
            onClick={() => navigate(back)}
          >
            <ArrowLeft size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t('workbench.forward')}
            title={t('workbench.forward')}
            disabled={forward < 0}
            onClick={() => navigate(forward)}
          >
            <ArrowRight size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={sidebarLabel}
            title={sidebarLabel}
            aria-controls="workspace-sidebar"
            aria-expanded={state.sidebarOpen}
            onClick={() => setDesktop({ sidebarOpen: !state.sidebarOpen })}
          >
            <PanelLeft size={16} />
          </button>
        </div>
        <div className="window-project">
          <button
            type="button"
            ref={triggerRef}
            className="window-project-trigger"
            aria-label={t('workbench.switchFolder')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? "window-project-menu" : undefined}
            title={
              workspace
                ? workspace.name + " · " + workspace.cwd
                : t('workbench.chooseFolder')
            }
            disabled={!ordered.length}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setMenuOpen(true);
              }
            }}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Folder size={17} />
            <span>{workspace?.name || t('workbench.chooseFolder')}</span>
            <ChevronDown size={13} />
          </button>
          {menuOpen && (
            <div
              ref={menuRef}
              className="window-project-menu"
              role="menu"
              id="window-project-menu"
              aria-label={t('workbench.folders')}
              onBlur={(event) => {
                if (
                  event.relatedTarget &&
                  event.relatedTarget !== triggerRef.current &&
                  !event.currentTarget.contains(event.relatedTarget)
                )
                  setMenuOpen(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeMenu();
                  return;
                }
                const buttons = Array.from(
                  event.currentTarget.querySelectorAll("button"),
                );
                const at = buttons.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                const last = buttons.length - 1;
                const index =
                  event.key === "ArrowDown"
                    ? (at + 1) % buttons.length
                    : event.key === "ArrowUp"
                      ? (at - 1 + buttons.length) % buttons.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? last
                          : -1;
                if (index >= 0) {
                  event.preventDefault();
                  buttons[index].focus();
                }
              }}
            >
              {ordered.map((item) => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-label={item.name}
                  aria-checked={workspace?.id === item.id}
                  key={item.id}
                  onClick={() => choose(item)}
                >
                  {item.kind === "ssh" ? (
                    <Server size={15} />
                  ) : (
                    <Folder size={15} />
                  )}
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      {item.host ? item.host + " · " : ""}
                      {item.cwd}
                    </small>
                  </span>
                  {workspace?.id === item.id && <Check size={15} />}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
