import { classifySessionScreen, stripTerminalEscapes, withoutEditorNotices, withoutTaskRows } from './screen';
import { nativeTaskPanel } from './native-task-screen';
import type { RewindMenu } from '../shared/turn-controls';

const effortBadge = /^\s*[◐◉○◌●]\s+\S+\s*·\s*\/effort\s*$/u;
/** The spinner row of a running turn or /compact: a glyph, a gerund with an ellipsis and optional metrics. */
export const liveSpinner = /^[·✢✳✶✻✽✺*] +\S.*?(?:…|\.{3})(?: +\([^()]*\))?$/u;

/** The row right above the input box whose top border is `top`. Skips blank rows, the
 * effort badge, the task list, and the tip Claude Code shows under its spinner
 * ("⎿  Tip: …", wrapped onto indented rows). Notices are blanked by `withoutEditorNotices`. */
export function rowAboveEditor(lines: string[], top: number): number {
  let end = top - 1;
  const skip = () => { while (end >= 0 && (!lines[end].trim() || effortBadge.test(lines[end]))) end--; };
  skip();
  if (/^\s+[✔◼◻]\s/u.test(lines[end] ?? '')) {
    const start = nativeTaskPanel(lines)?.start;
    if (start !== undefined && lines.slice(start + 1, end + 1).every(l => !l || /^\s+[✔◼◻]\s/u.test(l))) end = start - 1;
    skip();
  }
  let tip = end;
  while (tip >= 0 && /^ {5,}\S/u.test(lines[tip])) tip--;
  if (tip >= 0 && /^ {2}⎿\s+Tip: /u.test(lines[tip])) { end = tip - 1; skip(); }
  return end;
}

// Named sessions put their title into the editor border. The menu may also
// show a tmux mouse/focus advisory in its upper rule.
const rule = /^\s*(?:[─━▔]{5,}|[─━▔]{5,} [^\n]+ [─━▔]+)\s*$/u;
const linesOf = (view: string) => stripTerminalEscapes(view).replace(/\u00a0/g, ' ').split('\n').map(line => line.trimEnd());
function lastMatch(lines: string[], test: (line: string, index: number) => boolean): number {
  for (let i = lines.length - 1; i >= 0; i--) if (test(lines[i], i)) return i;
  return -1;
}
const placeholder = /^(?:Press up to (?:edit queued messages|select a queued message(?: to edit|, then Enter to edit it))(?:, (?:or )?Enter to send them now)?|Try ["“].+["”])$/i;

/** The current boxed editor only. Ignore identical text printed above it by tools or assistants. */
export function turnComposer(view: string) {
  const lines = withoutEditorNotices(withoutTaskRows(linesOf(view)));
  let end = lines.length - 1;
  while (end >= 0 && !lines[end]) end--;
  let bottom = end;
  while (bottom >= 0 && !rule.test(lines[bottom])) bottom--;
  if (bottom < 2 || end - bottom > 5) return;
  let top = bottom - 1;
  while (top >= 0 && !rule.test(lines[top])) top--;
  const first = lines[top + 1]?.match(/^❯(?: (.*))?$/u);
  if (top < 0 || !first || bottom <= top + 1) return;
  const continuation = lines.slice(top + 2, bottom);
  if (!continuation.every(line => !line || line.startsWith('  '))) return;
  const text = [first[1] ?? '', ...continuation.map(line => line.slice(2))].join('\n');
  const footer = lines.slice(bottom + 1, end + 1).join('\n');
  // A prompt appearing below a previous editor supersedes that editor. Only
  // the slash completion for the exact draft is used when opening /rewind.
  if (/^\s*(?:[❯>]\s+(?!\/(?:rewind|fork|branch)(?:\s|$))|Permission required|Do you (?:want to|trust)|Enter to confirm)/im.test(footer)) return;
  // Slash completions occupy the footer too, but a permission picker never owns
  // this editor. Require live evidence for every in-turn submission: the interrupt
  // hint, or (Claude Code 2.1.316 has no such hint) the spinner right above the box.
  const running = /(?:^|[·\s])esc to interrupt(?:[·\s]|$)/i.test(footer) || liveSpinner.test(lines[rowAboveEditor(lines, top)] ?? '');
  const queued: string[] = [];
  if (running) {
    // 2.1.316 marks the last queued prompt with the bare "ctrl+x ctrl+s to send now".
    const marker = lastMatch(lines.slice(0,top), line => /^\s*(?:⎿\s*Queued(?:\s*·\s*.+)?|ctrl\+x ctrl\+s to send now)\s*$/iu.test(line));
    if (marker >= 0 && !lines.slice(marker + 1,top).some(line => /^[❯●⏺]/u.test(line))) {
      let i = marker - 1;
      while (i >= 0) {
        while (i >= 0 && !lines[i]) i--;
        let start = i;
        while (start >= 0 && lines[start].startsWith('  ') && !/^\s*[⎿❯●⏺]/u.test(lines[start])) start--;
        const prompt = /^❯ (.+)/u.exec(lines[start] ?? '');
        if (!prompt) break;
        queued.unshift([prompt[1], ...lines.slice(start + 1,i + 1).map(line => line.trimStart())].join('\n'));
        i = start - 1;
      }
    }
  }
  return { text, empty: !text || placeholder.test(text), running, queued, tailLines: lines.length - top };
}

export function focusedTurnCommandDescription(view: string, command: '/rewind' | '/branch' | '/fork') {
  if (turnComposer(view)?.text !== command) return;
  const lines = linesOf(view);
  const box = lines.lastIndexOf('❯ ' + command);
  if (box < 2) return;
  const row = /^\s+(?:(❯) )?(\/\S+)\s{2,}(.+)$/u;
  const upper = [], lower = [];
  for (let i = box - 2; row.test(lines[i] ?? ''); i--) upper.push(lines[i].match(row)!);
  for (let i = box + 2; row.test(lines[i] ?? ''); i++) lower.push(lines[i].match(row)!);
  const focused = [...upper, ...lower].filter(match => match[1]);
  if (upper.length && lower.length || focused.length !== 1 || focused[0][2] !== command) return;
  return focused[0][3];
}

/** 中断只需要确认当前回合正在运行。排队或粘贴才需要空输入框。 */
export function canInterruptTurn(viewport: string, nativeStatus?: string, editor = turnComposer(viewport)): boolean {
  if (!viewport.trim() || nativeStatus === 'waiting' || nativeStatus === 'shell') return false;
  const status = classifySessionScreen(viewport).status;
  if (status === 'waiting' || status === 'error') return false;
  if (!editor) {
    const footer = stripTerminalEscapes(viewport).trimEnd().split('\n').at(-1) ?? '';
    if (/\b(?:esc to cancel|enter to (?:confirm|continue|select))\b/i.test(footer) || readRewind(viewport)) return false;
  }
  // Claude Code stays busy after its reply while background subagents or
  // workflows run; the empty prompt is back then and there is no turn to stop.
  return (nativeStatus === 'busy' && status !== 'idle') || status === 'working' || !!editor?.running;
}

// Guard all active menu bytes, not unrelated history animations above its rule.
// tmux capture-pane always ends with a newline, which is not a separate row.
export function rewindGuardLines(view: string) {
  if (!readRewind(view)) return;
  const lines = linesOf(view);
  const start = lastMatch(lines, (line, i) => line.trim() === 'Rewind' && i > 0 && rule.test(lines[i-1]));
  return start < 0 ? undefined : lines.length - start - 1;
}

export function readRewind(view: string): RewindMenu | undefined {
  const lines = linesOf(view);
  const title = lastMatch(lines, (line, i) => line.trim() === 'Rewind' && i > 0 && rule.test(lines[i-1]));
  if (title < 0) return;
  const body = lines.slice(title + 1).join('\n').trim();
  const blocks = body.split(/\n\s*\n/u);
  let rows: RewindMenu['rows'] = [], focused = -1, stage: RewindMenu['stage'], message: string | undefined;
  let before = 0, after = 0;
  if (/^Restore the (?:code and\/or )?conversation to the point before…$/u.test(blocks[0]) && blocks.at(-1)?.trim() === 'Enter to continue · Esc to cancel') {
    stage = 'checkpoint';
    const entries = blocks.slice(1,-1).join('\n\n').split('\n');
    const overflow = (line: string, arrow: string) => new RegExp(`^\\s+${arrow} ([1-9]\\d{0,6}) more$`, 'u').exec(line)?.[1];
    const up = overflow(entries[0] ?? '', '↑');
    if (up) { before = Number(up); entries.shift(); }
    const down = overflow(entries.at(-1) ?? '', '↓');
    if (down) { after = Number(down); entries.pop(); }
    for (const block of entries.join('\n').trimEnd().split(/\n\s*\n/u)) {
      const [head, ...detail] = block.split('\n');
      const indent = lines[title].length - lines[title].trimStart().length;
      if (!head.startsWith(' '.repeat(indent))) return;
      const match = /^(?:(❯) |  )(.+)$/u.exec(head.slice(indent));
      if (!match) return;
      if (match[1]) { if (focused >= 0) return; focused = rows.length; }
      rows.push({ label: match[2].trim(), detail: detail.map(line => line.trim()).join(' ') || undefined });
    }
  } else if (/^Restore (?:the conversation )?to the point before you sent this message:$/.test(blocks[0])) {
    stage = 'confirm';
    const quote = blocks[1]?.split('\n').map(line => /^\s*│ ?(.*)$/u.exec(line)?.[1]);
    if (!quote?.length || quote.some(line => line === undefined)) return;
    message = quote.filter(line => !/^\(.+ ago\)$/.test(line!)).join('\n').trim();
    const choices = blocks.at(-1)?.trimEnd().split('\n') || [];
    for (const line of choices) {
      const item = /^\s*(❯\s+)?(\d+)\. (Restore (?:conversation|code|code and conversation|conversation and code)|Summarize (?:from here|up to here)|Never mind)$/u.exec(line);
      if (!item || Number(item[2]) !== rows.length + 1) return;
      if (item[1]) { if (focused >= 0) return; focused = rows.length; }
      rows.push({ label: item[3] });
    }
    if (!rows.some(row => row.label === 'Restore conversation') || rows.at(-1)?.label !== 'Never mind') return;
  } else return;
  if (focused < 0 || !rows.length) return;
  return { stage, rows, focused, message, before, after, signature: JSON.stringify([stage, rows, focused, message, before, after]) };
}
