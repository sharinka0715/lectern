import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DiagnosticsInfo } from '../shared/types';

type Context = Record<string, string | number | undefined>;
type Level = 'debug' | 'info' | 'warn' | 'error';
interface Options { directory: string; captureContent?: boolean; maxFileBytes?: number; maxFiles?: number }
interface Entry { schemaVersion: 1; runId: string; seq: number; timestamp: string; level: Level; event: string; context: Record<string, unknown>; data: Record<string, unknown> }
const context = new AsyncLocalStorage<Context>();
const DEFAULT_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_FILES = 10;
const CAPTURE_LIMIT = 2 * 1024 * 1024;
const QUEUE_LIMIT = 16 * 1024 * 1024;
const SENSITIVE_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|oauth[-_]?token|token|credentials?|private[-_]?key)$/i;

/** Heuristic redaction; logs can still contain sensitive project/conversation text. */
export function redactText(text: string): string {
  return text
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/\bsk-(?:ant-[A-Za-z0-9_-]+|[A-Za-z0-9_-]{12,})/g, '[REDACTED TOKEN]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/(["']?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|oauth[-_]?token|password|passwd|secret|authorization|private[-_]?key)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, '$1"[REDACTED]"');
}

export function summarize(content: Buffer | string): { bytes: number; sha256: string } {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export function errorDetails(error: unknown, depth = 0): Record<string, unknown> {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { name: error.name, message: redactText(error.message).slice(0, 8192), stack: error.stack ? redactText(error.stack).slice(0, 16384) : undefined, code, cause: error.cause !== undefined && depth < 3 ? errorDetails(error.cause, depth + 1) : undefined };
  }
  return { message: redactText(String(error)).slice(0, 8192) };
}

function sanitize(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === 'string') return redactText(value).slice(0, 32768);
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return String(value).slice(0, 256);
  if (Buffer.isBuffer(value)) return { ...summarize(value), omitted: 'Use diagnostic.capture for raw bytes' };
  if (value instanceof Error) return errorDetails(value);
  if (depth > 6) return '[DEPTH LIMIT]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) {
    const array = value.slice(0, 100).map(v => sanitize(v, seen, depth + 1));
    if (value.length > 100) array.push({ truncated: true, omittedItems: value.length - 100 });
    return array;
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, 100)) output[key.slice(0, 120)] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitize(child, seen, depth + 1);
  return output;
}

class Sink {
  readonly runId = randomUUID();
  readonly directory: string;
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  captureContent: boolean;
  enabled = true;
  droppedEvents = 0;
  lastError?: string;
  private sequence = 0;
  private queue: string[] = [];
  private queuedBytes = 0;
  private pendingDrops = 0;
  private pumping?: Promise<void>;
  private initialized = false;
  private failed = false;
  private currentBytes = 0;
  constructor(options: Options, private readonly predecessor: Promise<void>) {
    this.directory = path.resolve(options.directory);
    this.captureContent = options.captureContent ?? false;
    this.maxFileBytes = Math.max(512, Math.floor(Number.isFinite(options.maxFileBytes) ? options.maxFileBytes! : DEFAULT_FILE_BYTES));
    this.maxFiles = Math.max(1, Math.min(100, Math.floor(Number.isFinite(options.maxFiles) ? options.maxFiles! : DEFAULT_FILES)));
  }
  info(): DiagnosticsInfo { return { enabled: this.enabled, captureContent: this.captureContent, directory: this.directory, runId: this.runId, maxFileBytes: this.maxFileBytes, maxFiles: this.maxFiles, droppedEvents: this.droppedEvents, lastError: this.lastError }; }
  private filename(index: number): string { return path.join(this.directory, `events.${String(index).padStart(3, '0')}.jsonl`); }
  private entry(event: string, data: Record<string, unknown>, level: Level): Entry {
    return { schemaVersion: 1, runId: this.runId, seq: ++this.sequence, timestamp: new Date().toISOString(), level, event: event.slice(0, 160), context: sanitize(context.getStore() ?? {}) as Record<string, unknown>, data };
  }
  private serialize(entry: Entry): string {
    let line = JSON.stringify(entry) + '\n';
    if (Buffer.byteLength(line) <= this.maxFileBytes) return line;
    const originalBytes = Buffer.byteLength(line);
    if (typeof entry.data.content === 'string') {
      const content = entry.data.content;
      entry.data.content = ''; entry.data.truncated = true;
      const available = Math.max(0, this.maxFileBytes - Buffer.byteLength(JSON.stringify(entry)) - 128);
      entry.data.content = entry.data.encoding === 'base64' ? content.slice(0, Math.floor(available / 4) * 4) : Buffer.from(content).subarray(0, Math.floor(available / 6)).toString('utf8');
      entry.data.capturedBytes = entry.data.encoding === 'base64' ? Buffer.from(String(entry.data.content), 'base64').length : Buffer.byteLength(String(entry.data.content));
      line = JSON.stringify(entry) + '\n';
    }
    if (Buffer.byteLength(line) > this.maxFileBytes) {
      entry.context = {};
      entry.data = { truncated: true, originalBytes, reason: 'event_size_limit' };
      line = JSON.stringify(entry) + '\n';
    }
    return line;
  }
  write(event: string, data: Record<string, unknown>, level: Level = 'info', prepared = false): void {
    if (!this.enabled) return;
    try {
      if (this.failed) { this.droppedEvents++; return; }
      const entry = this.entry(event, prepared ? data : sanitize(data) as Record<string, unknown>, level);
      const line = this.serialize(entry), size = Buffer.byteLength(line);
      if (this.queuedBytes + size > QUEUE_LIMIT) { this.droppedEvents++; this.pendingDrops++; return; }
      this.queue.push(line); this.queuedBytes += size;
      this.startPump();
    } catch (error) { this.lastError = String(errorDetails(error).message); this.droppedEvents++; }
  }
  capture(kind: string, content: Buffer | string, data: Record<string, unknown>): string | undefined {
    if (!this.enabled || !this.captureContent || this.failed) return undefined;
    const captureId = randomUUID();
    const original = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const clipped = original.subarray(0, CAPTURE_LIMIT);
    // Latin-1 preserves every original byte, including incomplete UTF-8. Redaction
    // only replaces ASCII patterns; unredacted byte captures round-trip exactly.
    const binary = clipped.toString('latin1'), redactedBinary = redactText(binary);
    const redacted = redactedBinary !== binary, cleanBytes = redacted ? Buffer.from(redactedBinary, 'latin1') : clipped;
    this.write(`capture.${kind}`, {
      ...sanitize(data) as Record<string, unknown>, captureId,
      encoding: Buffer.isBuffer(content) ? 'base64' : 'utf8', content: Buffer.isBuffer(content) ? cleanBytes.toString('base64') : cleanBytes.toString('utf8'),
      ...summarize(original), capturedBytes: cleanBytes.length, redacted, truncated: original.length > CAPTURE_LIMIT,
    }, 'debug', true);
    return captureId;
  }
  private async initialize(): Promise<void> {
    await this.predecessor;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    for (const name of await readdir(this.directory)) {
      const match = /^events\.(\d+)\.jsonl$/.exec(name);
      if (match && (Number(match[1]) >= this.maxFiles || (await stat(path.join(this.directory, name))).size > this.maxFileBytes)) await rm(path.join(this.directory, name), { force: true });
    }
    try { this.currentBytes = (await stat(this.filename(0))).size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.initialized = true;
  }
  private async rotate(): Promise<void> {
    await rm(this.filename(this.maxFiles - 1), { force: true });
    for (let i = this.maxFiles - 2; i >= 0; i--) {
      try { await rename(this.filename(i), this.filename(i + 1)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    this.currentBytes = 0;
  }
  private startPump(): void {
    if (this.pumping || this.failed) return;
    this.pumping = this.pump().finally(() => { this.pumping = undefined; if (this.queue.length && !this.failed) this.startPump(); });
  }
  private async pump(): Promise<void> {
    try {
      if (!this.initialized) await this.initialize();
      while (this.queue.length || this.pendingDrops) {
        if (!this.queue.length && this.pendingDrops) {
          const dropped = this.pendingDrops; this.pendingDrops = 0;
          const marker = this.serialize(this.entry('diagnostics.queue_dropped', { count: dropped, total: this.droppedEvents }, 'warn'));
          this.queue.push(marker); this.queuedBytes += Buffer.byteLength(marker);
        }
        const line = this.queue.shift()!, bytes = Buffer.byteLength(line);
        this.queuedBytes -= bytes;
        if (this.currentBytes + bytes > this.maxFileBytes) await this.rotate();
        await appendFile(this.filename(0), line, { mode: 0o600 });
        await chmod(this.filename(0), 0o600);
        this.currentBytes += bytes;
      }
    } catch (error) {
      this.lastError = String(errorDetails(error).message); this.failed = true;
      this.droppedEvents += this.queue.length + 1;
      this.queue = []; this.queuedBytes = 0; this.pendingDrops = 0;
      // A broken diagnostics directory must never crash or stall Claude sessions.
    }
  }
  async flush(): Promise<void> { while (this.pumping) await this.pumping; }
  async close(): Promise<void> { this.enabled = false; await this.flush(); }
}

let sink: Sink | undefined;
let closing: Promise<void> = Promise.resolve();
export function configureDiagnostics(options?: Options): void {
  const old = sink; sink = undefined;
  closing = old ? old.close() : closing;
  if (!options) return;
  sink = new Sink(options, closing);
  sink.write('diagnostics.started', { captureContent: sink.captureContent, maxFileBytes: sink.maxFileBytes, maxFiles: sink.maxFiles });
}
export function getDiagnosticsInfo(): DiagnosticsInfo {
  return sink?.info() ?? { enabled: false, captureContent: false, directory: '', runId: '', maxFileBytes: DEFAULT_FILE_BYTES, maxFiles: DEFAULT_FILES, droppedEvents: 0 };
}
export function setDiagnosticContent(enabled: boolean): DiagnosticsInfo {
  if (sink) { sink.captureContent = !!enabled; sink.write('diagnostics.content_changed', { captureContent: sink.captureContent }); }
  return getDiagnosticsInfo();
}
export async function flushDiagnostics(): Promise<void> { await closing; await sink?.flush(); }
export async function closeDiagnostics(): Promise<void> { await closing; await sink?.close(); }

export const diagnostic = {
  event(event: string, data: Record<string, unknown> = {}, level: Level = 'info'): void { sink?.write(event, data, level); },
  capture(kind: string, content: Buffer | string, data: Record<string, unknown> = {}): string | undefined {
    try { return sink?.capture(kind, content, data); }
    catch (error) { if (sink) { sink.lastError = String(errorDetails(error).message); sink.droppedEvents++; } return undefined; }
  },
  scope<T>(fields: Context, fn: () => T): T { return context.run({ ...context.getStore(), ...fields }, fn); },
  operation<T>(name: string, fields: Context, fn: () => Promise<T>): Promise<T> {
    const parent = context.getStore(), operationId = randomUUID();
    return context.run({ ...parent, ...fields, traceId: parent?.traceId ?? operationId, rootOperationId: parent?.rootOperationId ?? operationId, parentOperationId: parent?.operationId, operationId }, async () => {
      const start = performance.now(); diagnostic.event(`${name}.start`);
      try { const result = await fn(); diagnostic.event(`${name}.complete`, { durationMs: Math.round(performance.now() - start) }); return result; }
      catch (error) { diagnostic.event(`${name}.error`, { durationMs: Math.round(performance.now() - start), error: errorDetails(error) }, 'error'); throw error; }
    });
  },
};
