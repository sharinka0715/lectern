import { ChevronsDownUp, Copy, CornerDownLeft, Download, FileText, Link, Quote, TextSelect } from "lucide-react";
import type { ChatMessage, ToolBlock } from "../shared/types";
import { copyWithToast, type MenuEntry } from "./ContextMenu";
import { t } from '../shared/i18n';

type OpenPath = (path: string) => void;
const icon = (Icon: typeof Copy) => <Icon size={14} />;

/** Selected text inside this element only; a selection elsewhere is ignored. */
export function selectionWithin(element: Element): string {
  const selection = globalThis.getSelection?.();
  if (!selection || selection.isCollapsed || !selection.anchorNode || !element.contains(selection.anchorNode)) return "";
  return selection.toString();
}

/** What sits under the pointer: a verified file reference, a link or a code block. */
export function pointedContent(target: EventTarget | null) {
  const element = typeof Element !== "undefined" && target instanceof Element ? target : null;
  const file = element?.closest("[data-file-path]")?.getAttribute("data-file-path") ?? undefined;
  const href = element?.closest("a[href]")?.getAttribute("href") ?? undefined;
  const code = element?.closest(".code-block")?.querySelector("pre")?.textContent ?? element?.closest("pre")?.textContent ?? undefined;
  return { file, href: href && /^(?:https?|mailto):/i.test(href) ? href : undefined, code };
}

export function fileEntries(file: string | undefined, onOpenPath: OpenPath, workspaceId?: string): MenuEntry[] {
  if (!file) return [];
  return [
    { label: t('composer.previewFile'), icon: icon(FileText), onSelect: () => onOpenPath(file) },
    { label: t('composer.copyFilePath'), icon: icon(Copy), onSelect: () => copyWithToast(file) },
    workspaceId ? { label: t('composer.downloadFile'), icon: icon(Download), onSelect: () => window.desktop.downloadArtifact(workspaceId, file) } : "separator",
    "separator",
  ];
}

export function messageMenu(event: { currentTarget: Element; target: EventTarget | null }, message: ChatMessage, options: {
  workspaceId?: string; onOpenPath: OpenPath; onRewind?: (uuid: string) => void; onQuote?: (text: string) => void;
}): MenuEntry[] {
  const selected = selectionWithin(event.currentTarget).trim();
  const { file, href, code } = pointedContent(event.target);
  const user = message.role === "user";
  const plain = (event.currentTarget.querySelector(".message-content") as HTMLElement | null)?.innerText.trim() ?? message.text;
  return [
    !!selected && { label: t('composer.copySelection'), icon: icon(TextSelect), onSelect: () => copyWithToast(selected) },
    ...fileEntries(file, options.onOpenPath, options.workspaceId),
    !!href && { label: t('composer.copyLink'), icon: icon(Link), onSelect: () => copyWithToast(href) },
    !!code && { label: t('composer.copyCodeBlock'), icon: icon(Copy), onSelect: () => copyWithToast(code.replace(/\n$/, "")) },
    "separator",
    !!message.text && { label: t(user ? 'composer.copyMessage' : 'composer.copyMarkdown'), icon: icon(Copy), onSelect: () => copyWithToast(message.text) },
    !user && !!plain && { label: t('composer.copyPlain'), icon: icon(FileText), onSelect: () => copyWithToast(plain) },
    !!options.onQuote && !!(selected || message.text) && { label: t('composer.quote'), icon: icon(Quote), onSelect: () => options.onQuote!(selected || message.text) },
    "separator",
    user && !!options.onRewind && !!message.rewindUuid && { label: t('composer.rewindHere'), icon: icon(CornerDownLeft), onSelect: () => options.onRewind!(message.rewindUuid!) },
  ].filter(Boolean) as MenuEntry[];
}

/** Bash shows its command; other tools their input as recorded. */
export function toolCommand(tool: ToolBlock): string | undefined {
  try {
    const input = JSON.parse(tool.input);
    return typeof input?.command === "string" ? input.command : undefined;
  } catch { return undefined; }
}

export function toolMenu(event: { currentTarget: Element; target: EventTarget | null }, tool: ToolBlock, options: {
  file?: string; open: boolean; toggle(): void; onOpenPath: OpenPath; workspaceId?: string;
}): MenuEntry[] {
  const selected = selectionWithin(event.currentTarget).trim();
  const command = toolCommand(tool);
  return [
    !!selected && { label: t('composer.copySelection'), icon: icon(TextSelect), onSelect: () => copyWithToast(selected) },
    ...fileEntries(pointedContent(event.target).file ?? options.file, options.onOpenPath, options.workspaceId),
    { label: t(options.open ? 'composer.collapseDetails' : 'composer.expandDetails'), icon: icon(ChevronsDownUp), onSelect: options.toggle },
    "separator",
    command !== undefined && { label: t('composer.copyCommand'), icon: icon(Copy), onSelect: () => copyWithToast(command) },
    { label: t(command !== undefined ? 'composer.copyFullInput' : 'composer.copyInput'), icon: icon(Copy), onSelect: () => copyWithToast(tool.input) },
    tool.result !== undefined && { label: t('composer.copyOutput'), icon: icon(Copy), onSelect: () => copyWithToast(tool.result!) },
  ].filter(Boolean) as MenuEntry[];
}
