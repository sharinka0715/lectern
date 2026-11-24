import { useSyncExternalStore } from "react";
import type { ChatView } from "../shared/types";
import { DEFAULT_HISTORY_PAGE_MIB, historyPageSizeMiB } from '../shared/history-paging';
import { markNavigated } from "./ssh-machines";
import { validTimeZone } from "./quota-time";
import { promptCacheTtlPreset, promptCacheTtlPresetOf, type PromptCacheTtlPreset } from "../shared/prompt-cache";

export interface ChatTarget {
  workspaceId: string;
  sessionId: string;
  title: string;
  /** A new chat in this folder that has not started yet (sessionId is ""). No
   * tmux pane or Claude process exists until its first message is sent. */
  draft?: true;
}
export type ReplyDetail = "compact" | "individual";
export type SidebarSortMode = "projects" | "recent" | "priority";
export type SplitDirection = "columns" | "rows";
export type SplitEdge = "left" | "right" | "top" | "bottom";
/** A conversation taken out of Lectern's sidebar. Its files on the target are untouched. */
export interface ArchivedSession { workspaceId: string; sessionId: string; title: string; archivedAt: string }
/** The groups of the lists across projects: one for 最近更新, two for 进行中优先. */
export const sidebarGroups = ["recent", "active", "other"] as const;
export type SidebarGroup = typeof sidebarGroups[number];
/**
 * What the user opened and closed in the sidebar, kept across sort modes and restarts.
 * Each part holds only what differs from the default: folders start closed, machines
 * and groups open, lists at their first page.
 */
export interface SidebarFolds {
  /** Project folders listing their conversations, by workspace id. */
  expandedFolders: string[];
  /** Machines folded away, by machine key (workspace-machines.ts' `machineKey`). */
  collapsedMachines: string[];
  /** Groups of the lists across projects folded away. */
  collapsedGroups: SidebarGroup[];
  /** How many conversations a folder lists once "展开更多" was used, by workspace id. */
  folderListed: Record<string, number>;
  /** How many conversations a group lists once "展开更多" was used. */
  groupListed: Partial<Record<SidebarGroup, number>>;
}
/** Before 0.2.3 only the expanded folders were kept, under a key of their own. */
export const legacyExpandedKey = "lectern.expanded-projects.v1";
const noFolds: SidebarFolds = { expandedFolders: [], collapsedMachines: [], collapsedGroups: [], folderListed: {}, groupListed: {} };
const foldLimit = 1000;
const keyList = (value: unknown) => Array.isArray(value)
  ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 1024))].slice(-foldLimit)
  : [];
const listedCount = (value: unknown) => Number.isInteger(value) && (value as number) > 0 && (value as number) <= 100_000;
/** Reads the stored folds; without them, the expanded folders of the legacy key. Anything malformed is dropped. */
export function sidebarFoldsOf(value: unknown, legacyExpanded?: string | null): SidebarFolds {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    try { return { ...noFolds, expandedFolders: keyList(JSON.parse(legacyExpanded ?? "[]")) }; } catch { return noFolds; }
  }
  const stored = value as Record<keyof SidebarFolds, unknown>;
  const counts = (value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value).filter(([key, count]) => key.length > 0 && key.length <= 1024 && listedCount(count)).slice(-foldLimit) : [];
  return {
    expandedFolders: keyList(stored.expandedFolders),
    collapsedMachines: keyList(stored.collapsedMachines),
    collapsedGroups: sidebarGroups.filter(group => keyList(stored.collapsedGroups).includes(group)),
    folderListed: Object.fromEntries(counts(stored.folderListed)),
    groupListed: Object.fromEntries(counts(stored.groupListed).filter(([group]) => (sidebarGroups as readonly string[]).includes(group))),
  };
}
export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port?: number;
}
export const defaultChatLayout = {
  chatLineHeight: 130,
  composerLineHeight: 135,
  toolSummaryFontSize: 13,
  conversationWidth: 1000,
};
export const maxConversationWidth = 1200;
// `label` is a message key (shown with t()).
export const chatLayoutRanges = [
  { key: "chatLineHeight", label: "prefs.chatLineHeight", min: 120, max: 190, step: 5, unit: "%" },
  { key: "composerLineHeight", label: "prefs.composerLineHeight", min: 120, max: 190, step: 5, unit: "%" },
  { key: "toolSummaryFontSize", label: "prefs.toolSummaryFontSize", min: 11, max: 18, step: 1, unit: " px" },
  { key: "conversationWidth", label: "prefs.conversationWidth", min: 800, max: maxConversationWidth, step: 20, unit: " px" },
] as const;
type ChatLayout = typeof defaultChatLayout;
/** The right-hand file preview. Sizes are absolute, like the tool summary size. */
export const defaultPreview = {
  previewCodeFontSize: 13,
  previewCodeLineHeight: 140,
  previewTextFontSize: 15,
  previewTextLineHeight: 140,
  previewWrap: true,
  previewLineNumbers: true,
  previewHighlight: true,
};
export const previewRanges = [
  { key: "previewCodeFontSize", label: "prefs.previewCodeFontSize", min: 10, max: 18, step: 1, unit: " px" },
  { key: "previewCodeLineHeight", label: "prefs.previewCodeLineHeight", min: 120, max: 200, step: 5, unit: "%" },
  { key: "previewTextFontSize", label: "prefs.previewTextFontSize", min: 12, max: 20, step: 1, unit: " px" },
  { key: "previewTextLineHeight", label: "prefs.previewTextLineHeight", min: 130, max: 200, step: 5, unit: "%" },
] as const;
export const previewToggles = [
  { key: "previewWrap", label: "prefs.previewWrap" },
  { key: "previewLineNumbers", label: "prefs.previewLineNumbers" },
  { key: "previewHighlight", label: "prefs.previewHighlight" },
] as const;
type PreviewSettings = typeof defaultPreview;
interface DesktopState extends ChatLayout, PreviewSettings {
  theme: "system" | "light" | "dark";
  fontSize: number;
  /** Percent of the usual height and vertical padding of interface rows (--ui-spacing). */
  rowSpacing: number;
  /** The message box grows with its text up to this many lines, then scrolls. */
  composerMaxLines: number;
  replyDetail: ReplyDetail;
  /** inline: `/model <alias>` / `/effort <level>`, saved as Claude's default for new
   * sessions. menu: the native picker, this session only. */
  settingSwitch: "inline" | "menu";
  /** Lectern-launched sessions turn on dynamic workflows so /effort offers Ultracode. */
  enableWorkflows: boolean;
  /** Prompt-cache lifetimes for the Claude processes Lectern starts; "default" sets nothing. */
  promptCacheTtlPreset: PromptCacheTtlPreset;
  /** Recording-only Claude Code hooks for question and permission dialogs in the processes Lectern
   * starts (backend/dialog-hooks.ts); off by default. */
  dialogHooks: boolean;
  historyPageMiB: number;
  showCacheTtl: boolean;
  showSubscriptionQuota: boolean;
  /** IANA zone for the 7d refill time ("Asia/Shanghai"); "" is this computer's zone. */
  quotaTimeZone: string;
  sidebarOpen: boolean;
  sidebarSort: SidebarSortMode;
  sidebarFolds: SidebarFolds;
  split: boolean;
  direction: SplitDirection;
  ratio: number;
  active: ChatView;
  panes: Record<ChatView, ChatTarget | null>;
  projectOrder: string[];
  connections: ConnectionProfile[];
  /** Conversations hidden from the sidebar; restorable from Settings → 回收站. */
  archivedSessions: ArchivedSession[];
}
export const defaultFontSize = 18;
export const composerLineRange = { min: 3, max: 30 } as const;
export const rowSpacingRange = { min: 80, max: 150, step: 5 } as const;
export const defaultAppearance = {
  theme: "system",
  fontSize: defaultFontSize,
  rowSpacing: 100,
  composerMaxLines: 10,
  replyDetail: "compact",
  showCacheTtl: true,
  showSubscriptionQuota: true,
  quotaTimeZone: "",
} as const;
export const defaultSessionOptions = { settingSwitch: "inline", enableWorkflows: true, promptCacheTtlPreset: "default", dialogHooks: false } as const;
const defaults: DesktopState = {
  ...defaultAppearance,
  ...defaultSessionOptions,
  ...defaultChatLayout,
  ...defaultPreview,
  historyPageMiB: DEFAULT_HISTORY_PAGE_MIB,
  sidebarOpen: true,
  sidebarSort: "projects",
  sidebarFolds: noFolds,
  split: false,
  direction: "columns",
  ratio: 0.5,
  active: "primary",
  panes: { primary: null, secondary: null },
  projectOrder: [],
  connections: [],
  archivedSessions: [],
};
const key = "lectern.desktop.preferences.v1";
const listeners = new Set<() => void>();
const bounded = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
/** A slider's value: bounded, then on one of its steps. */
const stepped = (value: unknown, { min, max, step }: { min: number; max: number; step: number }, fallback: number) =>
  min + Math.round((bounded(value, min, max, fallback) - min) / step) * step;

function target(value: unknown): ChatTarget | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<ChatTarget>;
  return typeof row.workspaceId === "string" &&
    typeof row.sessionId === "string" &&
    typeof row.title === "string"
    ? {
        workspaceId: row.workspaceId,
        sessionId: row.sessionId,
        title: row.title,
        ...(row.draft === true && row.sessionId === "" && { draft: true as const }),
      }
    : null;
}
export function validHost(host: string) {
  return (
    host.length <= 255 &&
    /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9_\[][A-Za-z0-9_.:\[\]-]*$/.test(
      host,
    )
  );
}
export function loadDesktopState(storage?: Pick<Storage, "getItem">): DesktopState {
  try {
    const store = storage ?? window.localStorage;
    const p = JSON.parse(store.getItem(key) ?? "null");
    const legacy = () => { try { return store.getItem(legacyExpandedKey); } catch { return null; } };
    if (!p || typeof p !== "object") return { ...defaults, sidebarFolds: sidebarFoldsOf(undefined, legacy()) };
    // Each setting is read independently: a missing or invalid one takes its default.
    const layout = { ...defaultChatLayout };
    for (const { key, min, max, step } of chatLayoutRanges) {
      const value = bounded(p[key], min, max, layout[key]);
      layout[key] = min + Math.round((value - min) / step) * step;
    }
    const preview = { ...defaultPreview };
    for (const { key, min, max, step } of previewRanges) {
      const value = bounded(p[key], min, max, preview[key]);
      preview[key] = min + Math.round((value - min) / step) * step;
    }
    for (const { key } of previewToggles) preview[key] = typeof p[key] === "boolean" ? p[key] : defaultPreview[key];
    return {
      ...layout,
      ...preview,
      theme: p.theme === "dark" || p.theme === "light" ? p.theme : "system",
      fontSize: bounded(p.fontSize, 14, 20, defaultFontSize),
      rowSpacing: stepped(p.rowSpacing, rowSpacingRange, defaultAppearance.rowSpacing),
      composerMaxLines: Math.round(bounded(p.composerMaxLines, composerLineRange.min, composerLineRange.max, defaultAppearance.composerMaxLines)),
      replyDetail: p.replyDetail === "individual" ? "individual" : defaultAppearance.replyDetail,
      settingSwitch: p.settingSwitch === "menu" ? "menu" : defaultSessionOptions.settingSwitch,
      enableWorkflows: p.enableWorkflows !== false,
      // Development builds of 0.2.2 stored two separate choices; a pair that is a preset carries over.
      promptCacheTtlPreset: "promptCacheTtlPreset" in p ? promptCacheTtlPreset(p.promptCacheTtlPreset)
        : promptCacheTtlPresetOf(p.promptCacheTtl, p.subagentPromptCacheTtl),
      dialogHooks: p.dialogHooks === true,
      historyPageMiB: historyPageSizeMiB(p.historyPageMiB),
      showCacheTtl: p.showCacheTtl !== false,
      showSubscriptionQuota: p.showSubscriptionQuota !== false,
      quotaTimeZone: typeof p.quotaTimeZone === "string" && validTimeZone(p.quotaTimeZone) ? p.quotaTimeZone : "",
      sidebarOpen: p.sidebarOpen !== false,
      sidebarSort: p.sidebarSort === "recent" || p.sidebarSort === "priority" ? p.sidebarSort : defaults.sidebarSort,
      sidebarFolds: sidebarFoldsOf(p.sidebarFolds, "sidebarFolds" in p ? null : legacy()),
      split: p.split === true,
      direction: p.direction === "rows" ? "rows" : "columns",
      ratio: bounded(p.ratio, 0.25, 0.75, 0.5),
      active: p.split && p.active === "secondary" ? "secondary" : "primary",
      panes: { primary: target(p.panes?.primary), secondary: target(p.panes?.secondary) },
      projectOrder: Array.isArray(p.projectOrder)
        ? p.projectOrder.filter((s: unknown) => typeof s === "string")
        : [],
      connections: Array.isArray(p.connections)
        ? p.connections.filter(
            (c: ConnectionProfile) =>
              c &&
              typeof c.id === "string" &&
              typeof c.name === "string" &&
              typeof c.host === "string" &&
              validHost(c.host) &&
              (c.port === undefined ||
                (Number.isInteger(c.port) && c.port > 0 && c.port <= 65535)),
          )
        : [],
      archivedSessions: Array.isArray(p.archivedSessions)
        ? p.archivedSessions.filter((a: ArchivedSession) => a && typeof a.workspaceId === "string" && typeof a.sessionId === "string"
            && typeof a.title === "string" && typeof a.archivedAt === "string").slice(-5000)
        : [],
    };
  } catch {
    return defaults;
  }
}
let state = loadDesktopState();
/** Whether the user left anything opened or closed in the sidebar before this launch: only an
 * untouched tree opens the restored chat's folder by itself. */
export const foldsKept = (folds: SidebarFolds) => folds.expandedFolders.length > 0 || folds.collapsedMachines.length > 0
  || folds.collapsedGroups.length > 0 || Object.keys(folds.folderListed).length > 0 || Object.keys(folds.groupListed).length > 0;
export const sidebarFoldsKept = foldsKept(state.sidebarFolds);
export const desktopState = () => state;
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const useDesktopState = () =>
  useSyncExternalStore(subscribe, desktopState);
export function setDesktop(patch: Partial<DesktopState>) {
  state = { ...state, ...patch };
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        ...state,
        panes: Object.fromEntries(
          Object.entries(state.panes).map(([view, chat]) => [
            view,
            chat && { ...chat, title: "" },
          ]),
        ),
      }),
    );
    // The folds above include what the legacy key held.
    localStorage.removeItem?.(legacyExpandedKey);
  } catch {
    /* Keep this window usable if storage is unavailable. */
  }
  listeners.forEach((fn) => fn());
}
export function setSidebarFolds(patch: Partial<SidebarFolds>) {
  setDesktop({ sidebarFolds: { ...state.sidebarFolds, ...patch } });
}
const toggled = <T extends string>(list: readonly T[], item: T, on: boolean) =>
  on ? [...list, item].slice(-foldLimit) : list.filter(entry => entry !== item);
export function collapseMachine(machineKey: string, collapsed: boolean) {
  if (state.sidebarFolds.collapsedMachines.includes(machineKey) !== collapsed)
    setSidebarFolds({ collapsedMachines: toggled(state.sidebarFolds.collapsedMachines, machineKey, collapsed) });
}
export function collapseGroup(group: SidebarGroup, collapsed: boolean) {
  if (state.sidebarFolds.collapsedGroups.includes(group) !== collapsed)
    setSidebarFolds({ collapsedGroups: toggled(state.sidebarFolds.collapsedGroups, group, collapsed) });
}
/** How many conversations a folder lists; none returns it to its first page. */
export function listFolder(workspaceId: string, count?: number) {
  const { [workspaceId]: _, ...others } = state.sidebarFolds.folderListed;
  setSidebarFolds({ folderListed: count ? { ...others, [workspaceId]: count } : others });
}
export function listGroup(group: SidebarGroup, count?: number) {
  const { [group]: _, ...others } = state.sidebarFolds.groupListed;
  setSidebarFolds({ groupListed: count ? { ...others, [group]: count } : others });
}
/** Drops the folds of folders and machines no longer in the sidebar; the same object when none are left over. */
export function prunedFolds(folds: SidebarFolds, workspaceIds: readonly string[], machineKeys: readonly string[]): SidebarFolds {
  const folders = new Set(workspaceIds), machines = new Set(machineKeys);
  const expandedFolders = folds.expandedFolders.filter(id => folders.has(id));
  const collapsedMachines = folds.collapsedMachines.filter(key => machines.has(key));
  const folderListed = Object.fromEntries(Object.entries(folds.folderListed).filter(([id]) => folders.has(id)));
  const same = expandedFolders.length === folds.expandedFolders.length && collapsedMachines.length === folds.collapsedMachines.length
    && Object.keys(folderListed).length === Object.keys(folds.folderListed).length;
  return same ? folds : { ...folds, expandedFolders, collapsedMachines, folderListed };
}
export function pruneSidebarFolds(workspaceIds: readonly string[], machineKeys: readonly string[]) {
  const folds = prunedFolds(state.sidebarFolds, workspaceIds, machineKeys);
  if (folds !== state.sidebarFolds) setDesktop({ sidebarFolds: folds });
}
export function sameChat(a: ChatTarget | null, b: ChatTarget | null) {
  return a?.workspaceId === b?.workspaceId && a?.sessionId === b?.sessionId;
}
/** The same conversation, and both or neither a new-chat draft. */
export function sameTarget(a: ChatTarget | null, b: ChatTarget | null) {
  return sameChat(a, b) && !!a?.draft === !!b?.draft;
}
export function showChat(view: ChatView, chat: ChatTarget | null) {
  if (
    sameTarget(state.panes[view], chat) &&
    state.panes[view]?.title === chat?.title
  )
    return;
  setDesktop({ panes: { ...state.panes, [view]: chat } });
}
export function focusChat(view: ChatView) {
  if (view !== state.active) setDesktop({ active: view });
}
export function splitChat(
  chat: ChatTarget | null,
  edge: SplitEdge,
  origin: ChatView = state.active,
) {
  markNavigated();
  const first = edge === "left" || edge === "top";
  const other = state.panes[origin];
  // A conversation shows in one pane at most: one already on screen gets the focus instead.
  const shown = chat && shownIn(state, chat);
  if (shown) { focusChat(shown); return; }
  setDesktop({
    split: true,
    direction: edge === "top" || edge === "bottom" ? "rows" : "columns",
    panes: first
      ? { primary: chat, secondary: other }
      : { primary: other, secondary: chat },
    active: first ? "primary" : "secondary",
  });
}
export function closeSplit(view: ChatView = "secondary") {
  setDesktop({
    split: false,
    active: "primary",
    panes: {
      primary: state.panes[view === "secondary" ? "primary" : "secondary"],
      secondary: null,
    },
  });
}
/** The pane already showing this conversation, if any (only the primary one when not split). */
export function shownIn(layout: Pick<DesktopState, "split" | "panes">, chat: ChatTarget): ChatView | undefined {
  if (sameChat(layout.panes.primary, chat)) return "primary";
  if (layout.split && sameChat(layout.panes.secondary, chat)) return "secondary";
  return undefined;
}
/**
 * What the pane without the focus shows while the screen is split (a conversation or
 * a new-chat draft); the sidebar marks it apart from the focused one. Null when not
 * split, when that pane is empty, or when it holds the focused pane's conversation.
 */
export function unfocusedChat(layout: Pick<DesktopState, "split" | "panes" | "active">): ChatTarget | null {
  if (!layout.split) return null;
  const other = layout.panes[layout.active === "primary" ? "secondary" : "primary"];
  return other && !sameChat(other, layout.panes[layout.active]) ? other : null;
}
/** What dropping a dragged conversation on an edge of the workspace does. */
export type ChatDropPlan =
  | { kind: "split" }
  | { kind: "replace"; view: ChatView }
  | { kind: "merge"; keep: ChatView }
  | { kind: "none" };
/**
 * One conversation: only another one can split the screen. Two: dropping one of
 * them on the other side merges back to that one alone; a third replaces the side
 * it is dropped on; dropping a conversation on its own side changes nothing.
 */
export function planChatDrop(layout: Pick<DesktopState, "split" | "panes" | "active">, chat: ChatTarget | null, edge: SplitEdge): ChatDropPlan {
  if (!layout.split) return chat && sameChat(chat, layout.panes[layout.active]) ? { kind: "none" } : { kind: "split" };
  const first = edge === "left" || edge === "top";
  const side: ChatView = first ? "primary" : "secondary", other: ChatView = first ? "secondary" : "primary";
  if (chat && sameChat(chat, layout.panes[side])) return { kind: "none" };
  if (chat && sameChat(chat, layout.panes[other])) return { kind: "merge", keep: other };
  return { kind: "replace", view: side };
}
export function dropChat(chat: ChatTarget, edge: SplitEdge) {
  const plan = planChatDrop(state, chat, edge);
  if (plan.kind === "split") splitChat(chat, edge);
  else if (plan.kind === "merge") { markNavigated(); closeSplit(plan.keep === "primary" ? "secondary" : "primary"); }
  else if (plan.kind === "replace") { markNavigated(); showChat(plan.view, chat); focusChat(plan.view); }
}
// The data of a drag is unreadable until the drop; the workspace needs to know
// which conversation is coming to label its drop zones.
let draggedChat: ChatTarget | null = null;
export function beginChatDrag(data: DataTransfer, chat: ChatTarget) {
  data.setData(chatDragType, JSON.stringify(chat));
  data.effectAllowed = "copy";
  draggedChat = chat;
}
export function endChatDrag() { draggedChat = null; }
export const currentChatDrag = () => draggedChat;
export const chatDragType = "application/x-lectern-chat";
export const workspaceDragType = "application/x-lectern-workspace";
export function readDraggedChat(data: DataTransfer) {
  try {
    return target(JSON.parse(data.getData(chatDragType)));
  } catch {
    return null;
  }
}
export function orderProjects<T extends { id: string }>(
  projects: T[],
  order: string[],
) {
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...projects].sort(
    (a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity),
  );
}
export function moveProject(
  ids: string[],
  from: string,
  to: string,
) {
  if (from === to || !ids.includes(from) || !ids.includes(to)) return;
  const next = ids.filter((id) => id !== from);
  next.splice(ids.indexOf(to), 0, from);
  setDesktop({ projectOrder: next });
}
export const archiveKey = (workspaceId: string, sessionId: string) => `${workspaceId}\n${sessionId}`;
export function archiveSession(entry: Omit<ArchivedSession, "archivedAt">) {
  const others = state.archivedSessions.filter(a => archiveKey(a.workspaceId, a.sessionId) !== archiveKey(entry.workspaceId, entry.sessionId));
  setDesktop({ archivedSessions: [...others, { ...entry, archivedAt: new Date().toISOString() }] });
}
export function restoreSessions(keys: string[]) {
  const restore = new Set(keys);
  setDesktop({ archivedSessions: state.archivedSessions.filter(a => !restore.has(archiveKey(a.workspaceId, a.sessionId))) });
}
export function forgetProject(id: string) {
  const { [id]: _, ...folderListed } = state.sidebarFolds.folderListed;
  setDesktop({
    archivedSessions: state.archivedSessions.filter(a => a.workspaceId !== id),
    sidebarFolds: { ...state.sidebarFolds, expandedFolders: state.sidebarFolds.expandedFolders.filter(w => w !== id), folderListed },
    projectOrder: state.projectOrder.filter((w) => w !== id),
    panes: {
      primary:
        state.panes.primary?.workspaceId === id ? null : state.panes.primary,
      secondary:
        state.panes.secondary?.workspaceId === id
          ? null
          : state.panes.secondary,
    },
  });
}
