import { idleComposerAdvisoryRow, TMUX_FOCUS_HINT } from '../core/settings-screen';
import { taskRowsStart } from '../core/native-task-screen';
import { stripTerminalEscapes } from '../core/screen';
import { turnComposer } from '../core/turn-controls';
import { quoteShell } from './transport';

// The task rows of native-task-screen.ts (withoutTaskRows), on the target: SGR and
// no-break spaces dropped, then a blank row, a task row (glyph, space, text; not the
// effort label) or "↓ N more". C-locale awk matches the UTF-8 glyphs as byte sequences.
const taskRowAwk = `s = $0; gsub(/\\033\\[[0-9;:]*m/, "", s); gsub(/\\302\\240/, " ", s)
    if (s ~ /^[ \\t]*$/) next
    if (s ~ /^  +(◯|○|◌|◉|◎|●|⏺|✓|✔|✗|✘) [^ \\t]/ && s !~ /·[ \\t]*\\/effort[ \\t]*$/) next
    if (s ~ /^  +(↑|↓) [0-9]+ more[ \\t]*$/) next
    changed = 1`;

/**
 * Claude Code 2.1.329+ lists background agents and workflows below the input box's
 * footer, and their timers and token counts change every second. A key guarded on the
 * whole frame (or on `tail -n` from the box's upper border) was refused whenever one
 * ticked between the read and the key. This keeps the first `keep` rows of the guarded
 * window (`tailLines` from the bottom, or the whole capture) for the exact digest: every
 * row down to the footer. The rows after them must still be task rows, blank rows or
 * "↓ N more", any text; otherwise a marker row changes the digest. Their number is fixed
 * by `tail -n`; without it a changed count still moves or keeps every compared row.
 */
export function taskRowsGuard(viewport: string, tailLines?: number): { keep: number; filter: string } | undefined {
  if (!viewport.endsWith('\n')) return;
  const rows = viewport.split('\n').slice(0, -1);
  const end = taskRowsStart(rows.map(row => stripTerminalEscapes(row).replace(/\u00a0/g, ' ')));
  const keep = end - (tailLines === undefined ? 0 : Math.max(0, rows.length - tailLines));
  if (end >= rows.length || keep <= 0) return;
  return { keep, filter: ` | LC_ALL=C awk -v keep=${keep} ${quoteShell(`NR <= keep { print; next }
  { ${taskRowAwk} }
  END { if (changed) print "LECTERN_TASK_ROWS_CHANGED" }`)}` };
}

// tmux may add or remove SGR for dim text and the theme's foreground color.
const hintSgr = '\x1b\\[(0|2|3[0-7]|39|49|9[0-7]|38;5;[0-9]+|38;2;[0-9]+;[0-9]+;[0-9]+)m';

export function composerFrameGuard(viewport: string, tailLines?: number) {
  const exact = { viewport, tailLines, filter: '' };
  const row = idleComposerAdvisoryRow(viewport);
  if (row === undefined || !viewport.endsWith('\n')) return exact;
  const lines = viewport.split('\n');
  const plain = lines[row].replace(new RegExp(hintSgr, 'g'), '');
  const paddedHint = /^ {2,}([^ ].*?) *$/u.exec(plain)?.[1];
  if (!/^ *$/.test(plain) && paddedHint !== TMUX_FOCUS_HINT) return exact;
  const lineCount = lines.length - 1;
  // Include this slot even if the catalog's welcome trim started at the upper
  // border while the slot was empty. New controls here must reject the paste.
  if (tailLines !== undefined) tailLines = Math.max(tailLines, lineCount - row);
  const record = row + 1 - (tailLines === undefined ? 0 : lineCount - tailLines);
  lines[row] = '';
  const filter = ` | LC_ALL=C awk -v hint=${quoteShell(TMUX_FOCUS_HINT)} ${quoteShell(`NR == ${record} {
    s = $0; gsub(/${hintSgr}/, "", s)
    if (s ~ /^ *$/) $0 = ""
    else if (s ~ /^  /) { sub(/^ +/, "", s); sub(/ +$/, "", s); if (s == hint) $0 = "" }
  } { print }`)}`;
  return { viewport: lines.join('\n'), tailLines, filter };
}

/** Bind occupied and placeholder text to the same style without guarding
 * animations in the spinner, border or footer of a running turn. */
export function turnContentsGuard(viewport: string, tailLines?: number) {
  const editor = turnComposer(viewport);
  if (!editor?.text || !viewport.endsWith('\n')) return;
  const rows = viewport.split('\n');
  const first = editor.top + 1, last = first + editor.text.split('\n').length - 1;
  const offset = tailLines === undefined ? 0 : Math.max(0, rows.length - 1 - tailLines);
  const sg = /\x1b\[[0-9;:]*m/g;
  return {
    viewport: rows.map((row, i) => i >= first && i <= last ? row : row.replace(sg, '')).join('\n'),
    tailLines,
    filter: ` | LC_ALL=C awk -v first=${first + 1 - offset} -v last=${last + 1 - offset} ${quoteShell(
      'NR < first || NR > last { gsub(/\\033\\[[0-9;:]*m/, "") } { print }')}`,
  };
}

// Claude animates some labels with a moving bold/colour highlight: the composer's
// upper-border label (e.g. "ultracode") and the effort slider's "Ultracode on|off".
// Only the styling of those words is left out of the digest; their text, the slider
// track and pointer, every other row and all other styling stay.
const sgr = /\x1b\[[0-9;]*m/g;
const labelledRule = /^ *─+ .* ─+ *$/u;
const sliderToggle = /^ *Ultracode +(?:on|off) *$/u;
function animatedLine(line: string): string {
  const plain = line.replace(sgr, '');
  if (plain !== line && labelledRule.test(plain)) return plain;
  const track = line.lastIndexOf('─'), tail = line.slice(track + 1), text = tail.replace(sgr, '');
  return track >= 0 && text !== tail && sliderToggle.test(text) ? line.slice(0, track + 1) + text : line;
}
export function animatedLabelText(viewport: string): string {
  return viewport.split('\n').map(animatedLine).join('\n');
}
/** Same normalization on the target (C-locale awk, bytes), before hashing a capture. */
export function animatedLabelGuard(viewport: string): { viewport: string; filter: string } {
  const normalized = animatedLabelText(viewport);
  if (normalized === viewport) return { viewport, filter: '' };
  return { viewport: normalized, filter: ` | LC_ALL=C awk ${quoteShell(`{
    s = $0; gsub(/\\033\\[[0-9;]*m/, "", s)
    if (s != $0 && s ~ /^ *(─)+ .* (─)+ *$/) $0 = s
    else if (match($0, /─[^─]*$/)) {
      head = substr($0, 1, RSTART + 2); tail = substr($0, RSTART + 3); t = tail; gsub(/\\033\\[[0-9;]*m/, "", t)
      if (t != tail && t ~ /^ *Ultracode +(on|off) *$/) $0 = head t
    }
  } { print }`)}` };
}

// Claude Code's /goal indicator closes the notice row right on top of the input box
// ("◎ /goal active (12s)", alone or after other notices and " · "; goal-screen.ts). Its timer
// ticks every second for a minute and the notices in front of it are cut anew each time, so
// the whole row changes. A row ending in the indicator, directly above a rule, is compared
// as empty here and on the target (C-locale awk, one row held back to see the next).
const activeTimerPrefix = '◎ /goal active (';
const goalTimerPrefixes = new Set([activeTimerPrefix]);
// At a one-column timer width change (9s to 10s, or 59s to 1m), a partial
// overwrite leaves the new prefix and the old suffix, e.g. "acttive (9s)".
for (let i = 0; i < activeTimerPrefix.length; i++) {
  const before = activeTimerPrefix.slice(0, i), after = activeTimerPrefix.slice(i);
  goalTimerPrefixes.add(before + after[0] + after);
  if (i > 0) goalTimerPrefixes.add(before + after.slice(1)); // Keep the goal glyph.
}
const goalTimerPattern = [...goalTimerPrefixes].map(prefix => prefix.replace(/\(/g, '[(]')).join('|');
const goalRow = new RegExp(`(^ *| · )(◎ /goal (active|paused)|(${goalTimerPattern})[0-9]+[smhd][)]) *$`, 'u');
const goalPlain = (row: string) => row.replace(/\x1b\[[0-9;:]*m/g, '').replace(/ /g, ' ');
const goalRowAwk = `{ s = $0; gsub(/\\033\\[[0-9;:]*m/, "", s); gsub(/\\302\\240/, " ", s) }
  NR > 1 { if (held && s ~ /^ *─/) print ""; else print prev }
  { prev = $0; held = (s ~ /${goalRow.source}/) }
  END { if (NR) print prev }`;
/** `rows` of a capture split at '\n' (its trailing newline leaves a last empty element). */
function goalRowsBlanked(rows: string[]): string[] {
  let out: string[] | undefined;
  for (let i = 0; i + 2 < rows.length; i++) {
    if (goalRow.test(goalPlain(rows[i])) && /^ *─/u.test(goalPlain(rows[i + 1]))) (out ??= [...rows])[i] = '';
  }
  return out ?? rows;
}
/** A capture with the goal indicator's row blanked (comparing two reads of a frame). */
export function goalRowText(viewport: string): string {
  return viewport.includes('◎') ? goalRowsBlanked(viewport.split('\n')).join('\n') : viewport;
}

/**
 * What a key guard hashes: the capture piped through `filter` on the target, and the
 * same rows of the read frame here (`expected`). `frame` is the read viewport after a
 * kind-specific normalization (composerFrameGuard, effortFrameGuard), optionally cut to
 * its last `tailLines` rows; background task rows (taskRowsGuard), animated labels
 * (animatedLabelGuard) and the goal indicator's row are left out of the exact comparison.
 */
export function guardWindow(viewport: string, frame: { viewport: string; tailLines?: number; filter: string }): { filter: string; expected: string } {
  const tasks = taskRowsGuard(viewport, frame.tailLines);
  const border = animatedLabelGuard(frame.viewport);
  const rows = border.viewport.split('\n');
  const window = frame.tailLines ? rows.slice(-frame.tailLines - 1) : rows;
  const kept = tasks ? [...window.slice(0, tasks.keep), ''] : window;
  const goal = goalRowsBlanked(kept);
  return {
    filter: (frame.tailLines ? ` | tail -n ${frame.tailLines}` : '') + frame.filter + (tasks?.filter ?? '') + border.filter
      + (goal !== kept ? ` | LC_ALL=C awk ${quoteShell(goalRowAwk)}` : ''),
    expected: goal.join('\n'),
  };
}
