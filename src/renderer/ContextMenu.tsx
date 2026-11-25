import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { t } from '../shared/i18n';
import { createPortal } from "react-dom";
import { reportActionError } from "./diagnostics";

/** One right-click menu for the whole window. Components describe items; the
 * host renders them inside the top-most modal dialog (outside it is inert). */
export interface MenuAction {
  label: string;
  icon?: ReactNode;
  onSelect(): unknown;
  disabled?: boolean;
  danger?: boolean;
  /** Shown dimmed after the label, e.g. a shortcut or the reason it is disabled. */
  hint?: string;
}
export type MenuEntry = MenuAction | "separator";
type Pending = { x: number; y: number; label: string; items: MenuEntry[] };
interface Confirmation { title: string; message: string; confirmLabel: string; danger?: boolean; resolve(ok: boolean): void;
  /** A second paragraph, e.g. what the action stops. */
  detail?: string;
  /** When set, the dialog asks for text and resolves through answer instead. */
  input?: { label: string; value: string; maxLength?: number; answer(value: string | undefined): void } }

let menu: Pending | undefined, confirmation: Confirmation | undefined, toast: { id: number; text: string } | undefined;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Drop falsy entries and doubled or dangling separators. */
export function normalizeMenu(entries: (MenuEntry | false | null | undefined)[]): MenuEntry[] {
  const result: MenuEntry[] = [];
  for (const entry of entries) {
    if (!entry || (entry === "separator" && (!result.length || result.at(-1) === "separator"))) continue;
    result.push(entry);
  }
  while (result.at(-1) === "separator") result.pop();
  return result;
}

type PointerLike = { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void; currentTarget: EventTarget | null };
export function showContextMenu(event: PointerLike, entries: (MenuEntry | false | null | undefined)[], label = t('misc.actions'),
  updated?: Promise<MenuEntry[]>) {
  const items = normalizeMenu(entries);
  if (!items.length) return;
  event.preventDefault();
  event.stopPropagation();
  let { clientX: x, clientY: y } = event;
  // Keyboard (Menu key / Shift+F10) reports no pointer position.
  if (!x && !y && event.currentTarget instanceof Element) {
    const rect = event.currentTarget.getBoundingClientRect();
    x = rect.left + Math.min(24, rect.width / 2); y = rect.bottom - 2;
  }
  const shown = menu = { x, y, label, items };
  emit();
  void updated?.then(next => {
    if (menu !== shown) return;
    menu = { ...shown, items: normalizeMenu(next) };
    emit();
  }, () => {});
}

/** Resolves true only on an explicit click of the confirm button. */
export function confirmAction(options: Omit<Confirmation, "resolve">): Promise<boolean> {
  confirmation?.resolve(false);
  return new Promise(resolve => { confirmation = { ...options, resolve }; emit(); });
}

/** Ask for one line of text (e.g. a new name); undefined when cancelled or unchanged-empty. */
export function promptText(options: { title: string; label: string; value: string; confirmLabel?: string; maxLength?: number }): Promise<string | undefined> {
  confirmation?.resolve(false);
  return new Promise(resolve => {
    let answered = false;
    const answer = (value: string | undefined) => { if (!answered) { answered = true; resolve(value); } };
    confirmation = { title: options.title, message: "", confirmLabel: options.confirmLabel ?? t('misc.save'), resolve: ok => { if (!ok) answer(undefined); },
      input: { label: options.label, value: options.value, maxLength: options.maxLength, answer } };
    emit();
  });
}

/** A short message near the bottom of the window, e.g. "已复制". */
export function showToast(text: string) {
  const id = (toast?.id ?? 0) + 1;
  toast = { id, text };
  emit();
  setTimeout(() => { if (toast?.id === id) { toast = undefined; emit(); } }, 2600);
}

/** Copy text through the main process clipboard and confirm with a toast. */
export async function copyWithToast(text: string, done = t('misc.copied')) {
  await window.desktop.copyText(text);
  showToast(done);
}

async function run(action: MenuAction) {
  try { await action.onSelect(); }
  catch (error) {
    reportActionError(error, action.label);
    showToast(t('misc.actionFailed', { action: action.label, error: error instanceof Error ? error.message : String(error) }));
  }
}

const topLayer = () => [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].filter(d => d.matches(":modal")).at(-1) ?? document.body;

function Menu({ pending, onClose }: { pending: Pending; onClose(): void }) {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = element.current!;
    el.showPopover();
    el.style.left = `${Math.max(4, Math.min(pending.x, innerWidth - el.offsetWidth - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(pending.y, innerHeight - el.offsetHeight - 4))}px`;
    if (!el.contains(document.activeElement)) el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [pending]);
  const move = (direction: number | "first" | "last") => {
    const items = [...element.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = direction === "first" ? 0 : direction === "last" ? items.length - 1 : (index + direction + items.length) % items.length;
    items[next].focus();
  };
  return <div ref={element} popover="auto" role="menu" aria-label={pending.label} className="context-menu"
    onToggle={event => { if (event.newState === "closed") onClose(); }}
    onContextMenu={event => event.preventDefault()}
    onKeyDown={event => {
      const keys: Record<string, number | "first" | "last"> = { ArrowDown: 1, ArrowUp: -1, Home: "first", End: "last" };
      if (!(event.key in keys)) return;
      event.preventDefault();
      move(keys[event.key]);
    }}>
    {pending.items.map((item, index) => item === "separator"
      ? <div key={`s${index}`} role="separator" className="context-menu-separator" />
      : <button key={`${index}:${item.label}`} type="button" role="menuitem" disabled={item.disabled}
        data-danger={item.danger || undefined} onClick={() => { element.current?.hidePopover(); void run(item); }}>
        <span className="context-menu-icon" aria-hidden="true">{item.icon}</span>
        <span className="context-menu-label">{item.label}</span>
        {item.hint && <span className="context-menu-hint">{item.hint}</span>}
      </button>)}
  </div>;
}

function ConfirmDialog({ request }: { request: Confirmation }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState(request.input?.value ?? "");
  useLayoutEffect(() => { dialog.current?.showModal(); }, []);
  const settle = (ok: boolean) => {
    if (confirmation !== request) return;
    confirmation = undefined;
    if (ok && request.input) request.input.answer(value.trim() || undefined);
    request.resolve(ok);
    emit();
  };
  return <dialog ref={dialog} className="modal confirm-action" aria-labelledby="confirm-action-title"
    onCancel={event => { event.preventDefault(); settle(false); }}>
    <form method="dialog" onSubmit={event => { event.preventDefault(); settle(true); }}>
      <h2 id="confirm-action-title">{request.title}</h2>
      {request.message && <p className="modal-description">{request.message}</p>}
      {request.detail && <p className="modal-description confirm-action-detail">{request.detail}</p>}
      {request.input && <label className="field-label">{request.input.label}
        <input autoFocus value={value} maxLength={request.input.maxLength ?? 200} spellCheck={false}
          onFocus={event => event.currentTarget.select()} onChange={event => setValue(event.target.value)} /></label>}
      <div className="modal-footer">
        <div className="spacer" />
        <button type="button" className="secondary-button" autoFocus={!request.input} onClick={() => settle(false)}>{t('misc.cancel')}</button>
        <button type="submit" className={request.danger ? "danger-button" : "primary-button"} disabled={!!request.input && !value.trim()}>{request.confirmLabel}</button>
      </div>
    </form>
  </dialog>;
}

/** Mount once in the app root. */
export function ContextMenuHost() {
  const state = useSyncExternalStore(subscribe, () => menu, () => undefined);
  const pendingConfirmation = useSyncExternalStore(subscribe, () => confirmation, () => undefined);
  const message = useSyncExternalStore(subscribe, () => toast, () => undefined);
  const [, rerender] = useState(0);
  return <>
    {state && createPortal(<Menu pending={state} onClose={() => { if (menu === state) { menu = undefined; emit(); rerender(n => n + 1); } }} />, topLayer())}
    {pendingConfirmation && createPortal(<ConfirmDialog key={pendingConfirmation.title + pendingConfirmation.message + (pendingConfirmation.detail ?? '')} request={pendingConfirmation} />, document.body)}
    {message && createPortal(<div className="context-toast" role="status" key={message.id}>{message.text}</div>, topLayer())}
  </>;
}
