import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { gunzip } from 'node:zlib';

/**
 * A long-lived shell on an SSH target that runs one command at a time.
 *
 * Opening an SSH session costs a full handshake even over a multiplexed master
 * (about 300 ms through a relay), while a line on an open session costs one
 * network round trip. Each request is the exact text `exec sh -s` would read for
 * a one-off command, sent as one base64 line; the target runs it in a fresh `sh`
 * with stdin from /dev/null, exactly like the one-off path, and answers with a
 * length-framed header followed by the raw stdout and stderr bytes.
 */
export class ChannelUnavailable extends Error {
  constructor(message: string) { super(message); this.name = 'ChannelUnavailable'; }
}

export interface ChannelRunOptions { timeoutMs: number; maxBytes: number; timeoutMessage: string }
export interface ChannelResult { code: number; stdout: Buffer; stderr: string }

const compressAbove = 32 * 1024;

export function channelScript(nonce: string): string {
  if (!/^[0-9a-f]{16,64}$/.test(nonce)) throw new Error('Invalid channel nonce');
  // Per-request files: a background process that outlives its command can
  // keep writing to its own (deleted) file without corrupting the next frame,
  // and `head -c` sends exactly the size announced in the header.
  return `umask 077
lectern_dir=$(mktemp -d "\${TMPDIR:-/tmp}/lectern-channel.XXXXXX" 2>/dev/null) || { lectern_dir="\${TMPDIR:-/tmp}/lectern-channel.$$"; mkdir -m 700 "$lectern_dir" 2>/dev/null || exit 1; }
trap 'rm -rf "$lectern_dir"' EXIT
trap 'exit 129' HUP
trap 'exit 143' TERM
command -v base64 >/dev/null 2>&1 && command -v head >/dev/null 2>&1 || exit 1
lectern_gzip=; command -v gzip >/dev/null 2>&1 && lectern_gzip=1
printf '\\nLECTERN_CHANNEL_READY %s\\n' ${nonce}
while IFS= read -r lectern_line; do
 case $lectern_line in 'R '*) ;; *) exit 1;; esac
 lectern_line=\${lectern_line#R }
 lectern_id=\${lectern_line%% *}
 case $lectern_id in ''|*[!0-9]*) exit 1;; esac
 lectern_s="$lectern_dir/s$lectern_id" lectern_o="$lectern_dir/o$lectern_id" lectern_e="$lectern_dir/e$lectern_id"
 if printf '%s\\n' "\${lectern_line#* }" | base64 -d > "$lectern_s" 2> "$lectern_e"; then
  sh "$lectern_s" > "$lectern_o" 2> "$lectern_e" < /dev/null
  lectern_code=$?
 else
  lectern_code=126; : > "$lectern_o"
 fi
 lectern_out=$(wc -c < "$lectern_o") lectern_err=$(wc -c < "$lectern_e") lectern_z=0
 lectern_out=$((lectern_out)) lectern_err=$((lectern_err))
 # Large outputs (history pages, scrollback) are mostly text; links through a
 # relay are often bandwidth-bound.
 if [ -n "$lectern_gzip" ] && [ "$lectern_out" -gt ${compressAbove} ] && gzip -1 -c < "$lectern_o" > "$lectern_o.z" 2>/dev/null; then
  mv -f "$lectern_o.z" "$lectern_o"; lectern_out=$(wc -c < "$lectern_o"); lectern_out=$((lectern_out)) lectern_z=1
 fi
 printf 'LECTERN_RESULT %s %s %s %s %s\\n' "$lectern_id" "$lectern_code" "$lectern_out" "$lectern_err" "$lectern_z"
 head -c "$lectern_out" "$lectern_o"
 head -c "$lectern_err" "$lectern_e"
 rm -f "$lectern_s" "$lectern_o" "$lectern_e"
done`;
}

interface Pending {
  id: number;
  resolve(result: ChannelResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  maxBytes: number;
  header?: { code: number; out: number; err: number; compressed: boolean };
}

const headerPattern = /^LECTERN_RESULT (\d+) (\d+) (\d+) (\d+) ([01])$/;

export class CommandChannel {
  private chunks: Buffer[] = [];
  private length = 0;
  private ready = false;
  private pending?: Pending;
  private nextId = 1;
  private stderr = '';
  private closedReason?: string;
  lastUsed = Date.now();

  private constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly nonce: string,
    private readonly onClose: (channel: CommandChannel, reason: string) => void) {}

  /** Resolves once the target loop has printed its ready line. */
  static open(child: ChildProcessWithoutNullStreams, nonce: string, timeoutMs: number,
    onClose: (channel: CommandChannel, reason: string) => void = () => {}): Promise<CommandChannel> {
    const channel = new CommandChannel(child, nonce, onClose);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { channel.close('channel start timed out'); }, timeoutMs);
      channel.started = { resolve: () => { clearTimeout(timer); resolve(channel); }, reject: error => { clearTimeout(timer); reject(error); } };
      child.stdout.on('data', (chunk: Buffer) => channel.receive(chunk));
      child.stderr.on('data', (chunk: Buffer) => { if (channel.stderr.length < 8192) channel.stderr += chunk.toString('utf8'); });
      child.stdin.on('error', () => channel.close('channel input closed'));
      child.on('error', error => channel.close(error.message));
      child.on('close', code => channel.close(channel.stderr.trim() || `SSH channel exited with status ${code}`));
    });
  }
  private started?: { resolve(): void; reject(error: Error): void };

  get closed(): boolean { return this.closedReason !== undefined; }
  get busy(): boolean { return !!this.pending; }
  get usable(): boolean { return this.ready && !this.closed && !this.pending; }

  run(request: string, options: ChannelRunOptions): Promise<ChannelResult> {
    if (!this.usable) return Promise.reject(new ChannelUnavailable(this.closedReason ?? 'channel busy'));
    const id = this.nextId++;
    this.lastUsed = Date.now();
    return new Promise<ChannelResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        // The target state is unknown: drop the channel, never replay the command.
        const pending = this.pending;
        this.pending = undefined;
        this.close('command timed out');
        pending?.reject(new Error(options.timeoutMessage));
      }, options.timeoutMs);
      this.pending = { id, resolve, reject, timer, maxBytes: options.maxBytes };
      this.child.stdin.write(`R ${id} ${Buffer.from(request).toString('base64')}\n`);
    });
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    this.closedReason = reason;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error(reason)); }
    this.started?.reject(new ChannelUnavailable(reason));
    this.started = undefined;
    try { this.child.stdin.end(); } catch { /* already closed */ }
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    this.chunks = []; this.length = 0;
    this.onClose(this, reason);
  }

  private buffered(): Buffer {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks, this.length)];
    return this.chunks[0] ?? Buffer.alloc(0);
  }
  private consume(bytes: number): Buffer {
    const all = this.buffered();
    const head = all.subarray(0, bytes);
    const rest = all.subarray(bytes);
    this.chunks = rest.length ? [rest] : [];
    this.length = rest.length;
    return head;
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
    if (!this.ready) {
      // Login scripts may print before our loop starts; skip to the nonce line.
      const marker = Buffer.from(`\nLECTERN_CHANNEL_READY ${this.nonce}\n`);
      const at = this.buffered().indexOf(marker);
      if (at < 0) {
        if (this.length > 1024 * 1024) this.close('channel start produced unexpected output');
        return;
      }
      this.consume(at + marker.length);
      this.ready = true;
      const started = this.started;
      this.started = undefined;
      started?.resolve();
    }
    this.drain();
  }

  private drain(): void {
    while (!this.closed && this.length) {
      const pending = this.pending;
      if (!pending) { this.close('unexpected channel output'); return; }
      if (!pending.header) {
        const all = this.buffered();
        const lf = all.indexOf(10);
        if (lf < 0) {
          if (this.length > 256) this.close('malformed channel response');
          return;
        }
        const match = headerPattern.exec(all.subarray(0, lf).toString('latin1'));
        if (!match || Number(match[1]) !== pending.id) { this.close('malformed channel response'); return; }
        this.consume(lf + 1);
        pending.header = { code: Number(match[2]), out: Number(match[3]), err: Number(match[4]), compressed: match[5] === '1' };
      }
      const { code, out, err, compressed } = pending.header;
      if (this.length < out + err) return;
      const stdout = this.consume(out);
      const stderr = this.consume(err).toString('utf8');
      // The frame is complete: the channel can take the next request while
      // this output is decompressed off the main thread.
      this.pending = undefined;
      clearTimeout(pending.timer);
      this.lastUsed = Date.now();
      const limit = new Error('Command output exceeded safety limit');
      if (!compressed) {
        if (out > pending.maxBytes) pending.reject(limit);
        else pending.resolve({ code, stdout, stderr });
        continue;
      }
      gunzip(stdout, { maxOutputLength: pending.maxBytes }, (error, plain) => {
        if (error) pending.reject((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' ? limit : new Error(`Invalid compressed command output: ${error.message}`));
        else pending.resolve({ code, stdout: plain, stderr });
      });
    }
  }
}
