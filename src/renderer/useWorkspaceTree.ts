import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo, SessionSnapshot, Workspace, WorkspaceDiscovery } from "../shared/types";
import { forgetTreeReceipts, observeTreeSessions, onReceiptChange, readTreeSession, workspaceReceipts } from './sidebar-receipts';
import {
  discoveryLane,
  plannedReads,
  WorkspaceDiscoveryCache,
  type WorkspaceDiscoveryState,
} from "./workspace-discovery-cache";
import { reportDiagnostic } from "./diagnostics";
import { machineDisconnected, reportMachineResult } from "./ssh-machines";
import { noteFolderRead } from "./host-tools";
import { desktopState, setSidebarFolds, useDesktopState } from "./desktop-state";

// Both split views can have an in-flight directory scan when a sidebar edit finishes.
const onRename = new Set<(workspaceId: string, session: SessionInfo) => void>();
export async function renameTreeSession(workspaceId: string, sessionId: string, title: string) {
  const updated = await window.desktop.renameSession(workspaceId, sessionId, title);
  for (const apply of onRename) apply(workspaceId, updated);
}

/** Background reads started at once per lane (machine). */
const laneSlots = 2;

/** `focus`: folders of the chats on screen; with the expanded ones they are read first. */
export function useWorkspaceTree(workspaces: Workspace[], visible: boolean, remember = false, reading?: SessionSnapshot, focus: readonly string[] = []) {
  const [receiptRevision, setReceiptRevision] = useState(0);
  useEffect(() => onReceiptChange(() => setReceiptRevision(n => n + 1)), []);
  const [readable, setReadable] = useState(false);
  useEffect(() => window.desktop?.onWindowReadable(setReadable), []);
  const readingWorkspace = workspaces.find(w => w.id === reading?.workspaceId);
  const position = reading?.transcriptPosition;
  useEffect(() => {
    // A selected tab is not a receipt. Wait for a consumed snapshot in the
    // active split, including on refocus without a subsequent transcript write.
    if (readable && readingWorkspace && reading && position && reading.status !== 'connecting' && reading.status !== 'offline') {
      readTreeSession(readingWorkspace, reading.sessionId, position);
    }
  }, [readable, readingWorkspace, reading?.sessionId, reading?.status, position?.inode, position?.offset]);
  const [states, setStates] = useState<Record<string, WorkspaceDiscoveryState>>(
    {},
  );
  // The sidebar's tree keeps its open folders in the preferences (desktop-state's
  // sidebarFolds), across sort modes and restarts; another view's tree keeps its own.
  const savedFolders = useDesktopState().sidebarFolds.expandedFolders;
  const saved = useMemo(() => new Set(savedFolders), [savedFolders]);
  const [own, setOwn] = useState(() => new Set<string>());
  const expanded = remember ? saved : own;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const setExpanded = useCallback((next: Set<string>) => {
    expandedRef.current = next;
    if (remember) setSidebarFolds({ expandedFolders: [...next] });
    else setOwn(next);
  }, [remember]);
  const workspacesRef = useRef(workspaces);
  const visibleRef = useRef(visible);
  const focusRef = useRef(focus);
  const tickRef = useRef<(() => void) | undefined>(undefined);
  workspacesRef.current = workspaces;
  visibleRef.current = visible;
  focusRef.current = focus;
  const signatures = useRef(new Map<string, string>());
  const cacheRef = useRef<WorkspaceDiscoveryCache | undefined>(undefined);
  const cache = useCallback(() => {
    if (!cacheRef.current)
      cacheRef.current = new WorkspaceDiscoveryCache(
        (id) => {
          const ws = workspacesRef.current.find(w => w.id === id);
          if (ws?.kind === "ssh" && machineDisconnected(ws)) return Promise.resolve(undefined);
          return window.desktop.discover(id, remember && ws ? workspaceReceipts(ws).receipts.baselines() : undefined);
        },
        setStates,
        {
          concurrency: laneSlots,
          lane: id => {
            const ws = workspacesRef.current.find(w => w.id === id);
            return ws ? discoveryLane(ws) : id;
          },
          onResult: (data, id) => {
            const ws = workspacesRef.current.find(w => w.id === id);
            if (remember && ws) observeTreeSessions(ws, data.sessions);
            if (ws?.kind === "ssh" && ws.host) reportMachineResult(ws.host, ws.port);
            // A machine whose folders are read gets its tmux / Claude Code check too.
            if (ws && remember) noteFolderRead(ws);
          },
          onError: (error, workspaceId) => {
            const ws = workspacesRef.current.find(w => w.id === workspaceId);
            if (ws?.kind === "ssh" && ws.host) reportMachineResult(ws.host, ws.port, error);
            if (ws && remember) noteFolderRead(ws, error);
            reportDiagnostic({
              kind: "action",
              message: `Reading folder conversations failed: ${error instanceof Error ? error.message : String(error)}`,
              stack: error instanceof Error ? error.stack : undefined,
              workspaceId,
              sessionId: undefined,
            });
          },
        },
      );
    return cacheRef.current;
  }, [remember]);
  const trackWorkspace = useCallback(
    (workspace: Workspace) => {
      const signature = JSON.stringify(workspace);
      const previous = signatures.current.get(workspace.id);
      signatures.current.set(workspace.id, signature);
      if (previous && previous !== signature) cache().invalidate(workspace.id);
    },
    [cache],
  );
  const refresh = useCallback((id: string) => {
    const ws = workspacesRef.current.find(w => w.id === id);
    if (ws?.kind === "ssh" && machineDisconnected(ws)) return Promise.resolve(undefined);
    return cache().refresh(id);
  }, [cache]);
  /** Reads the folder if due. `reveal` also opens it in the tree, which a list across
   * projects never does: the tree stays as the user left it. */
  const expand = useCallback(
    (workspace: Workspace, reveal: boolean | "always" = true) => {
      trackWorkspace(workspace);
      if (reveal && (reveal === "always" || !remember || desktopState().sidebarSort === "projects")
        && !expandedRef.current.has(workspace.id))
        setExpanded(new Set(expandedRef.current).add(workspace.id));
      const entry = cache().get(workspace.id);
      if (
        !entry?.data ||
        entry.error ||
        Date.now() - (entry.updatedAt ?? 0) >= 5000
      )
        void refresh(workspace.id);
    },
    [cache, refresh, trackWorkspace, remember, setExpanded],
  );
  const toggle = useCallback(
    (workspace: Workspace) => {
      if (expandedRef.current.has(workspace.id)) {
        const next = new Set(expandedRef.current);
        next.delete(workspace.id);
        setExpanded(next);
      } else expand(workspace, "always");
    },
    [expand, setExpanded],
  );
  const patch = useCallback(
    (id: string, update: (data?: WorkspaceDiscovery) => WorkspaceDiscovery) =>
      cache().patch(id, previous => {
        const data = update(previous), ws = workspacesRef.current.find(w => w.id === id);
        // Register a new pane before its first record. A patch is not a scan:
        // never replay an old file position or completedThrough from its cache.
        if (ws) observeTreeSessions(ws, data.sessions.filter(s => !s.path && s.paneId));
        return data;
      }),
    [cache],
  );
  const forget = useCallback(
    (id: string) => {
      cache().forget(id);
      forgetTreeReceipts(id);
      signatures.current.delete(id);
      if (expandedRef.current.has(id)) {
        const next = new Set(expandedRef.current);
        next.delete(id);
        setExpanded(next);
      }
    },
    [cache, setExpanded],
  );

  useEffect(() => {
    const ids = new Set(workspaces.map((workspace) => workspace.id));
    for (const id of signatures.current.keys()) if (!ids.has(id)) forget(id);
    for (const workspace of workspaces) trackWorkspace(workspace);
  }, [workspaces, forget, trackWorkspace]);

  useEffect(() => {
    const apply = (id: string, session: SessionInfo) => cacheRef.current?.applyRenamedSession(id, session);
    onRename.add(apply);
    const tick = () => {
      if (!remember || !window.desktop) return;
      // Even collapsed/never-expanded projects participate. Never fill the
      // interactive discovery queue with a backlog of cold directories: each
      // machine starts at most its free slots.
      const entries = cache();
      const reachable = workspacesRef.current.filter(ws => ws.kind !== "ssh" || !machineDisconnected(ws));
      for (const id of plannedReads(reachable, id => entries.get(id), { now: Date.now(), slots: laneSlots,
        expanded: expandedRef.current, visible: visibleRef.current, focus: focusRef.current })) void refresh(id);
    };
    tickRef.current = tick;
    tick();
    const timer = setInterval(tick, 2000);
    return () => {
      onRename.delete(apply);
      tickRef.current = undefined;
      clearInterval(timer);
      cacheRef.current?.dispose();
      cacheRef.current = undefined;
    };
  }, [cache, refresh, remember]);
  // Start as soon as the folder list arrives, not on the next 2-second tick.
  useEffect(() => { tickRef.current?.(); }, [workspaces]);
  const treeStates = useMemo(() => {
    const next = { ...states };
    for (const ws of workspaces) {
      const entry = states[ws.id];
      if (!entry?.data) continue;
      const { receipts } = workspaceReceipts(ws);
      next[ws.id] = { ...entry, unreadSessionIds: new Set(entry.data.sessions.filter(s => receipts.unread(s.id)).map(s => s.id)) };
    }
    return next;
  }, [states, workspaces, receiptRevision]);
  return {
    states: treeStates,
    expanded,
    refresh,
    expand,
    toggle,
    patch,
    forget,
    trackWorkspace,
  };
}
