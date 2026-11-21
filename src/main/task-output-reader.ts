import type { Backend } from '../backend';
import { PrivacyFolderError, type FileWindow } from '../backend/artifacts';
import type { TaskOutputRead, TaskOutputWindow } from '../backend/task-output-files';
import { activityTaskId } from '../core/session-activity';
import type { SessionActivity } from '../shared/activity';
import { t } from '../shared/i18n';
import { redirectFiles, type RedirectFile } from '../shared/shell-redirects';
import { completeUtf8, OUTPUT_APPEND_BYTES, OUTPUT_MAX_BYTES, OUTPUT_PAGE_BYTES, OUTPUT_TAIL_BYTES, outputTrailer, shownOutputSource, terminalText, windowStart, type OwnOutput } from '../shared/task-output';
import type { TaskOutput, TaskOutputRequest, TaskOutputSource, Workspace } from '../shared/types';

export type TaskOutputBackend = Pick<Backend, 'readTaskOutput' | 'artifacts'>;
type Read = TaskOutputRead | FileWindow | { found: false };
const decoder = () => new TextDecoder('utf-8');
/** Only the trailer ("[exited with code 0]") or nothing at all: the task printed nothing itself. */
const printedNothing = (own: Window) => own.found && own.start === 0 && own.bytes.length < 4096 && !outputTrailer(own.bytes.toString('utf8')).body.trim();

/** The bytes held of one source: a window [start, start + bytes.length) of its file. */
class Window {
  stamp?: string;
  identity?: string;
  start = 0;
  bytes = Buffer.alloc(0);
  found = false;
  state: TaskOutput['state'] = 'ok';
  error?: string;
  get end() { return this.start + this.bytes.length; }
  get canPageUp() { return this.found && this.start > 0 && this.bytes.length < OUTPUT_MAX_BYTES; }
  /** The next request: unchanged files send nothing, a growing one only its new bytes. */
  request(older: boolean): TaskOutputWindow {
    if (older && this.canPageUp) return { before: this.start, limit: Math.min(OUTPUT_PAGE_BYTES, OUTPUT_MAX_BYTES - this.bytes.length) };
    return this.found ? { known: this.stamp, from: this.end, limit: OUTPUT_TAIL_BYTES, appendLimit: OUTPUT_APPEND_BYTES } : { limit: OUTPUT_TAIL_BYTES };
  }
  /** Applies a read; false when the file was replaced and must be read again from its tail. */
  apply(read: Read): boolean {
    this.state = 'ok'; this.error = undefined;
    if (!('stamp' in read)) { this.found = false; this.stamp = this.identity = undefined; this.start = 0; this.bytes = Buffer.alloc(0); this.state = 'missing'; return true; }
    const identity = 'identity' in read ? read.identity : read.inode;
    if (read.unchanged) { this.found = true; return true; }
    if (read.mode === 'from' && this.found && identity !== this.identity) return false;
    if (read.mode === 'before') {
      // An older page joins the window only if it ends where the window starts (same file).
      // The stamp stays: bytes appended meanwhile are read by the next live read.
      if (this.found && identity === this.identity && read.start + read.bytes.length === this.start) {
        this.bytes = Buffer.concat([read.bytes, this.bytes]);
        this.start = read.start;
      }
      return true;
    }
    if (read.mode === 'from') this.bytes = Buffer.concat([this.bytes, read.bytes]);
    else { this.bytes = Buffer.from(read.bytes); this.start = read.start; }
    // At most OUTPUT_MAX_BYTES, the newest.
    if (this.bytes.length > OUTPUT_MAX_BYTES) {
      const excess = this.bytes.length - OUTPUT_MAX_BYTES;
      this.bytes = this.bytes.subarray(excess); this.start += excess;
    }
    this.found = true; this.stamp = read.stamp; this.identity = identity;
    return true;
  }
  /** The held bytes as text: a cut start skips its broken line, an unfinished character waits. */
  text(): { text: string; omitted: number } {
    const skip = windowStart(this.bytes, this.start > 0);
    return { text: decoder().decode(this.bytes.subarray(skip, Math.max(skip, completeUtf8(this.bytes)))), omitted: this.start + skip };
  }
  fail(state: TaskOutput['state'], error?: string) { this.state = state; this.error = error; }
}

/**
 * One background shell's or monitor's output for one pane's task column. Its own
 * output file is read on every call (only new bytes, nothing when unchanged); when
 * it printed nothing and its command wrote to a file (`> f`, `| tee f`, …), that
 * file is shown instead, read under the attachment rules (artifacts.ts readWindow).
 * Paths come from the activity in the main process, never from the renderer.
 */
export class TaskOutputReader {
  private readonly windows = new Map<string, Window>();
  private readonly explicit = new Set<string>();
  private revision = 0;
  private shown = '';
  private queue: Promise<unknown> = Promise.resolve();
  usedAt = 0;

  constructor(readonly sessionId: string, readonly toolId: string) {}

  private window(key: string) {
    let window = this.windows.get(key);
    if (!window) this.windows.set(key, window = new Window());
    return window;
  }

  read(backend: TaskOutputBackend, workspace: Workspace, item: SessionActivity, transcript: string | undefined, request: TaskOutputRequest, isCurrent: () => boolean): Promise<TaskOutput> {
    const run = this.queue.then(() => this.load(backend, workspace, item, transcript, request, isCurrent));
    this.queue = run.catch(() => {});
    return run;
  }

  private async load(backend: TaskOutputBackend, workspace: Workspace, item: SessionActivity, transcript: string | undefined, request: TaskOutputRequest, isCurrent: () => boolean): Promise<TaskOutput> {
    const files = redirectFiles(item.command, item.cwd ?? workspace.cwd);
    const own = this.window('task');
    const choice = typeof request.source === 'string' ? request.source : undefined;
    const pageUp = request.older === true;
    if (item.taskId && activityTaskId(item.taskId)) {
      await this.follow(own, isCurrent, window => backend.readTaskOutput(workspace, this.sessionId, item.taskId!, window), pageUp && (choice ?? 'task') === 'task');
    } else own.fail('missing');
    const ownState: OwnOutput = { found: own.found, empty: printedNothing(own) };
    // The transcript's copy only stands in for an output file that is gone.
    if (own.found) transcript = undefined;
    const source = shownOutputSource(choice, ownState, files, !!transcript);
    const file = source.startsWith('file:') ? files[Number(source.slice(5))] : undefined;
    if (file) {
      if (request.explicit === true) this.explicit.add(file.path);
      const window = this.window(source + ':' + file.path);
      try {
        await this.follow(window, isCurrent, request => backend.artifacts.readWindow(workspace, file.path, request, this.explicit.has(file.path)), pageUp);
      } catch (error) {
        if (!isCurrent()) throw error;
        window.fail(error instanceof PrivacyFolderError ? 'privacy' : 'error', error instanceof Error ? error.message : String(error));
      }
    }
    return this.snapshot(request.revision, item, files, source, own, transcript);
  }

  /** Reads `window`'s next bytes; a file replaced since the last read is read again from its tail. */
  private async follow(window: Window, isCurrent: () => boolean, read: (request: TaskOutputWindow) => Promise<Read>, pageUp: boolean) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await read(attempt ? { limit: OUTPUT_TAIL_BYTES } : window.request(pageUp));
      if (!isCurrent()) throw new Error(t('main.taskOutputSwitched'));
      if (attempt) window.found = false;
      if (window.apply(result)) return;
    }
  }

  private snapshot(known: number | undefined, item: SessionActivity, files: RedirectFile[], source: string, own: Window, transcript: string | undefined): TaskOutput {
    const sources: TaskOutputSource[] = [{ key: 'task', kind: 'task' },
      ...files.map((file, n): TaskOutputSource => ({ key: `file:${n}`, kind: 'file', path: file.path, stream: file.stream })),
      ...(transcript ? [{ key: 'transcript', kind: 'transcript' as const }] : [])];
    const file = source.startsWith('file:') ? files[Number(source.slice(5))] : undefined;
    const window = file ? this.window(source + ':' + file.path) : own;
    let text: string, omitted = 0;
    if (source === 'transcript') text = terminalText(transcript ?? '');
    else {
      const held = window.text();
      omitted = held.omitted;
      text = terminalText(source === 'task' ? outputTrailer(held.text).body : held.text);
    }
    // The trailer is ASCII at the very end of the file.
    const trailer = own.found ? outputTrailer(own.bytes.subarray(-64).toString('latin1')) : undefined;
    const result: TaskOutput = {
      toolId: this.toolId, revision: 0, sources, source, omitted,
      hasOlder: source !== 'transcript' && window.canPageUp,
      state: source === 'transcript' ? 'ok' : window.state,
    };
    if (window.error && source !== 'transcript') result.error = window.error;
    if (trailer?.exitCode !== undefined) result.exitCode = trailer.exitCode;
    if (trailer?.killed) result.killed = true;
    if (printedNothing(own)) result.ownEmpty = true;
    // A new revision whenever what is shown changes; the text only when the caller lacks it.
    const shown = JSON.stringify([result, text.length, text.slice(0, 256), text.slice(-256), item.status]);
    if (shown !== this.shown) { this.shown = shown; this.revision++; }
    result.revision = this.revision;
    if (known !== this.revision) result.text = text;
    return result;
  }
}
