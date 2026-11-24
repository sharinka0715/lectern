import type { CellStyle, StyledRow } from './screen-styles';

/**
 * Which rows of Claude Code's screen are its reply text, read from their look (capture-pane -e)
 * rather than their words. Claude Code lays a conversation out in blocks: each starts at column 0
 * with a marker and its further rows go on two columns in. A reply's marker is a ●/⏺ in the
 * theme's text colour, rgb(255,255,255) dark and rgb(0,0,0) light: 97 at 16 colours (tmux's
 * default "screen"), 38;5;231 and 38;5;16 at 256 (tmux-256color, or COLORTERM set; Claude Code
 * stays at 256 in tmux). The light theme at 16 colours writes its green black (30) as well, so
 * 30 confirms nothing (nor does the light-ansi theme's black). Everything else looks otherwise:
 * a tool call's bullet dim (blank in the blinking frame, but still styled), finished calls and
 * notifications green or red, notices grey, status rows (Waiting for, Message from, the
 * spinner, Worked for) another glyph. Under a reply Claude Code adds dim rows of its own (a
 * folded "Ran 2 shell commands", "Thought for 3s"), which end the reply. Rows that cannot be
 * read are no reply: the caller shows nothing rather than what may not be Claude's text (the
 * transcript follows soon).
 * Samples: tests/fixtures/preview-<version>/ (scripts/cc-matrix/probe-preview-rows.mjs).
 */
const TEXT_COLORS = new Set(['97', '38;5;231', '38;5;16', '38;2;255;255;255', '38;2;0;0;0']);
// What Claude Code dims is SGR 2 at 16 colours, its inactive grey at 256: rgb(153,153,153) dark,
// rgb(102,102,102) light.
const INACTIVE = new Set(['38;5;246', '38;5;241', '38;2;153;153;153', '38;2;102;102;102']);
const faint = (style: CellStyle | undefined) => !!style && (!!style.dim || !!style.fg && INACTIVE.has(style.fg));

const visible = (char: string | undefined) => !!char && char.trim() !== '';
const plain = (style: CellStyle | undefined) => !style || Object.keys(style).length === 0;

/** Where a row stands: blank, a block's first row (column 0 holds a marker, or the blank a
 * blinking bullet leaves, which keeps its style), or a further row two columns in. */
export function rowPlace(row: StyledRow): 'blank' | 'start' | 'inside' {
  const chars = Array.from(row.text);
  if (!chars.some(visible)) return 'blank';
  if (visible(chars[0]) || !plain(row.cells[0]) || visible(chars[1]) || !plain(row.cells[1])) return 'start';
  return 'inside';
}

/** Notification rows end in dim details: "● Monitor event: tick-1 · Tick watcher", "· 4s". */
function dimDetails(chars: string[], cells: CellStyle[]): boolean {
  let end = chars.length;
  while (end > 0 && !visible(chars[end - 1])) end--;
  if (!end || !faint(cells[end - 1])) return false;
  let start = end;
  while (start > 2 && (faint(cells[start - 1]) || !visible(chars[start - 1]))) start--;
  return chars.slice(start, end).join('').trimStart().startsWith('·');
}

/** The first row of a reply block: a plain ●/⏺ in the text colour, and not a notification. */
export function replyStart(row: StyledRow): boolean {
  const chars = Array.from(row.text);
  if (chars[0] !== '●' && chars[0] !== '⏺' || visible(chars[1])) return false;
  const { fg, ...rest } = row.cells[0] ?? {};
  return !!fg && TEXT_COLORS.has(fg) && plain(rest) && !dimDetails(chars, row.cells);
}

/** A row Claude Code dims under a reply (a folded tool group, "Thought for 3s", a ⎿ line): its
 * first character is dim and none is plain text. Reply text never is: a quote's bar is dim, its
 * words are not; code and inline code are coloured, not dim. */
export function dimmedRow(row: StyledRow): boolean {
  const chars = Array.from(row.text);
  const first = chars.findIndex(visible);
  if (first < 0 || !faint(row.cells[first])) return false;
  return !chars.some((char, i) => visible(char) && !faint(row.cells[i]) && !row.cells[i]?.fg);
}
