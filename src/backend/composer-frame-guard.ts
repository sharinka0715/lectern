import { idleComposerAdvisoryRow, TMUX_FOCUS_HINT } from '../core/settings-screen';
import { quoteShell } from './transport';

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
