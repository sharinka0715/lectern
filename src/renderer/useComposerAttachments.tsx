import { useRef, useState, type ClipboardEvent, type DragEvent, type RefObject } from 'react';
import { joinList, t } from '../shared/i18n';
import type { Workspace } from '../shared/types';
import { addDraftFiles, joinDraft, maxAttachmentBytes, pasteAttaches, splitDraft } from '../shared/attachments';
import { ComposerAttachments, type UploadCard } from './AttachmentCards';
import { isAttachedPath, localThumbnail, rememberAttachment } from './attachment-registry';
import { pathBasename } from './artifact-paths';

interface Options {
  workspace?: Workspace; sessionId: string; enabled: boolean;
  /** The whole draft, attachments included as @-mentions after the text (what is sent). */
  draft: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  setDraft(update: (value: string) => string): void;
  /** Whether this chat (folder and session, "" for a new chat) is still on screen. */
  showing(workspaceId: string, sessionId: string): boolean;
  /** Mentions for a chat no longer on screen go into its saved input text. */
  stash(workspaceId: string, sessionId: string, update: (value: string) => string): void;
  onError(message: string): void;
}
interface Upload { id: number; workspaceId: string; sessionId: string; files: UploadCard[] }
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
 * The input box shows them as cards above the text (`strip`) and the text alone
 * (`text`); the draft keeps them as mentions after the text, so sending,
 * restoring and stashing a draft need nothing else.
 */
export function useComposerAttachments(options: Options) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const latest = useRef(options);
  latest.current = options;
  const next = useRef(0);
  const chooser = useRef<HTMLInputElement>(null);
  const shown = uploads.filter(u => u.workspaceId === options.workspace?.id && u.sessionId === options.sessionId).flatMap(u => u.files);
  const pending = shown.map(file => file.name);
  const parts = splitDraft(options.draft, isAttachedPath);

  async function attach(items: Picked[]) {
    const { workspace, sessionId } = latest.current;
    if (!workspace || !items.length) return;
    const id = ++next.current;
    const entries = items.map(({ file, directory }) => ({ file, directory, name: file.name || 'image.png',
      local: workspace.kind === 'local' ? window.desktop.pathForFile(file) : '' }));
    // Files from disk on this computer are referenced where they are; the rest are uploaded, shown as cards meanwhile.
    const waiting = entries.filter(entry => !entry.local);
    const card = (index: number) => `${id}:${index}`;
    if (waiting.length) setUploads(list => [...list, { id, workspaceId: workspace.id, sessionId,
      files: waiting.map(entry => ({ key: card(entries.indexOf(entry)), name: entry.name })) }]);
    const thumbnails = await Promise.all(entries.map(entry => entry.directory ? undefined : localThumbnail(entry.file)));
    if (waiting.length) setUploads(list => list.map(u => u.id !== id ? u
      : { ...u, files: u.files.map(file => ({ ...file, thumbnail: thumbnails[entries.findIndex((_, i) => card(i) === file.key)] })) }));
    const paths: string[] = [], failed: string[] = [], kept = new Set<number>();
    try {
      for (const [index, { file, directory, name, local }] of entries.entries()) {
        let path = local || undefined;
        if (!path && directory) failed.push(t('composer.folderNotUploadable', { name }));
        else if (!path && file.size > maxAttachmentBytes) failed.push(t('composer.tooLarge', { name }));
        else if (!path) {
          try { path = await window.desktop.uploadAttachment(workspace.id, name, new Uint8Array(await file.arrayBuffer())); }
          catch (error) { failed.push(t('composer.failedWith', { name, error: message(error) })); }
        }
        if (!path) continue;
        // A folder's card name ends with a slash (and gets the folder icon).
        rememberAttachment(path, { name: pathBasename(path) + (directory ? '/' : ''), thumbnail: thumbnails[index] });
        kept.add(index);
        paths.push(path);
      }
    } finally {
      setUploads(list => list.filter(u => u.id !== id));
      thumbnails.forEach((url, index) => { if (url && !kept.has(index)) URL.revokeObjectURL(url); });
    }
    const now = latest.current;
    if (paths.length && now.showing(workspace.id, sessionId)) {
      now.setDraft(value => addDraftFiles(value, paths, isAttachedPath));
      requestAnimationFrame(() => {
        const input = now.inputRef.current;
        if (input?.isConnected && !input.disabled && document.activeElement !== input) input.focus({ preventScroll: true });
      });
    } else if (paths.length) now.stash(workspace.id, sessionId, value => addDraftFiles(value, paths, isAttachedPath));
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

  /** Text typed in the input box; the attached files stay after it. */
  function setText(text: string) {
    latest.current.setDraft(value => joinDraft(text, splitDraft(value, isAttachedPath).files));
  }
  function remove(path: string) {
    const now = latest.current;
    now.setDraft(value => {
      const draft = splitDraft(value, isAttachedPath);
      return joinDraft(draft.text, draft.files.filter(file => file !== path));
    });
    now.inputRef.current?.focus({ preventScroll: true });
  }
  const strip = <ComposerAttachments files={parts.files} uploads={shown} onRemove={remove} />;

  return { pending, text: parts.text, setText, strip, dragging: dragging && options.enabled, onPaste, dropTarget, choose, fileInput };
}
