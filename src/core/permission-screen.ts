import { stripTerminalEscapes } from './screen';
import type { NativePermissionOption, NativePermissionScreen } from '../shared/native-permission';

/**
 * Claude Code's tool permission dialog (2.1.328), which replaces the input box:
 *
 *   ────────────────────────────── (full-width rule)
 *    Bash command                   title
 *    Write a greeting file          description / path (optional)
 *   ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 *    echo hello > greeting.txt      command, file preview or diff (optional)
 *   ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 *    Do you want to proceed?
 *    ❯ 1. Yes
 *      2. Yes, and always allow access to /work
 *         from this project         (wrapped option)
 *      3. No
 *    Esc to cancel · Tab to amend
 */
export type { NativePermissionOption, NativePermissionScreen } from '../shared/native-permission';

const fullRule = /^─{20,}$/u;
const dashedRule = /^╌{8,}$/u;
const optionRow = /^(❯| ) ([1-9])\. (\S.*)$/u;
const footerRow = /^Esc to cancel(?: · \S.*)?$/u;

export function parsePermissionScreen(viewport: string): NativePermissionScreen | undefined {
  const lines = stripTerminalEscapes(viewport).split('\n').map(line => line.replace(/\s+$/u, ''));
  let end = lines.length - 1;
  while (end >= 0 && !lines[end]) end--;
  // The dialog occupies the bottom of the screen in place of the input box.
  const footer = lines[end]?.replace(/^ /u, '');
  if (!footer || !lines[end].startsWith(' ') || !footerRow.test(footer)) return questionTitled(lines, end);
  // Options, bottom-up: a numbered row, or a deeper-indented continuation of the row above.
  const options: NativePermissionOption[] = [];
  let continuation: string[] = [];
  let index = end - 1;
  while (index >= 0 && !lines[index]) index--;
  for (; index >= 0; index--) {
    const line = lines[index];
    if (!line.startsWith(' ')) break;
    const row = optionRow.exec(line.slice(1));
    if (row) {
      options.unshift({ number: Number(row[2]), label: [row[3], ...continuation].join(' '), focused: row[1] === '❯' });
      continuation = [];
    } else if (/^ {5,}\S/u.test(line)) {
      continuation.unshift(line.trim());
    } else break;
  }
  if (continuation.length || options.length < 2 || options.some((option, i) => option.number !== i + 1)
      || options.filter(option => option.focused).length !== 1) return;
  // The question, then (upwards) the optional dashed box, description and title up to the rule.
  const question: string[] = [];
  for (; index >= 0 && lines[index].startsWith(' ') && lines[index].trim() && !dashedRule.test(lines[index].trim()); index--) question.unshift(lines[index].trim());
  if (!question.length || !question.at(-1)!.endsWith('?')) return;
  let top = index;
  while (top >= 0 && !fullRule.test(lines[top])) top--;
  if (top < 0 || end - top > 200) return;
  const body = lines.slice(top + 1, index + 1).map(line => line.replace(/^ /u, ''));
  const dashes = body.flatMap((line, i) => dashedRule.test(line) ? [i] : []);
  if (dashes.length && dashes.length !== 2) return;
  const head = (dashes.length ? body.slice(0, dashes[0]) : body).filter(line => line.trim());
  const title = head[0]?.trim();
  if (!title || title.length > 120) return;
  // Inside the box the lines keep their own indentation (diffs, file previews).
  const content = dashes.length ? body.slice(dashes[0] + 1, dashes[1]) : [];
  // Below the box only a quoted note may follow (auto mode asking after blocked actions).
  const notice = dashes.length ? quotedNotice(body.slice(dashes[1] + 1)) : undefined;
  if (notice === null) return;
  return { title, subtitle: head.slice(1).map(line => line.trim()), content, question: question.join(' '), options, footer, ...(notice && { notice }) };
}

/** Lines quoted with "│" (blank lines around them allowed), as paragraphs; undefined
 * when there is nothing, null when anything else is there. Claude Code 2.1.300+ in auto
 * mode, after its safety check blocked actions in a row:
 *
 *   ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 *    │ Auto mode needs your confirmation for this command.
 *    │ 3 consecutive actions were blocked. Please review the transcript before continuing.
 *    │
 *    │ Latest blocked action: Auto mode could not evaluate this action and is blocking it …
 *
 *    Do you want to proceed?
 */
function quotedNotice(lines: string[]): string[] | undefined | null {
  let first = 0, last = lines.length - 1;
  while (first <= last && !lines[first].trim()) first++;
  while (last >= first && !lines[last].trim()) last--;
  if (first > last) return undefined;
  const block = lines.slice(first, last + 1);
  if (!block.every(line => /^│(?: |$)/u.test(line))) return null;
  return block.map(line => line.replace(/^│ ?/u, '').trim()).join('\n').split(/\n{2,}/u).map(part => part.replace(/\n/gu, ' ').trim()).filter(Boolean);
}

/**
 * A confirmation whose title is the question, everything below it indented by
 * two, e.g. Claude Code 2.1.329 before a dynamic workflow runs:
 *
 *   ──────────────────────────────
 *    Run a dynamic workflow?
 *
 *     Map two folders                     subtitle (first paragraph)
 *
 *     This dynamic workflow will spin …   content (the other paragraphs,
 *       1. Map                            numbered phases included)
 *
 *     ❯ 1. Yes, run it
 *       2. View raw script
 *       3. No
 *
 *     Esc to cancel · Tab to amend
 *     ctrl+g to edit script in $EDITOR    (optional hint)
 */
function questionTitled(lines: string[], end: number): NativePermissionScreen | undefined {
  const hints: string[] = [];
  while (end >= 0 && /^ {2}ctrl\+g to edit \S/u.test(lines[end])) { hints.unshift(lines[end].trim()); end--; }
  const footer = /^ {2}(Esc to cancel(?: · \S.*)?)$/u.exec(lines[end] ?? '')?.[1];
  if (!footer) return;
  let index = end - 1;
  while (index >= 0 && !lines[index]) index--;
  const options: NativePermissionOption[] = [];
  let continuation: string[] = [];
  for (; index >= 0 && lines[index]; index--) {
    const row = /^ {2}(❯| ) ([1-9])\. (\S.*)$/u.exec(lines[index]);
    if (row) {
      options.unshift({ number: Number(row[2]), label: [row[3], ...continuation].join(' '), focused: row[1] === '❯' });
      continuation = [];
    } else if (/^ {6,}\S/u.test(lines[index])) continuation.unshift(lines[index].trim());
    else return;
  }
  if (continuation.length || options.length < 2 || options.some((option, i) => option.number !== i + 1)
      || options.filter(option => option.focused).length !== 1) return;
  let top = index;
  while (top >= 0 && !fullRule.test(lines[top])) top--;
  if (top < 0 || index - top > 120) return;
  const title = /^ (\S.*\?)$/u.exec(lines[top + 1] ?? '')?.[1];
  const body = lines.slice(top + 2, index + 1);
  if (!title || title.length > 120 || body.some(line => line && !line.startsWith('  '))) return;
  const paragraphs = body.map(line => line.slice(2)).join('\n').split(/\n{2,}/u).map(part => part.replace(/^\n+|\n+$/gu, '')).filter(Boolean);
  if (!paragraphs.length) return;
  return { title, subtitle: paragraphs[0].split('\n').map(line => line.trim()), content: paragraphs.slice(1).join('\n\n').split('\n'),
    question: title, options, footer: [footer, ...hints].join(' · ') };
}

/** The same dialog in two frames: focus may differ, nothing else. */
export function samePermission(a: NativePermissionScreen, b: NativePermissionScreen): boolean {
  const layout = (s: NativePermissionScreen) => JSON.stringify([s.title, s.subtitle, s.content, s.notice, s.question, s.options.map(o => [o.number, o.label])]);
  return layout(a) === layout(b);
}
export const focusedPermission = (screen: NativePermissionScreen) => screen.options.findIndex(option => option.focused);
