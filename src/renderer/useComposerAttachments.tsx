import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type RefObject, type SyntheticEvent } from 'react';
import { joinList, t } from '../shared/i18n';
import type { Workspace } from '../shared/types';
import { attachmentKind, findMentions, maxAttachmentBytes, mentionFor, pasteAttaches } from '../shared/attachments';
import { ComposerAttachments, ComposerChipLayer, type ComposerItem } from './AttachmentCards';
import { attachmentEntry, chipEntry, chipFor, chipMention, isAttachedPath, knownChip, localThumbnail, rememberAttachment, settleChip, updateChip, uploadingChip } from './attachment-registry';
import { pathBasename } from './artifact-paths';
import { chipInsertion, chipOrder, chipToken, chipTokens, displayFromDraft, draftFromDisplay, reconcileChips, removeChips, snapSelection, type ChipSource, type ChipToken } from './composer-chips';
import { ImagePreviewDialog } from './ChatImage';

interface Options {
  workspace?: Workspace; sessionId: string; enabled: boolean;
  /** The whole draft with attachments as @-mentions where they sit in the text (what is sent). */
  draft: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  setDraft(update: (value: string) => string): void;
  /** Whether this chat (folder and session, "" for a new chat) is still on screen. */
  showing(workspaceId: string, sessionId: string): boolean;
  /** Mentions for a chat no longer on screen go into its saved input text. */
  stash(workspaceId: string, sessionId: string, update: (value: string) => string): void;
  onError(message: string): void;
  /** Opens a file in the preview panel (an image whose original cannot be shown). */
  openFile(path: string): void;
}
interface Upload { id: number; workspaceId: string; sessionId: string; files: { chip: number; name: string }[] }
interface Picked { file: File; directory?: boolean }
interface Viewing { workspaceId: string; path: string; name: string; thumbnail?: string; serial: number }

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
const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const isImage = (name: string, thumbnail?: string) => !!thumbnail || attachmentKind(name) === 'image';
/** The label a chip is sized for: the widest image number it will likely show, or the file's name. */
const sizingLabel = (name: string) => isImage(name) ? t('composer.imageLabel', { n: 10 }) : name;

// A chip's width in figure spaces: its label in the chip's smaller font, an icon, a gap and padding.
const chipFont = .86, chipExtra = .99 + .26 + .6;
const widths = new Map<string, number>();
let measure: CanvasRenderingContext2D | null | undefined;
function chipWidth(label: string, input: HTMLTextAreaElement | null) {
  const style = input?.isConnected ? getComputedStyle(input) : undefined;
  const size = parseFloat(style?.fontSize ?? '') || 15;
  const font = (scale: number) => style ? `${style.fontStyle} ${style.fontWeight} ${size * scale}px ${style.fontFamily}` : '';
  const key = font(1) + '\n' + label;
  const known = widths.get(key);
  if (known !== undefined) return known;
  let figure = size * .55, text = [...label].reduce((sum, c) => sum + (/[⺀-￿]/u.test(c) ? 1 : .58), 0) * size * chipFont;
  measure ??= document.createElement('canvas').getContext('2d');
  if (measure && style) {
    measure.font = font(1);
    figure = measure.measureText(' ').width || figure;
    measure.font = font(chipFont);
    text = measure.measureText(label).width;
  }
  const width = Math.max(3, Math.min(26, Math.ceil((text + size * chipExtra + 4) / figure)));
  widths.set(key, width);
  return width;
}

/** Runs both handlers of each event, `first`'s before `second`'s. */
function chained<A extends object, B extends object>(first: A, second: B): A & B {
  const merged = { ...first, ...second } as Record<string, unknown>;
  for (const [key, handler] of Object.entries(second)) {
    const before = (first as Record<string, unknown>)[key];
    if (typeof before === 'function' && typeof handler === 'function') merged[key] = (...args: unknown[]) => { before(...args); handler(...args); };
  }
  return merged as A & B;
}

/**
 * Files pasted into or dropped onto a chat become @-mentions. Claude Code on
 * this computer gets the file's own path; on an SSH machine the file is first
 * copied into that machine's temporary directory. Each mention sits in the text
 * where it was added, shown as a chip ("图片1", a file name) the caret steps over
 * and copy, cut, paste and undo move whole (composer-chips.ts); the cards above
 * the text (`strip`) list the files in the order the text names them, images
 * numbered like their chips, and open the image larger. The draft keeps the
 * mentions, so sending, restoring and stashing it need nothing else.
 */
export function useComposerAttachments(options: Options) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [selection, setSelection] = useState<readonly [number, number]>([0, 0]);
  const [viewing, setViewing] = useState<Viewing>();
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const latest = useRef(options);
  latest.current = options;
  const next = useRef(0);
  const chooser = useRef<HTMLInputElement>(null);
  const chat = `${options.workspace?.id ?? ''}\n${options.sessionId}`;
  // The textarea's text (chips as tokens) for the current draft. Kept while the draft is
  // the one it gives, so the text stays as typed; any other draft (another chat, a
  // message put back) is shown afresh.
  const view = useRef({ draft: '', text: '' });
  const caretAfter = useRef<number | undefined>(undefined);
  const lastSelection = useRef<readonly [number, number]>([0, 0]);
  const composing = useRef(false), pointer = useRef(false);
  /** The chat whose text the user has put the caret in: added files go there rather than at the end. */
  const placed = useRef('');
  /** Chips of files still uploading that the user deleted: the file is not added when it arrives. */
  const dropped = useRef(new Set<number>());

  const source: ChipSource = {
    attached: isAttachedPath,
    idFor: chipFor,
    widthFor: path => chipWidth(sizingLabel(attachmentEntry(path)?.name ?? pathBasename(path)), latest.current.inputRef.current),
  };
  if (view.current.draft !== options.draft) view.current = { draft: options.draft, text: displayFromDraft(options.draft, source) };
  const text = view.current.text;
  const tokens = chipTokens(text, knownChip);

  const info = (id: number): ComposerItem | undefined => {
    const chip = chipEntry(id);
    if (!chip || chip.state === 'failed') return;
    const entry = chip.path ? attachmentEntry(chip.path) : undefined;
    const name = entry?.name ?? chip.name, thumbnail = entry?.thumbnail ?? chip.thumbnail;
    return { key: chip.path ?? `upload:${id}`, ids: [], name, path: chip.path, image: isImage(name, thumbnail), thumbnail, uploading: chip.state === 'uploading' };
  };
  const ordered = chipOrder(tokens, info);
  const byChip = new Map<number, ComposerItem>();
  for (const item of ordered) for (const id of item.ids) byChip.set(id, item);
  const shown = uploads.filter(u => u.workspaceId === options.workspace?.id && u.sessionId === options.sessionId).flatMap(u => u.files);
  const items: ComposerItem[] = [...ordered, ...shown.filter(file => !byChip.has(file.chip)).flatMap(file => {
    const item = info(file.chip);
    return item ? [{ ...item, ids: [file.chip] }] : [];
  })];

  /** The text and draft after a change made here rather than typed; `caret` goes in place once it is shown. */
  function commit(next: string, caret?: number) {
    const draft = draftFromDisplay(next, chipMention, knownChip);
    view.current = { draft, text: next };
    caretAfter.current = caret;
    latest.current.setDraft(() => draft);
    refresh();
  }
  useLayoutEffect(() => {
    const caret = caretAfter.current, input = options.inputRef.current;
    if (caret === undefined || !input || input.value !== view.current.text) return;
    caretAfter.current = undefined;
    if (document.activeElement !== input) return;
    input.setSelectionRange(caret, caret);
    lastSelection.current = [caret, caret];
  });
  // A new chat starts with the caret nowhere in particular.
  useEffect(() => { placed.current = ''; lastSelection.current = [0, 0]; setSelection([0, 0]); }, [chat]);

  /** Text typed, deleted, dropped, undone… in the textarea. Chips stay whole (see reconcileChips). */
  function setText(value: string, inputType?: string) {
    const before = view.current.text;
    const result = reconcileChips(before, value, knownChip);
    let next = result.text, caret: number | undefined;
    // A chip dragged within the box arrives as its @-mention (what the drag carries): a chip again.
    if (inputType === 'insertFromDrop' && result.end > result.start) {
      const middle = next.slice(result.start, result.end), chips = displayFromDraft(middle, source);
      if (chips !== middle) { next = next.slice(0, result.start) + chips + next.slice(result.end); caret = result.start + chips.length; }
    }
    const input = latest.current.inputRef.current;
    if (next !== value && caret === undefined && input) caret = result.position(input.selectionEnd);
    const kept = new Set(chipTokens(next, knownChip).map(token => token.id));
    for (const token of chipTokens(before, knownChip)) if (!kept.has(token.id) && chipEntry(token.id)?.state === 'uploading') dropped.current.add(token.id);
    commit(next, next !== value ? caret : undefined);
  }

  /** Puts chips where the caret is (replacing the selection for a paste), or after the text when the user never placed it. */
  function insert(ids: number[], names: string[], replace: boolean) {
    const input = latest.current.inputRef.current, current = view.current.text;
    const added = ids.map((id, i) => chipToken(id, chipWidth(sizingLabel(names[i]), input)));
    if (!input || input.disabled || input.value !== current) {
      commit(current + chipInsertion(current, current.length, added));
      return;
    }
    let start = input.selectionStart, end = input.selectionEnd;
    if (document.activeElement !== input && placed.current !== chat) start = end = current.length;
    if (!replace) start = end;
    [start, end] = snapSelection(chipTokens(current, knownChip), start, end, undefined, true);
    const rest = current.slice(0, start) + current.slice(end);
    const insertion = chipInsertion(rest, start, added);
    input.focus({ preventScroll: true });
    input.setSelectionRange(start, end);
    // As typing: one undo step takes the chips out again.
    if (!document.execCommand('insertText', false, insertion)) commit(rest.slice(0, start) + insertion + rest.slice(start), start + insertion.length);
  }

  async function attach(items: Picked[], replace = false) {
    const { workspace, sessionId } = latest.current;
    if (!workspace || !items.length) return;
    const id = ++next.current;
    const failed: string[] = [];
    const entries = items.map(({ file, directory }) => ({ file, directory, name: file.name || 'image.png',
      local: workspace.kind === 'local' ? window.desktop.pathForFile(file) : '' }))
      .filter(entry => {
        if (entry.local) return true;
        if (entry.directory) failed.push(t('composer.folderNotUploadable', { name: entry.name }));
        else if (entry.file.size > maxAttachmentBytes) failed.push(t('composer.tooLarge', { name: entry.name }));
        else return true;
        return false;
      });
    // Files from disk on this computer are mentioned where they are; the rest are uploaded,
    // their chips marked as uploading meanwhile. All of them go into the text at once.
    const chips = entries.map(entry => {
      if (!entry.local) return uploadingChip(entry.name);
      rememberAttachment(entry.local, { name: pathBasename(entry.local) + (entry.directory ? '/' : '') });
      return chipFor(mentionFor(entry.local), entry.local);
    });
    const waiting = entries.flatMap((entry, i) => entry.local ? [] : [{ chip: chips[i], name: entry.name }]);
    if (waiting.length) setUploads(list => [...list, { id, workspaceId: workspace.id, sessionId, files: waiting }]);
    const inserted = chips.length > 0 && latest.current.showing(workspace.id, sessionId);
    if (inserted) insert(chips, entries.map(entry => entry.name), replace);
    const thumbnails = await Promise.all(entries.map(entry => entry.directory ? undefined : localThumbnail(entry.file)));
    entries.forEach((entry, i) => {
      if (entry.local) rememberAttachment(entry.local, { name: pathBasename(entry.local) + (entry.directory ? '/' : ''), thumbnail: thumbnails[i] });
      else updateChip(chips[i], { thumbnail: thumbnails[i] });
    });
    refresh();
    const kept = new Set<number>(), stashed: string[] = [];
    try {
      for (const [index, { file, name, local }] of entries.entries()) {
        const chip = chips[index];
        if (local) {
          kept.add(index);
          if (!inserted) stashed.push(mentionFor(local));
          continue;
        }
        let path: string | undefined;
        try { path = await window.desktop.uploadAttachment(workspace.id, name, new Uint8Array(await file.arrayBuffer())); }
        catch (error) { failed.push(t('composer.failedWith', { name, error: message(error) })); }
        const now = latest.current, here = now.showing(workspace.id, sessionId);
        if (!path) {
          updateChip(chip, { state: 'failed' });
          if (here) commit(removeChips(view.current.text, chipTokens(view.current.text, knownChip), token => token.id === chip));
          continue;
        }
        rememberAttachment(path, { name: pathBasename(path), thumbnail: thumbnails[index] });
        kept.add(index);
        settleChip(chip, path);
        if (!here) { stashed.push(mentionFor(path)); continue; }
        const current = view.current.text;
        // Its chip now sends the path. Gone from the text: deleted meanwhile (left out), or
        // the chat was left and shown again (added after the text, as before).
        if (chipTokens(current, knownChip).some(token => token.id === chip)) commit(current);
        else if (!dropped.current.has(chip)) commit(current + chipInsertion(current, current.length, [chipToken(chip, chipWidth(sizingLabel(name), now.inputRef.current))]));
      }
    } finally {
      setUploads(list => list.filter(u => u.id !== id));
      thumbnails.forEach((url, index) => { if (url && !kept.has(index)) URL.revokeObjectURL(url); });
    }
    if (stashed.length) latest.current.stash(workspace.id, sessionId, value => value + chipInsertion(value, value.length, stashed));
    if (failed.length) latest.current.onError(t('composer.addFailed', { names: joinList(failed) }));
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (!latest.current.enabled) return;
    const items = picked(event.clipboardData), plain = event.clipboardData.getData('text/plain');
    if (pasteAttaches(items.length, items.map(i => window.desktop.pathForFile(i.file)), plain)) {
      event.preventDefault();
      void attach(items, true);
      return;
    }
    // Text naming attached files (copied or cut from here, or from a sent message): chips again.
    if (!plain || !findMentions(plain).some(mention => isAttachedPath(mention.path))) return;
    event.preventDefault();
    document.execCommand('insertText', false, displayFromDraft(plain, source));
  }

  /** What leaves the box (copy, cut, a drag) is the draft's text: chips as their @-mentions. */
  function outgoing(input: HTMLTextAreaElement) {
    const slice = input.value.slice(input.selectionStart, input.selectionEnd);
    return chipTokens(slice, knownChip).length ? draftFromDisplay(slice, chipMention, knownChip) : undefined;
  }
  function copyOut(event: ClipboardEvent<HTMLTextAreaElement>, cut: boolean) {
    const input = event.currentTarget, plain = outgoing(input);
    if (plain === undefined) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', plain);
    if (cut && !input.disabled && !input.readOnly) document.execCommand('delete');
  }

  function snap(input: HTMLTextAreaElement) {
    if (composing.current) return;
    const all = chipTokens(input.value, knownChip);
    let start = input.selectionStart, end = input.selectionEnd;
    if (all.length) [start, end] = snapSelection(all, start, end, lastSelection.current, pointer.current);
    if (start !== input.selectionStart || end !== input.selectionEnd) input.setSelectionRange(start, end, input.selectionDirection);
    lastSelection.current = [start, end];
    if (all.length) setSelection(old => old[0] === start && old[1] === end ? old : [start, end]);
  }

  /** Keys that would step into or delete part of a chip act on the whole chip. True when handled here. */
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    const input = event.currentTarget;
    if (composing.current || event.nativeEvent.isComposing) return false;
    const { selectionStart: start, selectionEnd: end } = input;
    if (start !== end || event.metaKey) return false;
    const emacs = mac && event.ctrlKey && !event.altKey;
    const back = event.key === 'Backspace' || (emacs && event.key === 'h');
    const forward = event.key === 'Delete' || (emacs && event.key === 'd');
    const step = !event.shiftKey && !event.altKey && !event.ctrlKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight');
    if (!back && !forward && !step) return false;
    const all = chipTokens(input.value, knownChip);
    const before = all.find(token => token.end === start), after = all.find(token => token.start === start);
    // Select the chip and let the key delete the selection: the browser's own, undoable deletion.
    if (back && before) input.setSelectionRange(before.start, before.end);
    else if (forward && after) input.setSelectionRange(after.start, after.end);
    else if (step && (event.key === 'ArrowRight' ? after : before)) {
      event.preventDefault();
      const edge = event.key === 'ArrowRight' ? after!.end : before!.start;
      input.setSelectionRange(edge, edge);
      lastSelection.current = [edge, edge];
      return true;
    }
    return false;
  }

  useEffect(() => {
    const release = () => { pointer.current = false; };
    window.addEventListener('mouseup', release);
    return () => window.removeEventListener('mouseup', release);
  }, []);

  const ownProps = {
    onSelect(event: SyntheticEvent<HTMLTextAreaElement>) { snap(event.currentTarget); },
    onFocus() { placed.current = chat; },
    onMouseDown() { pointer.current = true; placed.current = chat; },
    onCompositionStart() { composing.current = true; },
    onCompositionEnd() { composing.current = false; },
    onCopy(event: ClipboardEvent<HTMLTextAreaElement>) { copyOut(event, false); },
    onCut(event: ClipboardEvent<HTMLTextAreaElement>) { copyOut(event, true); },
    onDragStart(event: DragEvent<HTMLTextAreaElement>) {
      const plain = outgoing(event.currentTarget);
      if (plain !== undefined) event.dataTransfer.setData('text/plain', plain);
    },
  };
  /** The textarea's props with these handlers run before `others`' (the completion's reads the snapped selection). */
  const inputProps = <T extends object>(others: T) => chained(ownProps, others);

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

  /** A card taken out: every chip of that file leaves the text with it. */
  function remove(item: ComposerItem) {
    const current = view.current.text;
    commit(removeChips(current, chipTokens(current, knownChip), token => item.ids.includes(token.id)));
    latest.current.inputRef.current?.focus({ preventScroll: true });
  }
  function open(item: ComposerItem) {
    const workspace = latest.current.workspace;
    // Each opening is a new dialog; a close event still on its way from the last one leaves it alone.
    if (workspace && item.path && item.image) setViewing({ workspaceId: workspace.id, path: item.path, name: item.name, thumbnail: item.thumbnail, serial: ++next.current });
  }
  /** A click on a chip selects it (to cut, copy or delete it whole). */
  function pick(token: ChipToken) {
    const input = latest.current.inputRef.current;
    if (!input || input.disabled) return;
    input.focus({ preventScroll: true });
    input.setSelectionRange(token.start, token.end);
    lastSelection.current = [token.start, token.end];
    setSelection([token.start, token.end]);
  }
  const readOriginal = useCallback(() => window.desktop.previewArtifact(viewing!.workspaceId, viewing!.path), [viewing]);
  const download = useCallback(() => window.desktop.downloadArtifact(viewing!.workspaceId, viewing!.path), [viewing]);

  const strip = <>
    <ComposerAttachments items={items} onRemove={remove} onOpen={open} />
    {viewing && <ImagePreviewDialog key={viewing.serial} name={viewing.name} thumbnail={viewing.thumbnail} readOriginal={readOriginal} download={download}
      onViewFile={() => latest.current.openFile(viewing.path)} onClose={() => setViewing(current => current === viewing ? undefined : current)} />}
  </>;
  const layer = tokens.length ? <ComposerChipLayer text={text} tokens={tokens} chips={byChip} selection={selection}
    inputRef={options.inputRef} onPick={pick} onOpen={open} /> : null;

  return { pending: shown.map(file => file.name), text, setText, strip, layer, onKeyDown, inputProps,
    dragging: dragging && options.enabled, onPaste, dropTarget, choose, fileInput };
}
