import { inTranscriptExample } from './dialog-boundary';
import { parseExecutionMode } from './session-telemetry';
import { classifySessionScreen, stripTerminalEscapes, withoutRightNotice, withoutTaskRows } from './screen';
import { parseCacheConfirmationLines, type ModelSwitchConfirmation } from './model-switch-confirmation';
import { hasCurrentApiErrorBeforeRetry } from './api-error-recovery';
export type { ModelSwitchConfirmation } from './model-switch-confirmation';

export type SettingKind = 'model' | 'effort';
export interface SettingScreenOption {
  key: string;
  label: string;
  description?: string;
  ordinal: number;
  /** Only an explicit persisted-current checkmark, never the menu cursor. */
  current: boolean;
  focused: boolean;
  disabled?: boolean;
  disclosure?: 'collapsed' | 'expanded' | 'unknown';
}
export interface SettingMenuScreen {
  state: 'menu';
  kind: SettingKind;
  options: SettingScreenOption[];
  currentKey?: string;
  focusedKey?: string;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  moreBeforeCount?: number;
  moreAfterCount?: number;
  sessionOnlyKey?: 's';
  cancelKey?: 'Escape';
  disclosureAction?: 'expand' | 'collapse';
  /** Explicit checkmarked model label. Never inferred from the welcome banner. */
  displayCurrent?: string;
  /** Model footer and slider values change while navigating; they are not commit evidence. */
  observedEffort?: { value: string; source: 'model-focus' | 'effort-focus' };
  /** Location of the slider label selected by the native ▲, independent of its color. */
  effortFocusCell?: { linesAboveFooter: number; column: number };
  /** The effort slider's "Ultracode on|off · Tab to toggle" control, when offered. */
  ultracode?: 'on' | 'off';
  signature: string;
}
export type SettingScreen = SettingMenuScreen
  | ({ state: 'model-confirmation' | 'effort-confirmation' } & ModelSwitchConfirmation)
  | { state: 'unknown-command'; command: string }
  | { state: 'idle'; emptyInput: boolean }
  | { state: 'unrecognized'; reason?: string };

// Named sessions put their title into the editor's upper border.
const separator = /^\s*[─━═▔╌┄-]{5,}(?: \S(?:.*\S)? [─━═▔╌┄-]+)?\s*$/u;
export const TMUX_FOCUS_HINT = "tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf and reattach for focus tracking";
const footerPattern = /\b(?:Enter to (?:set as default|confirm)|Esc to cancel)\b/i;
function linesOf(screen: string): string[] {
  const lines = stripTerminalEscapes(screen).replace(/\u00a0/g, ' ').split('\n');
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  return lines;
}
function lastIndex(lines: string[], test: (line: string, index: number) => boolean): number {
  for (let index = lines.length - 1; index >= 0; index--) if (test(lines[index], index)) return index;
  return -1;
}
/** Only Claude's cache-cost model-switch confirmation; never a generic approval. */
export function parseModelSwitchConfirmation(viewport: string): ModelSwitchConfirmation | undefined {
  const parsed = parseCacheConfirmationLines(linesOf(viewport));
  return parsed?.kind === 'model' ? parsed : undefined;
}
function menuBounds(lines: string[], kind: SettingKind): { start: number; end: number } | undefined {
  const start = lastIndex(lines, line => kind === 'model' ? /^\s*Select model\s*$/i.test(line) : /^\s*Effort\s*$/i.test(line));
  if (start < 0 || inTranscriptExample(lines.slice(0, start))) return;
  const end = lines.findIndex((line, index) => index > start && footerPattern.test(line));
  if (end <= start) return;
  // The native menu ends at its footer. A returned composer or another dialog
  // underneath it means this earlier menu no longer owns terminal input.
  if (lines.slice(end + 1).some(line => line.trim())) return;
  return { start, end };
}
function controls(footer: string): Pick<SettingMenuScreen, 'sessionOnlyKey' | 'cancelKey'> {
  return {
    sessionOnlyKey: /(?:^|[·•])\s*s\s+(?:to use this|for this)\s+session only(?:\s*[·•]|\s*$)/i.test(footer) ? 's' : undefined,
    cancelKey: /(?:^|[·•])\s*Esc to cancel(?:\s*[·•]|\s*$)/i.test(footer) ? 'Escape' : undefined,
  };
}
function pagination(lines: string[]): Pick<SettingMenuScreen, 'hasMoreBefore' | 'hasMoreAfter' | 'moreBeforeCount' | 'moreAfterCount'> {
  let before: RegExpMatchArray | null = null, after: RegExpMatchArray | null = null;
  for (const line of lines) {
    before ??= line.match(/^\s*↑\s*(?:(\d+)\s+)?more\s*$/i);
    after ??= line.match(/^\s*↓\s*(?:(\d+)\s+)?more\s*$/i);
  }
  return { hasMoreBefore: !!before, hasMoreAfter: !!after,
    moreBeforeCount: before?.[1] ? Number(before[1]) : undefined,
    moreAfterCount: after?.[1] ? Number(after[1]) : undefined };
}
function finishMenu(menu: Omit<SettingMenuScreen, 'state' | 'signature'>): SettingScreen {
  if (!menu.options.length) return { state: 'unrecognized', reason: 'menu-has-no-readable-options' };
  if (new Set(menu.options.map(option => option.ordinal)).size !== menu.options.length
    || new Set(menu.options.map(option => option.key)).size !== menu.options.length) return { state: 'unrecognized', reason: 'duplicate-option-identities' };
  const focused = menu.options.filter(option => option.focused), current = menu.options.filter(option => option.current);
  if (focused.length !== 1 || current.length > 1) return { state: 'unrecognized', reason: 'ambiguous-menu-markers' };
  return { state: 'menu', ...menu, focusedKey: focused[0].key, currentKey: current[0]?.key,
    signature: JSON.stringify({ kind: menu.kind, options: menu.options, before: menu.hasMoreBefore, after: menu.hasMoreAfter,
      sessionOnlyKey: menu.sessionOnlyKey, cancelKey: menu.cancelKey }) };
}

// The standard model picker dims the number on every row, but dims the label
// itself only on disabled rows. tmux may carry SGR state across physical lines.
function dimmedModelLabels(viewport: string): Set<number> {
  const disabled = new Set<number>();
  if (!viewport.includes('\x1b[')) return disabled;
  let dim = false;
  const lines = viewport.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index], plain = stripTerminalEscapes(raw).replace(/\u00a0/g, ' ');
    const offset = /^\s*(?:❯\s*)?\d+[.)]\s+/u.exec(plain)?.[0].length;
    let column = 0;
    for (const chunk of raw.split(/(\x1b\[[\d;:]*m)/u)) {
      if (!chunk.startsWith('\x1b[') || !chunk.endsWith('m')) {
        const length = stripTerminalEscapes(chunk).length;
        if (offset !== undefined && offset >= column && offset < column + length && dim) disabled.add(index);
        column += length;
        continue;
      }
      const attrs = chunk.slice(2, -1).split(';');
      for (let pos = 0; pos < attrs.length; pos++) {
        const code = Number(attrs[pos]);
        if (code === 0 || code === 22) dim = false;
        if (code === 2) dim = true;
        if ([38, 48, 58].includes(code)) pos += attrs[pos + 1] === '2' ? 4 : attrs[pos + 1] === '5' ? 2 : 0;
      }
    }
  }
  return disabled;
}

function parseModel(lines: string[], bounds: { start: number; end: number }, dimmed: Set<number>): SettingScreen {
  const section = lines.slice(bounds.start + 1, bounds.end);
  const options: SettingScreenOption[] = [];
  let wrappedDescription: { option: SettingScreenOption; column: number } | undefined;
  for (const [index, line] of section.entries()) {
    const disclosure = /^\s*(❯\s*)?(?:([▸▹▶▾▿▼])|(?:(\d+)[.)]))\s+More models(?:, (expanded|collapsed))?\s*$/u.exec(line);
    if (disclosure) {
      const marker = disclosure[2], text = disclosure[4];
      const state = marker ? '▾▿▼'.includes(marker) ? 'expanded' : 'collapsed' : text || 'unknown';
      if (text && text !== state) return { state: 'unrecognized', reason: 'conflicting-disclosure' };
      // Native disclosure markers occupy a row without consuming a model number.
      const next = section.slice(index + 1).map(value => /^\s*(?:❯\s*)?(\d+)[.)]\s/u.exec(value)).find(Boolean);
      const ordinal = disclosure[3] ? Number(disclosure[3]) : options.length ? options.at(-1)!.ordinal + .5 : next ? Number(next[1]) - .5 : 0;
      options.push({ key: 'disclosure:more-models', label: 'More models', ordinal, current: false, focused: !!disclosure[1], disclosure: state as SettingScreenOption['disclosure'] });
      wrappedDescription = undefined;
      continue;
    }
    if (/^\s*(?:❯\s*)?[^\w\s]*\s*More models(?:,|\s*$)/i.test(line)) return { state: 'unrecognized', reason: 'unknown-disclosure' };
    const row = /^\s*(❯\s*)?(\d+)[.)]\s+(.+?)\s*$/.exec(line);
    if (!row) {
      // Claude hard-wraps descriptions at their column. A current checkmark can
      // resize the label column, changing wraps without changing the option.
      const indent = line.search(/\S/);
      if (wrappedDescription && indent >= wrappedDescription.column) {
        wrappedDescription.option.description += ` ${line.trim()}`;
      } else wrappedDescription = undefined;
      continue;
    }
    wrappedDescription = undefined;
    const cells = row[3].split(/\s{2,}/);
    const rawLabel = cells.shift() ?? '';
    const current = /[✔✓]/u.test(rawLabel) || /\(selected\)/i.test(rawLabel);
    const label = rawLabel.replace(/[✔✓]|\s*\((?:selected|disabled)\)/giu, '').trim();
    if (!label) return { state: 'unrecognized', reason: 'empty-model-label' };
    const ordinal = Number(row[2]);
    if (!Number.isSafeInteger(ordinal) || ordinal < 1) return { state: 'unrecognized', reason: 'invalid-option-ordinal' };
    const option = { key: `model:${ordinal}:${label}`, label, description: cells.join('  ') || undefined,
      ordinal, current, focused: !!row[1], ...(dimmed.has(bounds.start + index + 1) || /\(disabled\)/i.test(rawLabel) ? { disabled: true } : {}) };
    options.push(option);
    const gap = /\s{2,}/.exec(row[3]);
    if (option.description && gap) wrappedDescription = {
      option, column: line.indexOf(row[3]) + gap.index + gap[0].length,
    };
  }
  const enterActions = lines[bounds.end].trim().split(/\s*[·•]\s*/u).filter(hint => /^enter\s/i.test(hint));
  const disclosureAction = enterActions.length === 1 ? /^Enter to (expand|collapse)$/i.exec(enterActions[0])?.[1].toLowerCase() : undefined;
  const effort = section.map(line => /^\s*[◐◉○◌●]?\s*(.+?)\s+effort\b.*[←→]/iu.exec(line)).find(Boolean)?.[1]?.trim();
  return finishMenu({ kind: 'model', options, ...pagination(section), ...controls(lines[bounds.end]),
    disclosureAction: disclosureAction === 'expand' || disclosureAction === 'collapse' ? disclosureAction : undefined,
    displayCurrent: options.find(option => option.current)?.label,
    observedEffort: effort ? { value: effort, source: 'model-focus' } : undefined });
}

function parseEffort(lines: string[], bounds: { start: number; end: number }): SettingScreen {
  const section = lines.slice(bounds.start + 1, bounds.end);
  let trackIndex = -1, track: RegExpExecArray | null = null;
  for (let index = 0; index < section.length; index++) {
    const match = /[─━═-]*▲[─━═-]*/u.exec(section[index]);
    if (match && /[─━═-]/u.test(match[0])) { trackIndex = index; track = match; break; }
  }
  if (!track) return { state: 'unrecognized', reason: 'effort-slider-not-visible' };
  const pointer = track.index + track[0].indexOf('▲');
  const labelRow = section.findIndex((line, i) => i > trackIndex && !!line.trim());
  const labels = section[labelRow];
  if (!labels) return { state: 'unrecognized', reason: 'effort-labels-not-visible' };
  // Read only labels aligned beneath the observed track. Other controls such as
  // Ultracode/Tab are outside its horizontal range and are not effort options.
  const cells: { label: string; center: number; column: number }[] = [];
  for (const match of labels.matchAll(/\S(?:.*?\S)?(?=\s{2,}|$)/g)) {
    const center = match.index! + (match[0].length - 1) / 2;
    if (center >= track.index - 1 && center <= track.index + track[0].length) cells.push({ label: match[0], center, column: match.index! });
  }
  if (cells.length < 2) return { state: 'unrecognized', reason: 'insufficient-slider-labels' };
  const distance = Math.min(...cells.map(cell => Math.abs(cell.center - pointer)));
  const focus = cells.map((cell, index) => ({ index, distance: Math.abs(cell.center - pointer) })).filter(item => item.distance === distance);
  if (focus.length !== 1) return { state: 'unrecognized', reason: 'ambiguous-slider-pointer' };
  const options = cells.map((cell, index) => ({ key: `effort:${cell.label}`, label: cell.label, ordinal: index + 1,
    current: false, focused: index === focus[0].index }));
  // Offered only when dynamic workflows are on and the model supports it.
  const toggle = /\bUltracode\s+(on|off)\s*$/u.exec(section[trackIndex].slice(track.index + track[0].length));
  const ultracode = toggle && /\bTab to toggle\s*$/u.test(labels) ? toggle[1] as 'on' | 'off' : undefined;
  return finishMenu({ kind: 'effort', options, ...pagination(section), ...controls(lines[bounds.end]), ...(ultracode && { ultracode }),
    effortFocusCell: { linesAboveFooter: section.length - labelRow, column: cells[focus[0].index].column },
    observedEffort: { value: options[focus[0].index].label, source: 'effort-focus' } });
}

// A newly opened native panel can follow the previous assistant response
// directly. Reuse only transcript rows that were already present above the
// verified idle composer. New assistant/tool output retains its ownership.
export function priorComposerHistory(viewport: string): string[] {
  const lines = linesOf(viewport);
  const prompt = lastIndex(lines, line => /^\s*[❯>]/u.test(line));
  if (prompt < 1 || !separator.test(lines[prompt - 1])) return [];
  return historyAbove(lines, prompt - 1);
}

function historyAbove(lines: string[], end: number): string[] {
  const history = lines.slice(0, end).map(line => line.trimEnd());
  // The right-aligned effort badge and tmux advisory sit above the idle
  // composer. Either can move into the picker's top border or disappear.
  while (history.length) {
    const last = history.at(-1)!;
    const hint = last.startsWith('  ') && last.trimStart() === TMUX_FOCUS_HINT;
    // Right-aligned rows (effort badge, IDE or update notices) are not transcript.
    if (last.trim() && !hint && !/^\s*[◐◉○◌●]\s+.+?\s*·\s*\/effort\s*$/u.test(last) && withoutRightNotice(last)) break;
    history.pop();
  }
  return history;
}

export function newSettingViewport(viewport: string, previous: string[]): string {
  if (!previous.length) return viewport;
  const raw = viewport.split('\n');
  const rows = raw.map(line => stripTerminalEscapes(line).replace(/\u00a0/g, ' ').trimEnd());
  if (previous.every((line, index) => line === rows[index])) return raw.slice(previous.length).join('\n');

  // A taller native panel scrolls the oldest transcript rows out of tmux.
  // Everything still visible above its border must match the end of idle history.
  const title = lastIndex(rows, line => /^\s*(?:Select model|Effort|Switch model\?|Change effort level\?)\s*$/i.test(line));
  const border = title - 1;
  if (border < 1 || !/^\s*▔{5,}(?: .+ ▔+)?$/u.test(rows[border])) return viewport;
  const history = rows.slice(0, border);
  const first = history.findIndex(line => line.length > 0);
  if (first < 0) return viewport;
  const visible = history.slice(first, lastIndex(history, line => line.length > 0) + 1);
  const start = previous.length - visible.length;
  if (start < 0 || !visible.every((line, index) => line === previous[start + index])) return viewport;
  return raw.slice(border).join('\n');
}

/** True only for a ready empty composer, including a recoverable native API error. */
export function isIdleEmptyComposer(viewport: string): boolean {
  const lines = withoutTaskRows(linesOf(viewport));
  if (menuBounds(lines, 'model') || menuBounds(lines, 'effort')) return false;
  const status = classifySessionScreen(viewport).status;
  if (status === 'working' || status === 'waiting') return false;
  const index = lastIndex(lines, line => /^\s*[❯>]/.test(line));
  if (index < 0 || index < lines.length - 12) return false;
  if (/^\s*[❯>]\s*$/.test(lines[index])) return status === 'idle' || status === 'error';
  const boxed = index > 0 && index + 1 < lines.length
    && separator.test(lines[index - 1]) && separator.test(lines[index + 1]);
  if (!boxed) return false;
  if (/^\s*❯\s+Try ["“].+["”]\s*$/.test(lines[index])) return status === 'idle';
  if (!/^\s*❯\s+Once fixed, resend your message\s*$/.test(lines[index])) return false;
  return hasCurrentApiErrorBeforeRetry(lines, index);
}

/** A bare menu command, or an inline switch such as "/model haiku" / "/effort high". */
type SettingCommand = '/model' | '/effort' | `/model ${string}` | `/effort ${string}`;

function lastBoxedPrompt(lines: string[]) {
  return lastIndex(lines, (line, i) => /^\s*[❯>]/u.test(line) && i > 0
    && separator.test(lines[i - 1]) && separator.test(lines[i + 1] ?? ''));
}

/** The optional tmux advisory has a dedicated row immediately above the idle
 * composer's upper border. It may disappear while a settings paste is pending. */
export function idleComposerAdvisoryRow(viewport: string): number | undefined {
  if (!isIdleEmptyComposer(viewport)) return;
  const lines = linesOf(viewport), prompt = lastBoxedPrompt(lines);
  if (prompt >= 2 && prompt === lastIndex(lines, line => /^\s*[❯>]/u.test(line))) return prompt - 2;
}

interface CompletionBlock {
  start: number;
  end: number;
  focused: { command: string; hasDescription: boolean }[];
}

/** Completion descriptions can span multiple terminal rows. Claude aligns
 * those continuations under the description, including when they start with /. */
function completionBlocks(lines: string[]): CompletionBlock[] {
  const blocks: CompletionBlock[] = [];
  let active: CompletionBlock | undefined, descriptionColumn = -1;
  for (const [i, line] of lines.entries()) {
    if (active && descriptionColumn >= 0 && line.search(/\S/u) >= descriptionColumn) {
      active.end = i + 1;
      continue;
    }
    const row = /^(\s*)([❯>]\s*)?(\/\S+)(?:([ \t]+)(\S.*))?$/u.exec(line.trimEnd());
    if (!row) { active = undefined; continue; }
    if (!active) {
      active = { start: i, end: i + 1, focused: [] };
      blocks.push(active);
    }
    active.end = i + 1;
    descriptionColumn = row[5] ? row[1].length + (row[2]?.length ?? 0) + row[3].length + row[4].length : -1;
    if (row[2]) active.focused.push({ command: row[3], hasDescription: !!row[5] });
  }
  return blocks;
}

function commandEntry(lines: string[], prompt: number, command: SettingCommand) {
  if (prompt < 0 || lines[prompt].trim().slice(1).trim() !== command) return;
  const above = lines.slice(0, prompt - 1), below = lines.slice(prompt + 2);
  const upper = completionBlocks(above).find(block => block.end === above.length);
  const lower = completionBlocks(below).find(block => block.start === below.findIndex(line => line.trim()));
  if (upper && lower) return;
  const choices = upper ?? lower;
  if (choices && (choices.focused.length !== 1 || choices.focused[0].command !== command)) return;
  const footer = below.slice(lower?.end ?? 0).map(line => withoutRightNotice(line).trim()).filter(Boolean);
  const historyEnd = upper?.start ?? prompt - 1;
  const screen = [...lines.slice(0, historyEnd), ...lines.slice(prompt - 1, prompt + 2), ...footer].join('\n');
  const state = classifySessionScreen(screen).status;
  if (state === 'waiting' || state === 'working' || state === 'error') return;
  return { choices, footer, historyEnd };
}

/** Only an explicit click on the same chooser may adopt an already typed
 * command. Require both the boxed draft and the matching native completion. */
export function focusedSettingCommandHistory(viewport: string, command: SettingCommand): string[] | undefined {
  const lines = linesOf(viewport), prompt = lastBoxedPrompt(lines);
  const entry = commandEntry(lines, prompt, command);
  if (!entry?.choices?.focused[0].hasDescription || entry.footer.length > 1) return;
  const [footer] = entry.footer;
  if (footer && footer !== '? for shortcuts') {
    // Reject new controls or arbitrary status text when there is no idle frame
    // from this transaction to compare against.
    const [badge, ...hints] = footer.split(/\s*·\s*/u);
    if (hints.some(hint => hint !== '? for shortcuts' && hint !== '← for agents')) return;
    if (!parseExecutionMode([...lines.slice(prompt - 1, prompt + 2), badge].join('\n'))) return;
  }
  return historyAbove(lines, entry.historyEnd);
}

/** Before Enter, distinguish the typed slash command from an autocomplete row,
 * transcript echo, changed draft, or new dialog that also accepts Enter. */
export function hasPendingSettingCommand(viewport: string, command: SettingCommand, idleViewport: string): boolean {
  const lines = linesOf(viewport), idle = linesOf(idleViewport);
  const prompt = lastBoxedPrompt(lines), previous = lastBoxedPrompt(idle);
  // Older unboxed layouts can prove the same transition if the draft is the
  // only changed line in the entire viewport, including the prompt character.
  if (previous < 0 && prompt < 0 && lines.length === idle.length) {
    const i = lastIndex(idle, line => /^\s*[❯>]\s*$/u.test(line));
    return i >= 0 && i === lastIndex(idle, line => /^\s*[❯>]/u.test(line))
      && lines[i].trim().slice(0, 1) === idle[i].trim() && lines[i].trim().slice(1).trim() === command
      && idle.every((line, n) => n === i || lines[n].trimEnd() === line.trimEnd());
  }
  if (previous < 0) return false;
  const entry = commandEntry(lines, prompt, command);
  if (!entry) return false;
  const previousFooter = idle.slice(previous + 2).map(line => withoutRightNotice(line).trim()).filter(Boolean);
  // Claude removes its idle-only agent shortcut as soon as a draft is typed.
  return !entry.footer.length || (entry.footer.length === previousFooter.length && entry.footer.every((line, i) =>
    previousFooter[i] === line || previousFooter[i] === line + ' · ← for agents'));
}

/** An idle footer is a fresh observation; a welcome banner is deliberately ignored. */
export function observeEffortFooter(viewport: string): { value: string; source: 'composer-footer' } | undefined {
  if (!isIdleEmptyComposer(viewport)) return;
  const footer = linesOf(viewport).slice(-12);
  for (let index = footer.length - 1; index >= 0; index--) {
    const match = /^\s*[◐◉○◌●]\s*(.+?)\s*·\s*\/effort\s*$/u.exec(footer[index]);
    if (match?.[1]?.trim()) return { value: match[1].trim(), source: 'composer-footer' };
  }
}

/** Parse actual viewport evidence. No model names, effort levels or defaults are supplied. */
export function parseSettingScreen(viewport: string, kind: SettingKind): SettingScreen {
  const lines = linesOf(viewport);
  const confirmation = parseCacheConfirmationLines(lines);
  if (confirmation) return kind === confirmation.kind ? { state: kind === 'model' ? 'model-confirmation' : 'effort-confirmation', ...confirmation }
    : { state: 'unrecognized', reason: 'different-setting-confirmation' };
  const title = lastIndex(lines, line => line.trim() === 'Switch model?');
  if (title >= 0 && !inTranscriptExample(lines.slice(0, title)) && lines.slice(title + 1).find(line => line.trim())?.trim() === 'A PreModelSwitch hook asked you to confirm'
    && !isIdleEmptyComposer(viewport)) return { state: 'unrecognized', reason: 'model-hook-confirmation' };
  const model = menuBounds(lines, 'model'), effort = menuBounds(lines, 'effort');
  const activeKind = model && effort ? model.start > effort.start ? 'model' : 'effort' : model ? 'model' : effort ? 'effort' : undefined;
  if (activeKind) {
    if (activeKind !== kind) return { state: 'unrecognized', reason: 'different-setting-menu' };
    return activeKind === 'model' ? parseModel(lines, model!, dimmedModelLabels(viewport)) : parseEffort(lines, effort!);
  }
  const latestSlash = lastIndex(lines, line => /^\s*❯\s*\/[\w-]+(?:\s|$)/.test(line));
  // Even a partially redrawn dialog supersedes a previous command failure.
  const latestMenuHeader = lastIndex(lines, line => /^\s*(?:Select model|Effort)\s*$/i.test(line));
  for (let index = lines.length - 1; index > Math.max(latestSlash, latestMenuHeader); index--) {
    const failure = /^\s*(?:[⏺●]\s*)?Unknown command:\s*(\/[\w-]+)\.?\s*(?:Did you mean\s+(\/[\w-]+)\?)?\s*$/i.exec(lines[index]);
    if (failure) return { state: 'unknown-command', command: failure[1] };
  }
  if (isIdleEmptyComposer(viewport)) return { state: 'idle', emptyInput: true };
  return { state: 'unrecognized', reason: 'no-supported-menu-or-empty-composer' };
}

function lastCommandReceipt(history: string[], kind: SettingKind, command = '/' + kind): string | undefined {
  const start = lastIndex(history, line => /^\s*❯(?:\s|$)/u.test(line));
  if (start < 0 || history[start].trim().replace(/^❯\s+/u, '') !== command) return;
  const body = history.slice(start + 1).filter(line => line.trim());
  if (!body.length || !/^\s*⎿\s*/u.test(body[0]) || body.slice(1).some(line => !/^\s+\S/u.test(line) || /^\s*[●⏺⎿❯>`]/u.test(line))) return;
  return body.join(' ').trim().replace(/^⎿\s*/u, '').replace(/\s+/gu, ' ');
}

/** Read the command's own output immediately above the returned composer.
 * A repeated identical receipt needs a new invocation in view. Mere redraws
 * of old history, including the status badge changing, cannot confirm a save. */
/** `command` is the exact typed line, e.g. "/model haiku" for an inline switch. */
export function readSettingReceipt(viewport: string, kind: SettingKind, previous: string[], command?: string): string | undefined {
  if (!isIdleEmptyComposer(viewport)) return;
  const history = priorComposerHistory(viewport);
  const message = lastCommandReceipt(history, kind, command);
  if (!message) return;
  const marker = '⎿ ' + message;
  const receiptCount = (rows: string[]) => rows.join(' ').replace(/\s+/gu, ' ').split(marker).length - 1;
  if (receiptCount(history) <= receiptCount(previous)) return;
  return message;
}

/** Claude labels the composer's upper border "ultracode" while Ultracode is on.
 * A named session shows its name there instead, so only a bare border proves off;
 * any other label leaves the state unknown. */
export function observeUltracode(viewport: string): boolean | undefined {
  const lines = linesOf(viewport), prompt = lastBoxedPrompt(lines);
  if (prompt < 1) return;
  const border = lines[prompt - 1];
  if (/^\s*[─━═▔╌┄-]{5,}\s*$/u.test(border)) return false;
  const label = /^\s*[─━═▔╌┄-]{5,} (\S(?:.*\S)?) [─━═▔╌┄-]+\s*$/u.exec(border)?.[1];
  return label === 'ultracode' ? true : undefined;
}
