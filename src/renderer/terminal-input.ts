import type { TerminalFrame, TerminalInput, TerminalKey } from '../shared/types';
import { TERMINAL_KEYS } from '../shared/types';
import { t } from '../shared/i18n';

// xterm handles the keyboard layout, dead keys and IME. Resolve navigation
// through tmux's key table so application-cursor/keypad mode is the pane's,
// not the snapshot renderer's. Never forward arbitrary escape sequences.
const named = new Map<string, TerminalKey>([
  ['\r', 'Enter'], ['\x1b', 'Escape'], [' ', 'Space'], ['\t', 'Tab'], ['\x1b[Z', 'BTab'],
  ['\x7f', 'Backspace'], ['\x08', 'Backspace'], ['\x1b[3~', 'Delete'],
  ['\x1b[A', 'Up'], ['\x1b[B', 'Down'], ['\x1b[C', 'Right'], ['\x1b[D', 'Left'],
  ['\x1b[H', 'Home'], ['\x1b[F', 'End'], ['\x1b[5~', 'PageUp'], ['\x1b[6~', 'PageDown'],
]);
for (const key of TERMINAL_KEYS) if (key.startsWith('C-')) named.set(String.fromCharCode(key.charCodeAt(2) - 96), key);

export function typedInput(data: string): TerminalInput | undefined {
  const key = named.get(data);
  if (key) return { type: 'key', key };
  if (data.length && data.length <= 1024 && !/[\p{Cc}\p{Cs}]/u.test(data)) return { type: 'literal', text: data };
}

export interface LeasedInput { token: string; input: TerminalInput }
export function mergeTyping(a: LeasedInput, b: LeasedInput): LeasedInput | undefined {
  if (a.token === b.token && a.input.type === 'literal' && b.input.type === 'literal' && a.input.text.length + b.input.text.length <= 1024)
    return { token: a.token, input: { type: 'literal', text: a.input.text + b.input.text } };
}

/** Replay grid contents, not an untrusted terminal byte stream. Only SGR and
 * physical line breaks are interpreted; never enable clipboard, links, device
 * queries, mouse events or input modes based on text from the remote screen. */
export function paintFrame(frame: TerminalFrame): string {
  const text = frame.ansi
    .replace(/\x1b(?:\]|P|_|\^|X)[\s\S]*?(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]|[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, value => /^\x1b\[[\d;:]*m$/.test(value) ? value : '');
  return '\x1b[?7l\x1b[0m\x1b[2J\x1b[H' + text.split('\n').slice(0, frame.rows).join('\r\n') +
    `\x1b[0m\x1b[${frame.cursorY + 1};${frame.cursorX + 1}H\x1b[?25${frame.cursorVisible ? 'h' : 'l'}`;
}

/** One in-flight operation. Only adjacent unsent typing may coalesce; paste,
 * menu keys, control changes and failures are hard ordering boundaries. */
export class TerminalInputQueue<T> {
  private pending: Array<{ value: T; resolvers: Array<(value: boolean) => void> }> = [];
  private running = false;
  private disposed = false;
  private idleWaiters: Array<() => void> = [];
  constructor(
    private readonly send: (value: T) => Promise<void>,
    private readonly onChange: (count: number) => void,
    private readonly onError: (error: unknown, discarded: number) => void,
    private readonly limit = 64,
    private readonly merge?: (last: T, next: T) => T | undefined,
  ) {}
  enqueue(value: T): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    const tail = this.pending.at(-1), merged = tail && this.merge?.(tail.value, value);
    if (tail && merged !== undefined) {
      tail.value = merged;
      return new Promise(resolve => tail.resolvers.push(resolve));
    }
    if (this.pending.length + Number(this.running) >= this.limit) {
      this.onError(new Error(t('files.inputQueueFull')), this.cancelPending());
      return Promise.resolve(false);
    }
    const result = new Promise<boolean>(resolve => this.pending.push({ value, resolvers: [resolve] }));
    this.onChange(this.pending.length + Number(this.running));
    void this.pump();
    return result;
  }
  cancelPending(): number {
    const pending = this.pending.splice(0);
    pending.forEach(item => item.resolvers.forEach(resolve => resolve(false)));
    this.onChange(Number(this.running));
    return pending.length;
  }
  whenIdle(): Promise<void> {
    if (!this.running && !this.pending.length) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }
  dispose() { this.disposed = true; this.cancelPending(); }
  private async pump() {
    if (this.running || this.disposed) return;
    const next = this.pending.shift();
    if (!next) return;
    this.running = true;
    try {
      await this.send(next.value);
      next.resolvers.forEach(resolve => resolve(true));
    } catch (error) {
      next.resolvers.forEach(resolve => resolve(false));
      this.onError(error, this.cancelPending());
    } finally {
      this.running = false;
      this.onChange(this.pending.length);
      if (!this.pending.length) this.idleWaiters.splice(0).forEach(resolve => resolve());
      else void this.pump();
    }
  }
}
