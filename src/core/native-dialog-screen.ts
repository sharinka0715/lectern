/**
 * A native Claude Code dialog Lectern has no parser of its own for, read by the layout
 * such dialogs share (2.1.330: the project MCP server approval, a reworded billing notice):
 *
 *   ────────────────────────────── (full-width rule)
 *     New MCP server found in this project: demo-notes      title
 *
 *     MCP servers may execute code or access system …      paragraphs (optional)
 *     documentation.
 *
 *       Use this MCP server                                 choices (optional): one ❯,
 *     ❯ Continue without using this MCP server              numbered ("❯ 1. Yes") or not
 *
 *     Enter to confirm · Esc to cancel                      key hints, last
 *
 * The key hints ("<key> to <what>" joined by " · ") must offer Enter or Esc; Enter picks the
 * focused choice, as in all of Claude Code's lists. Everything below the rule is indented (the
 * input box's "❯" row is not), so a reply above an input box never reads as a dialog. The text
 * alone proves nothing (a reply may quote a dialog at the bottom of a screen): only offer it
 * while Claude Code's own status record says it is waiting (main/session-permission.ts).
 */
import { terminalCells } from './screen';
import { namedEditorBorder } from './editor-border';

export interface NativeDialogChoice { label: string; focused: boolean }
export interface NativeDialogHint { key: string; action: string }
export interface NativeDialog {
  title: string;
  paragraphs: string[];
  choices: NativeDialogChoice[];
  /** The key hints in screen order; `enter` and `escape` are their actions, when offered. */
  hints: NativeDialogHint[];
  enter?: string;
  escape?: string;
  footer: string;
}

const fullRule = /^─{20,}$/u;
const dashedRule = /^╌{8,}$/u;
// A named session (2.1.329+) may close a dialog with its name in a rule below the key hints,
// the input box's upper border: any width of name (editor-border.ts).
const namedRule = namedEditorBorder;
const fence = /^\s*(?:[●⏺]\s+)?```/u;
// "<key> to <what>": Enter, Esc, Tab, shift+Tab, ctrl+g, ↑/↓, Tab/Arrow keys, a letter …
const hintPart = /^(?:Press )?((?:[A-Za-z][A-Za-z0-9]*\+)?[A-Za-z0-9]+(?:\/[A-Za-z0-9]+)*(?: keys)?|[↑↓←→](?:\/[↑↓←→])*) to (\S.*?)(?:…|\.{3})?$/u;
const MAX_ROWS = 60;

/** "Enter to confirm · Esc to cancel" as key hints, or undefined for any other text. */
export function parseKeyHints(text: string): NativeDialogHint[] | undefined {
  const parts = text.split(' · ').map(part => hintPart.exec(part.trim()));
  if (!parts.length || parts.some(part => !part)) return;
  const hints = parts.map(part => ({ key: part![1], action: part![2] }));
  // The input box's own footer while Claude works ("esc to interrupt") is no dialog.
  if (hints.some(hint => /^interrupt\b/iu.test(hint.action))) return;
  if (!hints.some(hint => isEnter(hint.key) || isEscape(hint.key))) return;
  return hints;
}
const isEnter = (key: string) => /^(?:Enter|Return)$/iu.test(key);
const isEscape = (key: string) => /^Esc(?:ape)?$/iu.test(key);

const trimBlank = (lines: string[]) => {
  let start = 0, end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end);
};
const indentOf = (line: string) => line.length - line.trimStart().length;
/** Wrapped lines of one paragraph, joined (no space between two wide characters). */
const wide = (char: string | undefined) => !!char && terminalCells(char) === 2;
function joinWrapped(parts: string[]) {
  return parts.reduce((text, part) => !text ? part : text + (wide(Array.from(text).at(-1)) && wide(Array.from(part)[0]) ? '' : ' ') + part, '');
}
const paragraphsOf = (lines: string[]) => lines.join('\n').split(/\n\s*\n/u)
  .map(block => joinWrapped(block.split('\n').map(line => line.trim()).filter(Boolean))).filter(Boolean);

/** Lines without terminal escapes; the dialog must be the last thing on them. */
export function parseNativeDialogLines(rawLines: readonly string[]): NativeDialog | undefined {
  let lines = trimBlank(rawLines.map(line => line.replace(/\u00a0/gu, ' ').trimEnd()));
  if (lines.length && namedRule.test(lines.at(-1)!)) lines = trimBlank(lines.slice(0, -1));
  let rule = lines.length - 1;
  while (rule >= 0 && !fullRule.test(lines[rule])) rule--;
  if (rule < 0 || lines.length - rule > MAX_ROWS) return;
  // A rule inside a code block of a reply is only text.
  if (lines.slice(0, rule).filter(line => fence.test(line)).length % 2) return;
  // Dashed rules (a tool dialog's box around a command or diff) only separate paragraphs.
  const body = trimBlank(lines.slice(rule + 1).map(line => dashedRule.test(line) ? '' : line));
  if (body.length < 2 || body.some(line => line && !/^ +\S/u.test(line))) return;
  const title = body[0], indent = indentOf(title);
  if (indent > 4 || body.some(line => line && indentOf(line) < indent)) return;

  // The key hints: the last two lines when a narrow terminal wraps them, else the last one.
  let end = body.length - 1, hints: NativeDialogHint[] | undefined;
  if (end > 1 && body[end - 1].trim() && indentOf(body[end - 1]) === indentOf(body[end])) {
    hints = parseKeyHints(joinWrapped([body[end - 1].trim(), body[end].trim()]));
    if (hints) end--;
  }
  hints ??= parseKeyHints(body[end].trim());
  if (!hints) return;
  const footer = joinWrapped(body.slice(end).map(line => line.trim()));

  // Choices right above the hints: "❯ " or two spaces at the dialog's indent, then the label;
  // numbered rows may wrap (deeper continuation lines), unnumbered ones never do.
  let index = end - 1;
  while (index > 0 && !body[index].trim()) index--;
  const choices: { label: string; focused: boolean; number?: number }[] = [];
  let continuation: string[] = [];
  for (; index > 0 && body[index].trim(); index--) {
    const line = body[index].slice(indent);
    const row = /^(❯ | {2})(?:([1-9]\d?)\. )?(\S.*)$/u.exec(line);
    if (row && (row[2] || !continuation.length)) {
      choices.unshift({ label: joinWrapped([row[3], ...continuation]), focused: row[1] === '❯ ', ...row[2] && { number: Number(row[2]) } });
      continuation = [];
    } else if (/^ {5,}\S/u.test(line)) continuation.unshift(line.trim());
    else break;
  }
  const focused = choices.filter(choice => choice.focused).length;
  const listed = focused === 1 && choices.length >= 2 && !continuation.length
    && (choices.every(choice => choice.number === undefined) || choices.every((choice, i) => choice.number === i + 1));
  if (!listed) {
    // No choices after all: what was read as rows is part of the text.
    if (focused) return;
    choices.length = 0;
    index = end - 1;
  }
  // Enter picks the focused choice (Claude Code's lists take it even when the hints leave it out).
  const enter = hints.find(hint => isEnter(hint.key))?.action, escape = hints.find(hint => isEscape(hint.key))?.action;
  const text = body.slice(1, index + 1);
  if (title.trim().length > 200) return;
  return { title: title.trim(), paragraphs: paragraphsOf(text), choices: choices.map(({ label, focused }) => ({ label, focused })),
    hints, ...enter !== undefined && { enter }, ...escape !== undefined && { escape }, footer };
}
