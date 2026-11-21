import { useRef, useState, type ClipboardEvent, type DragEvent, type RefObject } from 'react';
import { joinList, t } from '../shared/i18n';
import type { Workspace } from '../shared/types';
import { appendMentions, insertMentions, maxAttachmentBytes, pasteAttaches } from '../shared/attachments';

interface Options {
  workspace?: Workspace; sessionId: string; enabled: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  setDraft(update: (value: string) => string): void;
  /** Whether this chat (folder and session, "" for a new chat) is still on screen. */
  showing(workspaceId: string, sessionId: string): boolean;
  /** Mentions for a chat no longer on screen go into its saved input text. */
  stash(workspaceId: string, sessionId: string, update: (value: string) => string): void;
  onError(message: string): void;
}
interface Upload { id: number; workspaceId: string; sessionId: string; names: string[] }
interface Picked { file: File; directory?: boolean }

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
  .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
function picked(data: DataTransfer): Picked[] {
  const result: Picked[] = [];
  for (const item of data.items) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) result.push({ file, directory: !!item.webkitGetAsEntry?.()?.isDirectory });
  }
  return result;
}
const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files');

/**
 * Files pasted into or dropped onto a chat become @-mentions. Claude Code on
 * this computer gets the file's own path; on an SSH machine the
 * file is first copied into that machine's temporary directory.
 */
export function useComposerAttachments(options: Options) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const latest = useRef(options);
  latest.current = options;
  const next = useRef(0);
  const chooser = useRef<HTMLInputElement>(null);
  const pending = uploads.filter(u => u.workspaceId === options.workspace?.id && u.sessionId === options.sessionId).flatMap(u => u.names);

  async function attach(items: Picked[]) {
    const { workspace, sessionId } = latest.current;
    if (!workspace || !items.length) return;
    const direct = workspace.kind === 'local';
    const id = ++next.current;
    setUploads(list => [...list, { id, workspaceId: workspace.id, sessionId, names: items.map(i => i.file.name || t('composer.clipboardImage')) }]);
    const mentions: string[] = [], failed: string[] = [];
    try {
      for (const { file, directory } of items) {
        const name = file.name || 'image.png';
        const local = window.desktop.pathForFile(file);
        if (direct && local) { mentions.push(local); continue; }
        if (directory) { failed.push(t('composer.folderNotUploadable', { name })); continue; }
        if (file.size > maxAttachmentBytes) { failed.push(t('composer.tooLarge', { name })); continue; }
        try { mentions.push(await window.desktop.uploadAttachment(workspace.id, name, new Uint8Array(await file.arrayBuffer()))); }
        catch (error) { failed.push(t('composer.failedWith', { name, error: message(error) })); }
      }
    } finally {
      setUploads(list => list.filter(u => u.id !== id));
    }
    const now = latest.current;
    if (mentions.length && now.showing(workspace.id, sessionId)) {
      const input = now.inputRef.current;
      let caret: number | undefined;
      now.setDraft(value => {
        const [start, end] = input && input.value === value ? [input.selectionStart, input.selectionEnd] : [value.length, value.length];
        const result = insertMentions(value, start, end, mentions);
        caret = result.caret;
        return result.text;
      });
      requestAnimationFrame(() => {
        if (!input?.isConnected || caret === undefined || input.disabled) return;
        input.focus({ preventScroll: true });
        input.setSelectionRange(caret, caret);
      });
    } else if (mentions.length) now.stash(workspace.id, sessionId, value => appendMentions(value, mentions));
    if (failed.length) now.onError(t('composer.addFailed', { names: joinList(failed) }));
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (!latest.current.enabled) return;
    const items = picked(event.clipboardData);
    if (!pasteAttaches(items.length, items.map(i => window.desktop.pathForFile(i.file)), event.clipboardData.getData('text/plain'))) return;
    event.preventDefault();
    void attach(items);
  }

  const dropTarget = {
    onDragEnter(event: DragEvent<HTMLElement>) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      setDragging(true);
    },
    onDragOver(event: DragEvent<HTMLElement>) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = latest.current.enabled ? 'copy' : 'none';
    },
    onDragLeave(event: DragEvent<HTMLElement>) {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      setDragging(false);
    },
    onDrop(event: DragEvent<HTMLElement>) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      setDragging(false);
      if (latest.current.enabled) void attach(picked(event.dataTransfer));
    },
  };

  /** The "+" button: files chosen in the system dialog are added like dropped ones. */
  function choose() {
    if (latest.current.enabled) chooser.current?.click();
  }
  const fileInput = <input ref={chooser} type="file" multiple hidden className="composer-file-input" tabIndex={-1} aria-hidden="true"
    onChange={event => {
      const files = [...event.currentTarget.files ?? []];
      // Choosing the same file again must fire another change.
      event.currentTarget.value = "";
      if (files.length && latest.current.enabled) void attach(files.map(file => ({ file })));
    }} />;

  return { pending, dragging: dragging && options.enabled, onPaste, dropTarget, choose, fileInput };
}
