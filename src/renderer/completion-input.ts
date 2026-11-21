import type { CompletionItem, CompletionQuery } from '../shared/types';
import { isEnterKey } from './enter-key';

export interface CompletionToken extends CompletionQuery { start: number; end: number }
/** selectionStart/End and JS slice both use UTF-16 offsets (including emoji before the trigger). */
export function completionAt(value: string, caret: number, selectionEnd = caret): CompletionToken | undefined {
  if (caret !== selectionEnd || caret < 0 || caret > value.length) return;
  const left = value.slice(0, caret), right = value.slice(caret);
  const slash = /^[ \t]*\/([\p{L}\p{N}\p{M}_:./-]*)$/u.exec(left);
  if (slash && slash[1].length <= 1024) return { kind: 'slash', prefix: slash[1], start: left.indexOf('/'), end: caret + (/^[\p{L}\p{N}\p{M}_:./-]*/u.exec(right)?.[0].length ?? 0) };
  // Search only the current line. A mention must have a word boundary (not an email).
  // Support spaces via quotes and backslash escaping, without treating following prose as a path.
  const line = left.slice(Math.max(left.lastIndexOf('\n') + 1, caret - 2050));
  const match = /(?:^|[\s。、？！])(@"([^"]*)|@((?:\\[ \t]|[\p{L}\p{N}\p{M}_\-./\\()[\]~:])*))$/u.exec(line);
  if (!match) return;
  const quoted = match[2] !== undefined;
  const prefix = quoted ? match[2] : match[3].replace(/\\([ \t])/gu, '$1');
  if (prefix.length > 1024) return;
  // With an open quote but no closing quote don't swallow the rest of a sentence.
  const suffix = quoted ? /^[^"\n]*"/u.exec(right) : /^(?:\\[ \t]|[\p{L}\p{N}\p{M}_\-./\\()[\]~:])*/u.exec(right);
  return { kind: 'mention', prefix, start: caret - match[1].length, end: caret + (suffix?.[0].length ?? 0) };
}
export function applyCompletion(value: string, token: CompletionToken, item: CompletionItem) {
  const directory = item.kind === 'directory';
  const path = item.value + (directory ? '/' : '');
  const quote = !/^[\p{L}\p{N}\p{M}_./-]+$/u.test(path);
  const inserted = item.kind === 'command' ? '/' + item.value : quote ? '@"' + path + '"' : '@' + path;
  const suffix = value.slice(token.end);
  // A directory keeps the caret inside any quotes so the user can continue walking the tree.
  const spacer = directory || /^\s/u.test(suffix) ? '' : ' ';
  return { text: value.slice(0, token.start) + inserted + spacer + suffix,
    caret: token.start + inserted.length + spacer.length + (!directory && /^\s/u.test(suffix) ? 1 : 0) - (directory && quote ? 1 : 0) };
}

interface Key { key: string; code?: string; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }
export function completionAction(event: Key, size: number, active: number, composing: boolean, hasToken: boolean, pending = false) {
  if (composing) return { type: 'ime' } as const;
  if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || !hasToken) return;
  if (event.key === 'Escape') return { type: 'close' } as const;
  if (!size) return pending && (isEnterKey(event) || event.key === 'Tab') ? { type: 'wait' } as const : undefined;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') return { type: 'move', index: (active + (event.key === 'ArrowDown' ? 1 : size - 1)) % size } as const;
  if (isEnterKey(event) || event.key === 'Tab') return { type: 'accept', index: active } as const;
}
