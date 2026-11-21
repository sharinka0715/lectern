import type { SessionStatus } from '../shared/types';
import { diagnostic, summarize } from '../diagnostics';
import { parseCacheConfirmationLines } from './model-switch-confirmation';
import { parseAutoModeNudgeLines, type AutoModeNudge } from './auto-mode-screen';
import { nativeTaskPanel } from './native-task-screen';
import { hasCurrentApiErrorBeforeRetry } from './api-error-recovery';
import { t } from '../shared/i18n';

export interface ScreenPreview {
  text: string;
  anchored: boolean;
  status: SessionStatus;
  reason?: 'empty' | 'prompt-anchor' | 'known-overlap' | 'missing-anchor-and-overlap';
}

export interface SessionScreenClassification {
  status: 'idle' | 'working' | 'waiting' | 'error' | 'unknown';
  /** A short explanation of the evidence; never a copy of a potentially sensitive error. */
  detail?: string;
}

/**
 * Claude prints transient notices right-aligned beside the editor (IDE connection,
 * "Update available", "restart to apply"). Keep only a row's left-hand content:
 * a right-aligned row on its own becomes empty, and text after a wide gap is dropped.
 */
export function withoutRightNotice(line: string): string {
  const text = line.replace(/\u00a0/g, ' ').trimEnd();
  if (!text.trim()) return '';
  const lead = text.length - text.trimStart().length;
  const gap = /\S( {3,})\S/u.exec(text);
  if (!gap) return lead >= 20 ? '' : text;
  return lead >= 20 ? '' : text.slice(0, gap.index + 1);
}

/** Terminal cells a row occupies: wide East Asian characters and emoji take two. */
export function terminalCells(text: string): number {
  let cells = 0;
  for (const char of text) {
    const c = char.codePointAt(0)!;
    cells += c >= 0x1100 && (c <= 0x115f || c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f || c >= 0xac00 && c <= 0xd7a3 ||
      c >= 0xf900 && c <= 0xfaff || c >= 0xfe30 && c <= 0xfe4f || c >= 0xff00 && c <= 0xff60 || c >= 0xffe0 && c <= 0xffe6 ||
      c >= 0x1f300 && c <= 0x1faff || c >= 0x20000 && c <= 0x3fffd) ? 2 : 1;
  }
  return cells;
}

/**
 * Claude Code prints transient notices right-aligned on their own row just above
 * the input box: "tmux focus-events off · add 'set -g focus-events on' …", "tmux
 * detected · scroll with PgUp/PgDn · …", "✔ Update installed · Restart to apply"
 * (2.1.316 to 2.1.328). Blank them: they are neither reply text nor the turn's
 * status, and they would otherwise end the reply as an indented code block.
 */
export function withoutEditorNotices(lines: string[]): string[] {
  let out: string[] | undefined;
  for (let i = 1; i < lines.length; i++) {
    if (!composerAt(lines, i)) continue;
    const width = terminalCells(lines[i].replace(/ /g, ' ').trimEnd());
    // Only the rows directly on top of the input box's border, at most two.
    for (let j = i - 1; j >= Math.max(0, i - 2); j--) {
      const row = lines[j].replace(/ /g, ' ').trimEnd();
      const lead = row.length - row.trimStart().length;
      if (!row.trim() || lead < 8 || terminalCells(row) < width - 3) break;
      (out ??= [...lines])[j] = '';
    }
  }
  return out ?? lines;
}

/** "Make auto mode your default permission mode?" at the bottom of the screen (auto-mode-screen.ts). */
export function parseAutoModeNudge(viewport: string): AutoModeNudge | undefined {
  return parseAutoModeNudgeLines(stripTerminalEscapes(viewport).split('\n'));
}

export function stripTerminalEscapes(text: string): string {
  return text
    // OSC (e.g. OSC-8 hyperlinks) ends at BEL or ST and never contains ESC. A greedy
    // payload once ran from one link to the last ST on screen, erasing the rows between.
    .replace(/\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][0-2A-Z]/g, '')
    .replace(/\r/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/** Matching only: never use this lossy representation as the displayed message. */
export function matchText(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, '').replace(/[*_`#]/g, '');
}

const prompt = /^\s*[❯>]\s?(.*)$/u;
const bullet = /^\s*[⏺●]\s?(.*)$/u;
// The editor's upper border carries the session name when one is set ("──── discuss umi ─").
export const editorRule = /^\s*[─━═╌┄-]{5,}(?: \S(?:.*\S)? [─━═╌┄-]+)?\s*$/u;
const rule = editorRule;
const tool = /^(?:Bash|PowerShell|Read|Write|Edit|MultiEdit|Glob|Grep|Task|Agent|Workflow|Monitor|TaskOutput|TaskStop|KillShell|SendMessage|WebFetch|WebSearch|TodoWrite|NotebookEdit|Skill|ToolSearch|AskUserQuestion|EnterPlanMode|ExitPlanMode|mcp__[\w-]+)\s*\(/;
const activity = /^\s*[✶✻✽✢✳✺·*]\s+.+(?:…|\.\.\.|\(.*(?:token|esc|s|m)\b)/iu;
// The native input box: a box-drawing rule (optionally titled with the session
// name) directly above the ❯ prompt row. Only this pair ends an open code block.
const composerRule = /^\s*[─━]{8,}(?: \S(?:.*\S)? [─━]+)?\s*$/u;
const composerAt = (lines: string[], index: number) => composerRule.test(lines[index]) && /^\s*❯/u.test(lines[index + 1] ?? '');
const footer = /^\s*(?:\? for shortcuts|(?:shift\+tab|ctrl\+[a-z]|esc) (?:to|for)|(?:bypass permissions|accept edits|plan mode) (?:on|off)|[↓↑]\s*\d|Context left until auto-compact|\d+% of context)/iu;

/** Native grouped tool headings differ from their JSONL tool names. Require
 * adjacent tool structure; the same words in assistant prose are not enough. */
function groupedToolHeading(lines: string[], index: number): boolean {
  const line = lines[index];
  const marked = bullet.exec(line);
  const heading = (marked?.[1] ?? line).trim();
  // Only the immediate next block (with at most two blank rows) is evidence.
  const next = lines.slice(index + 1, index + 4).find(value => value.trim());
  if (!next) return false;
  const detail = /^\s*⎿\s*(.*)$/u.exec(next)?.[1]?.trim();
  if (/^Update\(.+\)$/.test(heading)) {
    return !!detail && /^(?:Added \d+ lines?(?:, removed \d+ lines?)?|Removed \d+ lines?(?:, added \d+ lines?)?)$/.test(detail);
  }
  const reading = /^Reading (.+)$/.exec(heading);
  if (reading) return detail === reading[1];
  if (/^Running [1-9]\d* shell commands?(?:…|\.{3})$/.test(heading)) {
    if (detail?.startsWith('$ ')) return true;
    // Before the command body arrives Claude renders an unmarked, indented
    // activity row immediately above its spinner. A normal assistant bullet
    // with the same sentence does not establish that structure.
    return !marked && /^ {2,}\S/.test(line) && activity.test(next);
  }
  if (!marked && /^ {2,}Ran [1-9]\d* shell commands?(?: · [1-9]\d* failed)?\s*$/.test(line)) {
    const following = bullet.exec(next);
    return !!following && tool.test(following[1]);
  }
  return false;
}

/** Claude Code's status line right above the input box, never part of a reply:
 * a finished turn ("✻ Cooked for 9s · done 17:55", "* Baked for 1m 41s · done
 * 3:37 PM · 1 shell still running") or a wait for background work ("✻ Waiting
 * for 1 dynamic workflow to finish"). */
const statusAboveEditor = /^\s*[✶✻✽✢✳✺·*]\s+(?:[A-Za-z][A-Za-z -]* for \d+(?:\.\d+)?(?:ms|s|m|h)(?: \d+(?:\.\d+)?(?:ms|s|m))*(?: · done \d{1,2}:\d{2}(?:\s?[AaPp][Mm])?)?(?: · [^·]+)*|Waiting for \d+ [a-z][a-z -]* to finish)\s*$/u;
function completedActivityFooter(lines: string[], index: number): boolean {
  if (!statusAboveEditor.test(lines[index])) return false;
  // Only blank rows may separate them: 2.1.329 keeps the input box at the bottom of the pane.
  const next = lines.slice(index + 1).findIndex(value => !!value.trim());
  const ruleIndex = index + 1 + next;
  // The input box below may hold a draft.
  return next >= 0 && rule.test(lines[ruleIndex]) && /^\s*[❯>](?:\s|$)/u.test(lines[ruleIndex + 1] ?? '');
}

function terminalLines(screen: string): string[] {
  const lines = stripTerminalEscapes(screen).split('\n');
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  return withoutEditorNotices(withoutTaskRows(lines));
}

// Claude Code 2.1.329 lists background work below the input box's footer: a
// workflow ("◯ name  ▱▱▱  0/4 · 11s"), the main thread and its subagents
// ("⏺ main", "◯ general-purpose  description  2s"). They belong to neither the
// editor nor its footer, and there can be many of them.
const taskRow = /^ {2,}[◯○◌◉◎●⏺✓✔✗✘] \S/u;
/** The screen without the task rows below the editor (only right below its rule and footer). */
export function withoutTaskRows(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && (!lines[end - 1].trim() || taskRow.test(lines[end - 1]))) end--;
  if (end === lines.length || !lines.slice(end, lines.length).some(line => taskRow.test(line))) return lines;
  return lines.slice(Math.max(0, end - 4), end).some(line => /^\s*[─━]{8,}/u.test(line)) ? lines.slice(0, end) : lines;
}

/** Exclude assistant prose/code and tool output from native status evidence. */
function nativeEvidence(lines: string[]): boolean[] {
  let owner: 'assistant' | 'tool' | undefined;
  let fence = false;
  return lines.map((line, index) => {
    if (/^\s*```/.test(line)) { fence = !fence; return false; }
    if (fence) return false;
    if (groupedToolHeading(lines, index)) { owner = 'tool'; return false; }
    const response = bullet.exec(line);
    if (response) { owner = tool.test(response[1]) ? 'tool' : 'assistant'; return false; }
    if (prompt.test(line) || rule.test(line) || activity.test(line)) owner = undefined;
    if (/^\s*⎿/.test(line)) {
      if (owner === 'tool') return false;
      // Claude also uses this glyph for native API failures outside tool output.
      owner = undefined;
    }
    return owner === undefined;
  });
}

function classifyLines(allLines: string[]): SessionScreenClassification {
  const cache = parseCacheConfirmationLines(allLines);
  if (cache) return { status: 'waiting', detail: cache.kind === 'model' ? t('core.waitingModelCache') : t('core.waitingEffortCache') };
  if (parseAutoModeNudgeLines(allLines)) return { status: 'waiting', detail: t('core.waitingAutoModeNudge') };
  const lines = allLines.slice(-64);
  const native = nativeEvidence(allLines).slice(-64);
  const has = (last: number, matcher: RegExp) => lines.some((line, index) => index >= lines.length - last && native[index] && matcher.test(line));
  const theme = has(64, /^\s*Choose the text style that looks best with your terminal\.?\s*$/)
    && has(64, /^\s*❯\s*(?:✔\s*)?(?:\d+\.\s*)?(?:Auto|Dark|Light)\b/);
  if (theme) return { status: 'waiting', detail: t('core.waitingTheme') };
  if (has(30, /^\s*WARNING: Claude Code running in Bypass Permissions mode\s*$/) &&
    has(7, /^\s*(?:❯\s*)?No, exit\s*$/u) && has(7, /^\s*(?:❯\s*)?Yes, I accept\s*$/u) &&
    has(2, /^\s*Enter to confirm\s*·\s*Esc to cancel\s*$/)) {
    return { status: 'waiting', detail: t('core.waitingBypass') };
  }
  if (has(10, /^\s*Press Enter to continue(?:…|\.{3})?\s*$/i)) return { status: 'waiting', detail: t('core.waitingStartupNotice') };
  if (has(10, /^\s*Enter to continue\s*[·•]\s*Esc to cancel\s*$/)) return { status: 'waiting', detail: t('core.waitingTerminalNotice') };
  const trustSelector = has(64, /^\s*Quick safety check: Is this a project you created or one you trust\?/i)
    && has(28, /^\s*(?:❯\s*)?(?:\d+\.\s*)?Yes, I trust this (?:folder|directory)\s*$/i)
    && has(28, /^\s*(?:❯\s*)?(?:\d+\.\s*)?No, (?:exit|continue without these permissions)\s*$/i)
    && has(28, /^\s*❯\s*(?:\d+\.\s*)?(?:No, (?:exit|continue without these permissions)|Yes, I trust this (?:folder|directory))\s*$/i)
    && has(10, /^\s*Enter to confirm\s*[·•]\s*Esc to cancel\s*$/i);
  if (trustSelector) return { status: 'waiting', detail: t('core.waitingTrust') };
  if (has(28, /^\s*❯\s*(?:\d+\.\s*)?Yes, I trust this (?:folder|directory)\s*$/i)) return { status: 'waiting', detail: t('core.waitingTrust') };
  if (has(28, /^\s*(?:Do you (?:want to (?:proceed|allow)|trust)|Allow (?:this|Claude)|Permission required|(?:❯\s*)?1\. Yes\b)/i)) return { status: 'waiting', detail: t('core.waitingConfirmation') };
  if (has(14, activity) || has(14, /^\s*(?:esc|Esc) to interrupt\s*$/)) return { status: 'working', detail: t('core.generating') };

  // Native Claude can render API failures with the same bullet as assistant
  // prose. Its exact boxed retry placeholder provides independent evidence;
  // the error phrase alone must not turn explanations or code samples red.
  const retry = lines.findIndex((line, index) => index >= lines.length - 10 && native[index]
    && /^\s*❯\s+Once fixed, resend your message\s*$/.test(line)
    && index > 0 && rule.test(lines[index - 1]) && index + 1 < lines.length && rule.test(lines[index + 1]));
  if (retry >= 0 && hasCurrentApiErrorBeforeRetry(lines, retry, native)) {
    return { status: 'error', detail: t('core.apiError') };
  }

  // Restrict error evidence to this turn and a small footer region. Generic
  // "Error", stack traces, failed tools and quoted API examples are not enough.
  let lastInput = -1;
  for (let index = 0; index < lines.length; index++) {
    const input = prompt.exec(lines[index]);
    if (input?.[1]?.trim() && native[index]) lastInput = index;
  }
  for (let index = Math.max(lastInput + 1, lines.length - 20); index < lines.length; index++) {
    if (!native[index]) continue;
    const text = lines[index].replace(/^\s*⎿\s*/, '').trim();
    if (/^API Error:\s*[45]\d\d\b/i.test(text)) return { status: 'error', detail: t('core.apiError') };
    if (/^(?:Not logged in|Invalid API key|Authentication (?:failed|required))\b.*(?:\/login|Please (?:log|sign) in)/i.test(text)) return { status: 'error', detail: t('core.loginNeeded') };
  }
  if (has(10, /^\s*[❯>]\s*$/)) return { status: 'idle', detail: t('core.waitingMessage') };
  if (lines.some((line, index) => index >= lines.length - 10 && native[index]
    && /^\s*❯\s+Try ["“].+["”]\s*$/.test(line)
    && index > 0 && rule.test(lines[index - 1]) && index + 1 < lines.length && rule.test(lines[index + 1]))) {
    return { status: 'idle', detail: t('core.waitingMessage') };
  }
  return { status: 'unknown', detail: lines.length ? t('core.noStatusMarker') : t('core.noScreenYet') };
}

/** Conservative classifier for sidebar rows: unfamiliar layouts stay unknown. */
export function classifySessionScreen(screen: string): SessionScreenClassification {
  return classifyLines(terminalLines(screen));
}

function screenStatus(lines: string[]): SessionStatus {
  const classification = classifyLines(lines);
  // Preserve the chat's existing compatibility fallback; actual optimistic
  // turns/previews still keep MessageDisplay working while disk catches up.
  return classification.status === 'unknown' ? 'idle' : classification.status;
}

/**
 * Claude's TUI is not a structured protocol. Require a current prompt anchor, or
 * a text overlap with an already known answer, before accepting its screen text.
 * capture-pane -J should be used upstream to join physical terminal wrapping.
 */
export function extractPreview(screen: string, userText: string, knownAnswer = '', statusScreen?: string): ScreenPreview {
  const lines = terminalLines(screen);
  // tmux captures the entire pane height, including empty rows below the TUI.
  // Status detection must inspect the visible footer, not those padding rows.
  const status = screenStatus(statusScreen === undefined ? lines : terminalLines(statusScreen));
  const expected = matchText(userText);
  let anchor = -1;
  let anchorEnd = -1;
  if (expected) {
    for (let index = 0; index < lines.length; index++) {
      const found = prompt.exec(lines[index]);
      if (!found?.[1]?.trim()) continue;
      let candidate = matchText(found[1]);
      let end = index;
      // A multiline pasted prompt can occupy several hard lines.
      while (candidate.length < expected.length && end + 1 < lines.length && !bullet.test(lines[end + 1]) && !prompt.test(lines[end + 1]) && !rule.test(lines[end + 1])) {
        candidate += matchText(lines[++end]);
      }
      if (candidate === expected || (candidate.startsWith(expected) && candidate.length - expected.length < 4)) {
        anchor = index;
        anchorEnd = end;
      }
    }
  }

  const output: string[] = [];
  const taskPanelStart = nativeTaskPanel(lines)?.start;
  let inText = false;
  let suppress = false;
  let inFence = false;
  for (let index = anchor >= 0 ? anchorEnd + 1 : 0; index < lines.length; index++) {
    if (index === taskPanelStart) break;
    const line = lines[index];
    if (inFence && composerAt(lines, index)) {
      // A code block is still streaming: its closing fence has not been drawn
      // yet, and the spinner and input box below it are not part of the reply.
      while (output.length && (!output.at(-1)!.trim() || activity.test(output.at(-1)!))) output.pop();
      break;
    }
    if (inText && /^\s*```/.test(line)) {
      inFence = !inFence;
      output.push(line.replace(/^ {2}/, ''));
      continue;
    }
    if (inFence) { output.push(line.replace(/^ {2}/, '')); continue; }
    if (groupedToolHeading(lines, index)) {
      suppress = true;
      inText = false;
      continue;
    }
    if (completedActivityFooter(lines, index)) { inText = false; continue; }
    if (prompt.test(line) || rule.test(line)) {
      // A later submitted prompt (including a local slash command) belongs to
      // another terminal interaction even when this turn has no answer yet.
      if (output.length || (anchor >= 0 && prompt.exec(line)?.[1]?.trim())) break;
      continue;
    }
    if (activity.test(line) || footer.test(line)) {
      inText = false;
      continue;
    }
    if (/^\s*⎿/u.test(line)) {
      suppress = true;
      inText = false;
      continue;
    }
    const start = bullet.exec(line);
    if (start) {
      suppress = tool.test(start[1]);
      inText = !suppress;
      if (inText) {
        if (output.length && output.at(-1)?.trim()) output.push('');
        output.push(start[1]);
      }
      continue;
    }
    if (inText && !suppress) output.push(line.replace(/^ {2}/, ''));
  }
  const text = output.join('\n').trim();
  const anchored = anchor >= 0;
  const rejected = !anchored && !!text && !hasConfidentOverlap(knownAnswer, text);
  const reason: ScreenPreview['reason'] = rejected ? 'missing-anchor-and-overlap' : !text ? 'empty' : anchored ? 'prompt-anchor' : 'known-overlap';
  diagnostic.event('screen.extract', { screen: summarize(screen), user: summarize(userText), known: summarize(knownAnswer),
    candidate: summarize(text), lines: lines.length, anchored, anchor, anchorEnd, status, reason,
    statusSource: statusScreen === undefined ? 'full-capture-legacy' : 'viewport', viewport: statusScreen === undefined ? undefined : summarize(statusScreen),
    thresholds: { containedOverlap: 8, suffixOverlap: 12, footerLines: 28 } });
  if (rejected) return { text: '', anchored: false, status, reason };
  return { text, anchored, status, reason };
}

/** Character offsets map normalized matches back onto the original string. */
function indexText(text: string): { value: string; ends: number[] } {
  let value = '';
  const ends: number[] = [];
  let offset = 0;
  for (const char of text) {
    offset += char.length;
    if (/\s|[*_`#]/u.test(char)) continue;
    value += char;
    for (let i = 0; i < char.length; i++) ends.push(offset);
  }
  return { value, ends };
}

export function hasConfidentOverlap(left: string, right: string): boolean {
  const a = matchText(left);
  const b = matchText(right);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) >= 8;
  return suffixPrefixLength(a, b) >= 12;
}

/** KMP overlap keeps long scrollback reconciliation linear rather than quadratic. */
function suffixPrefixLength(text: string, pattern: string): number {
  if (!text || !pattern) return 0;
  const prefix = new Uint32Array(pattern.length);
  for (let index = 1, size = 0; index < pattern.length; index++) {
    while (size > 0 && pattern[index] !== pattern[size]) size = prefix[size - 1];
    if (pattern[index] === pattern[size]) size++;
    prefix[index] = size;
  }
  let matched = 0;
  for (let index = Math.max(0, text.length - pattern.length); index < text.length; index++) {
    while (matched > 0 && text[index] !== pattern[matched]) matched = prefix[matched - 1];
    if (text[index] === pattern[matched]) matched++;
    if (matched === pattern.length && index < text.length - 1) matched = prefix[matched - 1];
  }
  return matched;
}

function appendAlignedSuffix(canonical: string, preview: string, offset: number): string {
  let suffix = preview.slice(offset);
  const tail = /[\s*_`#]*$/.exec(canonical)?.[0] ?? '';
  // The normalized index ends at the last visible character. Do not duplicate
  // already-present closing Markdown markers or whitespace at that boundary.
  let shared = 0;
  while (shared < tail.length && shared < suffix.length && tail[shared] === suffix[shared]) shared++;
  suffix = suffix.slice(shared);
  return canonical + suffix;
}

/** Keep canonical text byte-for-byte; append only a confidently aligned preview suffix. */
export function alignPreview(canonical: string, preview: string): string {
  if (!canonical) return preview;
  if (!preview) return canonical;
  const a = indexText(canonical);
  const b = indexText(preview);
  if (!a.value || !b.value || a.value.includes(b.value)) return canonical;
  if (b.value.startsWith(a.value)) return appendAlignedSuffix(canonical, preview, b.ends[a.value.length - 1]);
  const overlap = suffixPrefixLength(a.value, b.value);
  if (overlap >= 12) return appendAlignedSuffix(canonical, preview, b.ends[overlap - 1]);
  return canonical;
}
