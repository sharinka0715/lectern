import { useEffect, useId, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type RefObject, type SyntheticEvent } from 'react';
import { joinList, t } from '../shared/i18n';
import { File, Folder, Slash } from 'lucide-react';
import type { ChatView, CompletionItem } from '../shared/types';
import { applyCompletion, completionAction, completionAt } from './completion-input';
import { imeOwnsKey } from './enter-key';
import { matchingCommands } from '../shared/completion-commands';
import './composer-completion.css';

interface Options {
  workspaceId: string; sessionId: string; view: ChatView; enabled: boolean;
  value: string; onValue(value: string, inputType?: string): void; inputRef: RefObject<HTMLTextAreaElement | null>;
  /** A file picked from the @ list replaces the mention typed so far (`start`…`end`) itself (a chip); false to insert its text instead. */
  onFile?(start: number, end: number, path: string): boolean;
}
const sources = { builtin: 'composer.sourceBuiltin', user: 'composer.sourceUser', project: 'composer.sourceProject', plugin: 'composer.sourcePlugin', workspace: 'composer.sourceWorkspace' } as const;

export function useComposerCompletion({ workspaceId, sessionId, view, enabled, value, onValue, inputRef, onFile }: Options) {
  const id = useId(), [focused, setFocused] = useState(false), [composing, setComposing] = useState(false);
  const [range, setRange] = useState([0, 0]), [dismissed, setDismissed] = useState('');
  const [loadingKey, setLoadingKey] = useState('');
  const [result, setResult] = useState<{ key: string; items: CompletionItem[]; index: number }>();
  const restore = useRef<{ text: string; caret: number; workspaceId: string; sessionId: string } | null>(null);
  const token = enabled && focused && !composing && workspaceId && sessionId ? completionAt(value, range[0], range[1]) : undefined;
  // Include the selection and view identity even when two sessions have identical drafts.
  const key = token ? JSON.stringify([workspaceId, sessionId, view, token.kind, token.start, token.end, token.prefix]) : '';
  const open = !!key && key !== dismissed;
  const items = !open ? [] : result?.key === key ? result.items : token?.kind === 'slash' ? matchingCommands(token.prefix) : [];
  const index = items.length && result?.key === key ? result.index : 0;
  const kind = token?.kind, prefix = token?.prefix;
  // A shown conversation (or new chat) indexes its folder for `@` ahead of the first keystroke.
  useEffect(() => {
    if (workspaceId) void window.desktop.prefetchFileIndex?.(workspaceId)?.catch(() => {});
  }, [workspaceId, sessionId]);
  // A finished scan of this folder refreshes an open `@` list in place (the old one stays
  // meanwhile). A request still on its way is answered from that scan already; with no
  // `@` list open nothing re-renders.
  const [indexRevision, setIndexRevision] = useState(0), asking = useRef(false), listing = useRef(false);
  listing.current = open && kind === 'mention';
  useEffect(() => window.desktop.onFileIndexUpdated?.(id => { if (id === workspaceId && listing.current && !asking.current) setIndexRevision(n => n + 1); }), [workspaceId]);
  const revision = kind === 'mention' ? indexRevision : 0;

  useEffect(() => {
    if (!open || !kind || prefix === undefined) return;
    let live = true, pending = false;
    const request = crypto.randomUUID();
    asking.current = true;
    const timer = window.setTimeout(() => {
      pending = true; setLoadingKey(key);
      void window.desktop.completeComposer(workspaceId, view, request, { kind, prefix }).then(next => {
        if (live) setResult(old => ({ key, items: next, index: old?.key === key ? Math.max(0, next.findIndex(i => i.value === old.items[old.index]?.value)) : 0 }));
      }).catch(() => { if (live) setResult({ key, items: kind === 'slash' ? matchingCommands(prefix) : [], index: 0 }); }).finally(() => { pending = false; if (live) asking.current = false; });
    }, 85);
    return () => {
      live = false; asking.current = false; clearTimeout(timer);
      if (pending) void window.desktop.cancelComposerCompletion(view, request).catch(() => {});
    };
  }, [key, open, kind, prefix, workspaceId, view, revision]);
  useLayoutEffect(() => {
    const next = restore.current;
    if (!next) return;
    restore.current = null;
    if (next.text === value && next.workspaceId === workspaceId && next.sessionId === sessionId && inputRef.current === document.activeElement) {
      inputRef.current?.setSelectionRange(next.caret, next.caret);
      setRange([next.caret, next.caret]);
    }
  });
  useEffect(() => {
    if (items.length) document.getElementById(`${id}-option-${index}`)?.scrollIntoView({ block: 'nearest' });
  }, [id, index, items.length]);
  function updateRange(event: SyntheticEvent<HTMLTextAreaElement>) {
    const { selectionStart, selectionEnd } = event.currentTarget;
    setRange(r => r[0] === selectionStart && r[1] === selectionEnd ? r : [selectionStart, selectionEnd]);
  }
  function accept(item: CompletionItem) {
    const el = inputRef.current;
    if (!el || el.value !== value || !token || el.selectionStart !== range[0] || el.selectionEnd !== range[1]) return;
    if (item.kind === 'file' && token.kind === 'mention' && onFile?.(token.start, token.end, item.value)) {
      setResult(undefined); setDismissed(key);
      return;
    }
    const next = applyCompletion(value, token, item);
    restore.current = { ...next, workspaceId, sessionId };
    setResult(undefined); setDismissed(item.kind === 'directory' ? '' : key);
    setRange([next.caret, next.caret]); onValue(next.text);
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    const action = completionAction(event, items.length, index, imeOwnsKey(event.nativeEvent, composing), open, result?.key !== key);
    if (!action) return false;
    if (action.type === 'ime') return true; // Don't send, intercept or prevent the IME's own keystroke.
    event.preventDefault(); event.stopPropagation();
    if (action.type === 'close') { setDismissed(key); setResult(undefined); }
    else if (action.type === 'move') setResult({ key, items, index: action.index });
    else if (action.type === 'accept') accept(items[action.index]);
    return true;
  }
  const inputProps = {
    'aria-autocomplete': 'list' as const, 'aria-controls': items.length ? id : undefined,
    'aria-activedescendant': items.length ? `${id}-option-${index}` : undefined,
    onChange(event: ChangeEvent<HTMLTextAreaElement>) { setDismissed(''); updateRange(event); onValue(event.currentTarget.value, (event.nativeEvent as InputEvent).inputType); },
    onSelect: updateRange,
    onFocus(event: SyntheticEvent<HTMLTextAreaElement>) { setFocused(true); setDismissed(''); updateRange(event); },
    onBlur() { setFocused(false); setComposing(false); setResult(undefined); },
    onCompositionStart() { setComposing(true); setResult(undefined); },
    onCompositionEnd(event: SyntheticEvent<HTMLTextAreaElement>) { setComposing(false); updateRange(event); },
  };
  const popup = items.length ? <div className="composer-completion">
    <div id={id} role="listbox" aria-label={t(kind === 'slash' ? 'composer.slashCommands' : 'composer.folderFiles')} className="composer-completion-options">
      {items.map((item,i) => { const Icon = item.kind === 'command' ? Slash : item.kind === 'directory' ? Folder : File;
        return <div role="option" id={`${id}-option-${i}`} aria-selected={index === i} key={item.kind + item.value}
          onMouseDown={e => e.preventDefault()} onClick={() => accept(item)}>
          <Icon size={14} aria-hidden="true"/><span title={item.value}>{item.kind === 'command' ? '/' : ''}{item.value}{item.kind === 'directory' ? '/' : ''}</span>
          <small>{t(item.kind === 'directory' ? 'composer.directory' : item.kind === 'file' ? 'composer.file' : sources[item.source])}</small>
        </div>;
      })}
    </div><div className="composer-completion-hint">{t('composer.completionHint')}</div>
  </div> : open && loadingKey === key && result?.key !== key ? <div className="composer-completion composer-completion-loading" role="status">{t(kind === 'slash' ? 'composer.findingCommands' : 'composer.findingFiles')}</div> : null;
  return { inputProps, onKeyDown, popup };
}
