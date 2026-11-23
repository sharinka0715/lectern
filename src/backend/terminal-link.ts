import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { TerminalFrame, TerminalInput, TerminalKey } from '../shared/types';
import { diagnostic } from '../diagnostics';
import { t } from '../shared/i18n';
import { hangUp } from './hang-up';

/**
 * One persistent shell on the target for a terminal takeover. Each key becomes one
 * line on its stdin and is sent to tmux immediately, without waiting for the previous
 * key or opening a new SSH command; screen captures come back on the same channel.
 * Every line re-checks that the pane still runs the process that was verified when
 * control was taken, and the channel ends at the first mismatch.
 */
export interface TerminalLink {
  send(input: TerminalInput): void;
  /** Capture soon; captures never overlap. */
  refresh(): void;
  close(): void;
  readonly closed: boolean;
}

export interface LinkCommands {
  /** Quoted tmux command prefixes for this pane and server. */
  sendKeys: string; loadBuffer: string; pasteBuffer: string; capture: string; identity: string;
  /** Expected `#{pane_pid}:#{pane_dead}`. */
  expected: string;
}

const tmuxKey = (key: TerminalKey) => key === 'Backspace' ? 'BSpace' : key === 'Delete' ? 'DC' : key;

/** The loop runs under `set -f`; K lines carry only validated key names or hex bytes. */
export function linkScript(c: LinkCommands): string {
  const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return `set -f
check() { [ "$(${c.identity} 2>/dev/null)" = ${q(c.expected)} ]; }
check || { printf 'E pane\\n'; exit 0; }
printf 'R\\n'
while IFS= read -r line; do
 case "$line" in
  ('K '*) if check; then ${c.sendKeys} \${line#K } 2>/dev/null || printf 'E keys\\n'; else printf 'E pane\\n'; exit 0; fi;;
  ('P '*) if check; then printf '%s' "\${line#P }" | base64 -d | ${c.loadBuffer} && ${c.pasteBuffer} || printf 'E paste\\n'; else printf 'E pane\\n'; exit 0; fi;;
  (F) printf 'F '; { ${c.capture}; } 2>/dev/null | head -c 262144 | base64 | tr -d '\\n'; printf '\\n';;
  (Q) exit 0;;
 esac
done`;
}

/** One stdin line per input. Text is pasted, literal typing goes as hex bytes. */
export function linkLine(input: TerminalInput): string {
  if (input.type === 'key') return `K ${tmuxKey(input.key)}\n`;
  if (input.type === 'literal') return `K -H ${[...Buffer.from(input.text, 'utf8')].map(byte => byte.toString(16).padStart(2, '0')).join(' ')}\n`;
  return `P ${Buffer.from(input.text, 'utf8').toString('base64')}\n`;
}

export function parseLinkFrame(paneId: string, encoded: string): Omit<TerminalFrame, 'seq'> | undefined {
  const physical = Buffer.from(encoded, 'base64').toString('utf8');
  const dims = physical.match(/\n(\d+) (\d+) (\d+) (\d+) ([01])\n$/);
  if (!dims || dims.index === undefined) return;
  const [, cols, rows, x, y, visible] = dims.map(Number);
  if (!(cols > 0 && cols <= 1024 && rows > 0 && rows <= 512 && x <= cols && y < rows)) return;
  return { paneId, ansi: physical.slice(0, dims.index), cols, rows, cursorX: Math.min(cols - 1, x), cursorY: y, cursorVisible: !!visible };
}

export function startTerminalLink(child: ChildProcessWithoutNullStreams, paneId: string, events: {
  onFrame(frame: TerminalFrame): void;
  onClosed(reason: string): void;
}): Promise<TerminalLink> {
  let closed = false, ready = false, buffer = '', inFlight = false, wanted = false, seq = 0, last = '';
  let timer: ReturnType<typeof setTimeout> | undefined, idle: ReturnType<typeof setInterval> | undefined;
  let settle: { resolve(link: TerminalLink): void; reject(error: Error): void } | undefined;
  const write = (line: string) => { if (!closed && ready) child.stdin.write(line); };
  const capture = () => {
    if (closed || !ready) return;
    if (inFlight) { wanted = true; return; }
    inFlight = true; wanted = false;
    child.stdin.write('F\n');
  };
  const finish = (reason: string) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer); clearInterval(idle);
    // The loop exits on Q (or EOF); its session ends before the client does (see hangUp).
    try { child.stdin.end('Q\n'); } catch { /* already gone */ }
    hangUp(child);
    diagnostic.event('backend.terminal_link.closed', { paneId, reason });
    if (settle) { settle.reject(new Error(reason === 'pane' ? t('backend.terminalChangedRetake') : t('backend.terminalLinkFailed'))); settle = undefined; }
    else events.onClosed(reason);
  };
  const link: TerminalLink = {
    send(input) {
      write(linkLine(input));
      // The TUI repaints a few milliseconds after the key; look then, and once more.
      clearTimeout(timer);
      timer = setTimeout(() => { capture(); timer = setTimeout(capture, 90); }, 18);
    },
    refresh: capture,
    close: () => finish('released'),
    get closed() { return closed; },
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 1024 * 1024) { finish('overflow'); return; }
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line === 'R' && !ready) {
        ready = true;
        // While nothing is typed, keep the picture current at a modest rate.
        idle = setInterval(capture, 250);
        capture();
        settle?.resolve(link); settle = undefined;
      } else if (line.startsWith('F ')) {
        inFlight = false;
        const frame = parseLinkFrame(paneId, line.slice(2));
        const key = frame && JSON.stringify([frame.ansi, frame.cols, frame.rows, frame.cursorX, frame.cursorY, frame.cursorVisible]);
        if (frame && key !== last) { last = key!; events.onFrame({ ...frame, seq: ++seq }); }
        if (wanted) capture();
      } else if (line.startsWith('E ')) {
        const reason = line.slice(2);
        if (reason === 'pane') finish('pane');
        else diagnostic.event('backend.terminal_link.command_failed', { paneId, reason }, 'warn');
      }
    }
  });
  child.stderr.on('data', () => {});
  child.stdin.on('error', () => finish('stdin'));
  child.on('error', () => finish('spawn'));
  child.on('exit', () => finish('exited'));
  return new Promise((resolve, reject) => {
    settle = { resolve, reject };
    setTimeout(() => { if (!ready) finish('timeout'); }, 15_000);
  });
}
