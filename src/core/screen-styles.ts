/**
 * Rows of a `tmux capture-pane -e` capture with the look of every character: the colours and
 * attributes Claude Code's renderer gave it. Text equals stripTerminalEscapes of the same row
 * (screen.ts), character for character, so a row's styles line up with its plain text.
 */
export interface CellStyle {
  /** SGR foreground as written ("97", "38;5;231", "38;2;255;255;255"); undefined is the default colour. */
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}
export interface StyledRow {
  text: string;
  /** One entry per code point of `text`. */
  cells: CellStyle[];
}

function applySgr(style: CellStyle, params: string): CellStyle {
  const next = { ...style };
  const codes = params === '' ? ['0'] : params.split(/[;:]/);
  for (let i = 0; i < codes.length; i++) {
    const code = Number(codes[i] || '0');
    if (code === 38 || code === 48) {
      // 38;5;n and 38;2;r;g;b (tmux writes them with semicolons).
      const size = codes[i + 1] === '5' ? 2 : codes[i + 1] === '2' ? 4 : 0;
      const value = codes.slice(i, i + 1 + size).join(';');
      if (code === 38) next.fg = value; else next.bg = value;
      i += size;
    } else if (code === 0) { for (const key of Object.keys(next) as (keyof CellStyle)[]) delete next[key]; }
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 22) { delete next.bold; delete next.dim; }
    else if (code === 23) delete next.italic;
    else if (code === 24) delete next.underline;
    else if (code === 27) delete next.inverse;
    else if (code >= 30 && code <= 37 || code >= 90 && code <= 97) next.fg = String(code);
    else if (code === 39) delete next.fg;
    else if (code >= 40 && code <= 47 || code >= 100 && code <= 107) next.bg = String(code);
    else if (code === 49) delete next.bg;
  }
  return next;
}

// The same escapes stripTerminalEscapes drops: OSC (hyperlinks) up to BEL or ST, CSI (SGR is
// applied, the rest dropped), charset selection; other control characters are dropped too.
const osc = /\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)/y;
const csi = /\x1b\[([0-?]*)[ -/]*([@-~])/y;
const charset = /\x1b[()][0-2A-Z]/y;
const control = /[\x00-\x08\x0b-\x1f\x7f]/;

function styledRow(line: string): StyledRow {
  let style: CellStyle = {}, text = '';
  const cells: CellStyle[] = [];
  for (let i = 0; i < line.length;) {
    if (line[i] === '\x1b') {
      let found = false;
      for (const pattern of [osc, csi, charset]) {
        pattern.lastIndex = i;
        const match = pattern.exec(line);
        if (!match) continue;
        if (pattern === csi && match[2] === 'm') style = applySgr(style, match[1]);
        i = pattern.lastIndex;
        found = true;
        break;
      }
      if (!found) i++;
      continue;
    }
    const char = String.fromCodePoint(line.codePointAt(i)!);
    i += char.length;
    if (control.test(char)) continue;
    text += char;
    cells.push(style);
  }
  return { text, cells };
}

/** The rows of a capture, styled. A capture without escapes gives rows without any style. */
export function styledRows(screen: string): StyledRow[] {
  return screen.split('\n').map(styledRow);
}

/** Whether the capture carries any colour or attribute at all (capture-pane -e of a coloured TUI). */
export const hasStyles = (screen: string) => /\x1b\[[0-9;:]*m/.test(screen);
