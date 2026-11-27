import { runStart, type ActivityKind, type ActivityState, type SessionActivity } from '../shared/activity';
import { joinList, t } from '../shared/i18n';
import type { JsonRecord } from './jsonl';
import { compactReceipt } from './turn-progress';
import { isTranscriptTurnStart } from './transcript-store';
import type { CompactReceipt } from '../shared/types';

export interface ActivityReadTarget { kind: ActivityKind; taskId: string; stamp?: string }
export interface ActivitySample { taskId: string; stamp: string; tail: string; clipped: boolean }
export const activityTaskId = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
const object = (v: unknown): JsonRecord => v && typeof v === 'object' && !Array.isArray(v) ? v as JsonRecord : {};
const TRANSCRIPT_OUTPUT = 64 * 1024;
const string = (v: unknown, max = 4096) => typeof v === 'string' && v ? v.slice(0, max) : undefined;
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const blocks = (v: unknown) => Array.isArray(v) ? v.map(object) : [];
const contentText = (v: unknown) => typeof v === 'string' ? v : blocks(v).filter(b => b.type === 'text').map(b => string(b.text)).filter(Boolean).join('\n');
const timestamp = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : undefined;
const kindFor = (name: unknown): ActivityKind | undefined =>
  name === 'Bash' || name === 'PowerShell' ? 'shell' : name === 'Monitor' ? 'monitor' : name === 'Agent' || name === 'Task' ? 'agent' : undefined;
const statusFor = (v: unknown): ActivityState | undefined =>
  v === 'completed' || v === 'failed' || v === 'running' ? v : v === 'killed' || v === 'cancelled' || v === 'stopped' ? 'stopped' : undefined;
const xmlValue = (xml: string, tag: string) => {
  const raw = new RegExp('(?:^|\\n)<' + tag + '>([\\s\\S]*?)</' + tag + '>(?=\\n|$)').exec(xml)?.[1];
  return raw?.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
};

// The re-arm advice changes across Claude Code versions, so match the shape of the notice.
const monitorExpiryNotice = /^\[Monitor (?:expired after [^\n]+? with (?:no events|\d+ events?) delivered\.|timed out\b)[^\n]*\b[Rr]e-arm\b[^\n]*\]$/;

/** A notification that says the subagent stopped while its own background work
 * still ran (Claude Code 2.1.329: status "completed", the result "may be interim").
 * It notifies again only if it goes on by itself; Claude Code marks it finished
 * (`finished` in its meta file) and no longer counts it as pending. */
const interimNotice = (summary?: string, note?: string) =>
  /\bwaiting on its own background work\b/i.test(summary ?? '') || /\bmay be interim\b/i.test(note ?? '');
const parsed = (text: string): JsonRecord => {
  if (!text.trimStart().startsWith('{')) return {};
  try { return object(JSON.parse(text)); } catch { return {}; }
};

interface Entry { item: SessionActivity; stamp?: string; settledRead?: boolean; attempts?: number;
  /** Output the transcript itself carries (a monitor's events, bash_progress, a TaskOutput
   * result): the task column's fallback when the task's output file cannot be read. */
  transcript?: string;
  /** Fingerprints of enqueued notifications whose delivery has not been seen yet. */
  notices?: string[];
  /** Its latest run ended with an interim notification: a later one replaces it. */
  waiting?: boolean }
type NoticeSource = 'enqueue' | 'remove' | 'delivery';
export class SessionActivityStore {
  private entries = new Map<string, Entry>();
  private byTask = new Map<string, Entry>();
  private controls = new Map<string, { tool: string; task?: string }>();
  /** SendMessage calls by tool_use id and the agent they address: the notification
   * that ends a resumed run names the call that resumed it, not the launch. */
  private messageCalls = new Map<string, string>();
  private readStart = 0;
  // A historical operation receipt, never a claim that the current turn compacted.
  lastCompact?: CompactReceipt;
  /** A prompt or a reply followed the latest compaction: its receipt is history, as in the TUI.
   * An automatic compaction comes after the prompt that set it off and before its reply. */
  private promptAfterCompact = false;
  /** The latest compaction while it is still the latest event of the conversation. */
  get currentCompact(): CompactReceipt | undefined { return this.promptAfterCompact ? undefined : this.lastCompact; }
  private readonly compactIds = new Set<string>();
  get compactRecords() { return this.compactIds.size; }

  constructor(private readonly sessionId: string) {}

  /** Task-file observations live outside the JSONL. Replaying earlier records
   * must retain an already sampled tail and its cursor for the same tool/task. */
  retainSamples(previous: SessionActivityStore) {
    this.readStart = previous.readStart;
    for (const [id, entry] of this.byTask) {
      const old = previous.byTask.get(id);
      if (!old || old.item.id !== entry.item.id) continue;
      // A run that is going again (resumed) is sampled again.
      if (entry.item.status !== 'running' || old.item.status === 'running') {
        entry.settledRead = old.settledRead;
        entry.attempts = old.attempts;
      }
      if (!old.stamp) continue;
      entry.stamp = old.stamp;
      entry.item.output = old.item.output ?? entry.item.output;
      entry.item.model = old.item.model ?? entry.item.model;
      if (old.item.updatedAt && (!entry.item.updatedAt || old.item.updatedAt > entry.item.updatedAt)) entry.item.updatedAt = old.item.updatedAt;
      const events = new Map([...entry.item.events, ...old.item.events].map(event => [event.key, event]));
      entry.item.events = [...events.values()].slice(-16);
    }
  }

  get active() { return [...this.entries.values()].some(e => e.item.status === 'running'); }

  /** Background agents whose run was going at `at` and has ended since. A resumed
   * agent counts from its resume, so the run before it never offsets a later turn. */
  endedAgentsSince(at?: string) {
    if (!at) return 0;
    return [...this.byTask.values()].filter(({ item }) => {
      const start = runStart(item);
      return item.kind === 'agent' && item.background && start && start <= at && item.endedAt && item.endedAt >= at;
    }).length;
  }

  snapshot(live: boolean): SessionActivity[] {
    return [...this.entries.values()].reverse().map(({ item }) =>
      !live && item.status === 'running' ? { ...item, status: 'unobserved' } : { ...item, events: [...item.events] });
  }

  // Rotate a fixed-size batch so a session with many simultaneous tasks still
  // updates every task. Read one final sample after native completion.
  targets(): ActivityReadTarget[] {
    const available = [...this.byTask.values()].filter(e => !e.settledRead);
    const live = available.filter(e => e.item.status === 'running');
    const start = live.length ? this.readStart % live.length : 0;
    const selected = [...live.slice(start), ...live.slice(0, start)].slice(0, 8);
    this.readStart = start + selected.length;
    if (selected.length < 8) selected.push(...available.filter(e => e.item.status !== 'running').reverse().slice(0, 8 - selected.length));
    for (const entry of selected) {
      if (entry.item.status !== 'running' && (entry.attempts = (entry.attempts ?? 0) + 1) >= 3) entry.settledRead = true;
    }
    return selected.map(({ item, stamp }) => ({ kind: item.kind, taskId: item.taskId!, stamp }));
  }

  ingest(records: JsonRecord[]) {
    for (const r of records) {
      if (r.isSidechain || r.sessionId !== undefined && r.sessionId !== this.sessionId) continue;
      if (r.type === 'system' && r.subtype === 'compact_boundary') {
        const receipt = compactReceipt(r);
        if (receipt && (!this.compactIds.has(receipt.id) || this.lastCompact?.id === receipt.id)) {
          if (!this.compactIds.has(receipt.id)) this.promptAfterCompact = false;
          this.compactIds.add(receipt.id);
          this.lastCompact = receipt;
        }
      } else if (this.lastCompact && !this.promptAfterCompact && (isTranscriptTurnStart(r, this.sessionId)
          && !/<command-name>\/compact<\/command-name>/u.test(JSON.stringify(object(r.message).content ?? ''))
          || r.type === 'assistant' && object(r.message).model !== '<synthetic>' && !r.isApiErrorMessage)) {
        this.promptAfterCompact = true;
      }
      const at = timestamp(r.timestamp);
      const message = object(r.message);
      if (r.type === 'queue-operation' && (r.operation === 'enqueue' || r.operation === 'remove')) {
        this.notification(contentText(r.content), at, r.operation);
      }
      if (r.type === 'user' && object(r.origin).kind === 'task-notification') this.notification(contentText(message.content), at, 'delivery');
      // Absorbed into a running turn: some versions keep only this record (with the enqueue time).
      const attached = object(r.attachment);
      if (r.type === 'attachment' && attached.type === 'queued_command' &&
          (attached.commandMode === 'task-notification' || object(attached.origin).kind === 'task-notification')) {
        this.notification(contentText(attached.prompt), timestamp(attached.timestamp) ?? at, 'delivery');
      }
      if (r.type === 'progress') {
        const data = object(r.data);
        const entry = this.entries.get(String(r.parentToolUseID)) ?? this.entries.get(String(r.toolUseID));
        if (entry && data.type === 'agent_progress' && entry.item.kind === 'agent') {
          this.bind(entry, data.agentId);
          this.agentMessage(entry.item, object(object(data.message).message), at);
        } else if (entry && data.type === 'bash_progress' && entry.item.kind === 'shell') {
          this.bind(entry, data.taskId);
          const full = typeof data.fullOutput === 'string' ? data.fullOutput : data.output;
          if (typeof full === 'string' && full.length) { entry.item.output = full.slice(-4096); this.record(entry, full, false); }
          entry.item.updatedAt = at ?? entry.item.updatedAt;
        }
      }
      if (r.type === 'assistant') for (const b of blocks(message.content)) {
        if (b.type !== 'tool_use' || typeof b.id !== 'string') continue;
        const input = object(b.input), kind = kindFor(b.name);
        if (kind && !this.entries.has(b.id)) {
          const command = string(input.command, 32768) || string(input.url) || string(object(input.ws).url);
          const item: SessionActivity = { id: b.id, kind, command, status: 'running', startedAt: at, updatedAt: at, events: [],
            ...(kind !== 'agent' && string(r.cwd) && { cwd: string(r.cwd) }),
            prompt: string(input.prompt), agentType: string(input.subagent_type, 160), model: string(input.model, 160),
            title: string(input.description, 240) || string(input.name, 240) || command?.split('\n')[0].slice(0, 200) || (kind === 'agent' ? t('core.subagent') : String(b.name)),
            background: kind === 'monitor' || input.run_in_background === true || undefined };
          this.entries.set(b.id, { item });
        } else if ((b.name === 'TaskStop' || b.name === 'KillShell' || b.name === 'TaskOutput') && activityTaskId(input.task_id ?? input.shell_id)) {
          this.controls.set(b.id, { tool: b.name, task: String(input.task_id ?? input.shell_id) });
        } else if (b.name === 'SendMessage') {
          // A message to a finished or stopped subagent resumes it (the result names it).
          this.controls.set(b.id, { tool: b.name, task: activityTaskId(input.to) ? input.to : undefined });
          if (activityTaskId(input.to)) this.messageCall(b.id, input.to);
        }
      }
      if (r.type === 'user') {
        const results = blocks(message.content).filter(b => b.type === 'tool_result' && typeof b.tool_use_id === 'string');
        const detail = object(results.length === 1 ? r.toolUseResult : undefined);
        for (const b of results) this.result(b, detail, at);
      }
    }
    // The global transcript remains the source for older history. Keep live
    // tasks and a bounded recent activity panel, even in multi-day sessions.
    // Subagents stay: SendMessage can resume one at any later time, and an
    // evicted one would miss that depending on how the records were chunked
    // (live polls ingest many small reads, a page rebuild one large one).
    if (this.entries.size > 128) {
      let excess = this.entries.size - 128;
      for (const [id, entry] of this.entries) {
        if (!excess) break;
        if (entry.item.status === 'running' || entry.item.kind === 'agent') continue;
        this.entries.delete(id);
        if (entry.item.taskId && this.byTask.get(entry.item.taskId) === entry) this.byTask.delete(entry.item.taskId);
        excess--;
      }
    }
  }

  private messageCall(id: string, agent: string) {
    this.messageCalls.set(id, agent);
    if (this.messageCalls.size > 256) this.messageCalls.delete(this.messageCalls.keys().next().value!);
  }
  private bind(entry: Entry, id: unknown) {
    if (activityTaskId(id) && (!entry.item.taskId || entry.item.taskId === id)) {
      entry.item.taskId = id;
      this.byTask.set(id, entry);
    }
  }
  private event(item: SessionActivity, text: string, key: string, at?: string) {
    if (!text || item.events.some(e => e.key === key)) return false;
    item.events = [...item.events.slice(-15), { key, text: text.slice(0, 1024), at }];
    if (at && (!item.updatedAt || at > item.updatedAt)) item.updatedAt = at;
    return true;
  }
  /** Keeps the newest TRANSCRIPT_OUTPUT characters of what the transcript recorded. */
  private record(entry: Entry, text: string, append: boolean) {
    const all = (append ? (entry.transcript ?? '') : '') + text;
    entry.transcript = all.length > TRANSCRIPT_OUTPUT ? all.slice(-TRANSCRIPT_OUTPUT) : all;
  }
  /** What the transcript recorded of a shell's or monitor's output (not the sampled tail of its file). */
  transcriptOutput(id: string): string | undefined {
    return this.entries.get(id)?.transcript || undefined;
  }
  private finish(entry: Entry, status: ActivityState, at?: string) {
    if (status === 'running' || entry.item.status !== 'running') return false;
    // Observed before the latest resume: it ended the run before that one.
    if (at && entry.item.resumedAt && at < entry.item.resumedAt) return false;
    entry.item.status = status;
    entry.item.endedAt = at;
    entry.item.updatedAt = at ?? entry.item.updatedAt;
    entry.waiting = false;
    return true;
  }
  /** SendMessage to a finished or stopped subagent starts a new run of it. A
   * message queued for a running one ("Message queued for delivery") changes nothing. */
  private resume(entry: Entry, at?: string) {
    const item = entry.item;
    if (item.kind !== 'agent' || item.status === 'running') return;
    const start = runStart(item);
    if (at) {
      // Without a time the new run cannot be told apart: it continues the last one.
      if (start && item.endedAt) item.priorRunMs = (item.priorRunMs ?? 0) + Math.max(0, Date.parse(item.endedAt) - Date.parse(start));
      item.resumedAt = at;
    }
    item.status = 'running';
    item.endedAt = undefined;
    entry.waiting = false;
    item.resumes = (item.resumes ?? 0) + 1;
    item.updatedAt = at ?? item.updatedAt;
    // Its transcript grows again: sample it like any running task.
    entry.settledRead = false;
    entry.attempts = 0;
  }
  private result(b: JsonRecord, detail: JsonRecord, at?: string) {
    const id = String(b.tool_use_id), text = contentText(b.content);
    const control = this.controls.get(id);
    if (control) {
      this.controls.delete(id);
      if (b.is_error) return;
      if (control.tool === 'SendMessage') {
        // Several results in one record carry no toolUseResult: read the result text.
        const reply = detail.success !== undefined || detail.message !== undefined ? detail : parsed(text);
        if (reply.success === false) return;
        const named = [reply.resumedAgentId, reply.revivedAgentId].find(activityTaskId);
        const prefix = /^Resuming agent ([A-Za-z0-9_-]+)/.exec(string(reply.message) ?? text)?.[1];
        const agent = named ?? (prefix && control.task?.startsWith(prefix) ? control.task : undefined);
        const target = agent && this.byTask.get(agent);
        if (!target) return;
        this.messageCall(id, agent);
        this.resume(target, at);
        return;
      }
      const target = control.task && this.byTask.get(control.task);
      if (!target) return;
      if (control.tool === 'TaskOutput') {
        const task = object(detail.task);
        const status = statusFor(task.status);
        if (task.task_id === control.task && typeof task.output === 'string' && task.output) this.record(target, task.output, false);
        if (status && task.task_id === control.task) {
          // Running again after its last notification: resumed without a record of it here.
          if (status === 'running' && target.item.endedAt && at && at > target.item.endedAt) this.resume(target, at);
          else this.finish(target, status, at);
        }
      } else this.finish(target, 'stopped', at);
      return;
    }
    const entry = this.entries.get(id);
    if (!entry) return;
    const item = entry.item;
    const backgroundId = item.kind === 'shell' ? detail.backgroundTaskId : item.kind === 'monitor' ? detail.taskId : detail.agentId;
    this.bind(entry, backgroundId);
    item.model = string(detail.resolvedModel, 160) ?? item.model;
    item.timeoutMs = number(detail.timeoutMs) ?? item.timeoutMs;
    item.updatedAt = at ?? item.updatedAt;
    const usage = object(detail.usage);
    item.toolUses = number(detail.totalToolUseCount) ?? item.toolUses;
    item.tokens = number(detail.totalTokens) ?? number(usage.total_tokens) ?? item.tokens;
    if (!b.is_error && (item.kind !== 'agent' && activityTaskId(backgroundId) || detail.isAsync === true || detail.status === 'async_launched')) {
      item.background = true;
      return;
    }
    if (text) item.summary = text.slice(0, 3072);
    this.finish(entry, detail.interrupted === true ? 'stopped' : b.is_error ? 'failed' : 'completed', at);
  }

  /**
   * One native notification can be written up to three times: enqueued when
   * Claude Code observes it, then delivered as a user record, or absorbed into a
   * running turn (removed from the queue, sometimes followed by an attachment that
   * carries the enqueue time). It applies once, at its first observation, so a
   * late delivery never ends a run that a resume started meanwhile.
   */
  private notification(xml: string, at: string | undefined, source: NoticeSource) {
    const raw = xml.trim();
    if (!raw.startsWith('<task-notification>') || !raw.endsWith('</task-notification>')) return;
    const task = xmlValue(raw, 'task-id'), tool = xmlValue(raw, 'tool-use-id');
    if (!activityTaskId(task)) return;
    const entry = this.byTask.get(task) ?? (tool ? this.entries.get(tool) : undefined);
    if (!entry || tool && tool !== entry.item.id && this.messageCalls.get(tool) !== task || entry.item.taskId && entry.item.taskId !== task) return;
    const fingerprint = raw.length + ':' + raw.slice(0, 2048);
    const pending = entry.notices ??= [];
    if (source === 'enqueue') {
      pending.push(fingerprint);
      if (pending.length > 32) pending.shift();
    } else {
      const index = pending.indexOf(fingerprint);
      if (index >= 0) { pending.splice(index, 1); return; }
      if (source === 'remove') return;
    }
    this.bind(entry, task);
    const item = entry.item, event = xmlValue(raw, 'event'), summary = xmlValue(raw, 'summary'), result = xmlValue(raw, 'result');
    const nativeStatus = xmlValue(raw, 'status');
    const expiry = nativeStatus === undefined && item.kind === 'monitor' && event && monitorExpiryNotice.test(event) ? event : undefined;
    // Two identical native events at different times are still two events.
    if (event && !expiry && this.event(item, event, 'notice:' + at + ':' + event.slice(0, 1024), at) && item.kind === 'monitor') this.record(entry, event + '\n', true);
    const status = expiry ? 'completed' : statusFor(nativeStatus);
    if (!status) return;
    const interim = item.kind === 'agent' && interimNotice(summary, xmlValue(raw, 'note'));
    if (interim && summary) this.event(item, summary, 'notice:' + at + ':' + summary.slice(0, 1024), at);
    // Observed before the latest resume, or before the end of the latest run:
    // it reports on an earlier state. The later notification always wins.
    if (at && item.resumedAt && at < item.resumedAt) return;
    if (at && item.status !== 'running' && item.endedAt && at < item.endedAt) return;
    if (entry.waiting && item.status !== 'running' && status !== 'running') {
      // It stopped while its own background work ran and went on by itself:
      // this notification replaces the interim one (the run lasted until now).
      item.status = 'running';
      entry.settledRead = false;
      entry.attempts = 0;
    }
    if (this.finish(entry, status, at)) entry.waiting = interim;
    item.summary = expiry ?? (result || summary)?.slice(0, 3072) ?? item.summary;
    if (summary && item.kind !== 'agent') {
      const code = /\bexit(?:ed with)? code\s+(-?\d+)\)?\s*$/i.exec(summary);
      if (code) item.exitCode = Number(code[1]);
    }
    const usage = xmlValue(raw, 'usage');
    if (usage) {
      item.toolUses = number(Number(/<tool_uses>(\d+)<\/tool_uses>/.exec(usage)?.[1])) ?? item.toolUses;
      item.tokens = number(Number(/<(?:total|subagent)_tokens>(\d+)<\/(?:total|subagent)_tokens>/.exec(usage)?.[1])) ?? item.tokens;
    }
  }

  samples(frames: ActivitySample[]) {
    for (const frame of frames) {
      const entry = this.byTask.get(frame.taskId);
      if (!entry) continue;
      entry.stamp = frame.stamp;
      if (entry.item.status !== 'running') entry.settledRead = true;
      if (!frame.tail) continue;
      if (entry.item.kind !== 'agent') {
        const text = frame.tail.replace(/\x1b\[[\d;?]*[a-zA-Z]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
        entry.item.output = (frame.clipped ? '…\n' : '') + text.slice(-4096);
        continue;
      }
      for (const line of frame.tail.split('\n')) {
        if (!line.startsWith('{')) continue;
        try {
          const row = JSON.parse(line);
          if (row.sessionId === this.sessionId && row.agentId === frame.taskId && row.type === 'assistant') {
            this.agentMessage(entry.item, object(row.message), timestamp(row.timestamp), string(row.uuid));
          }
        } catch { /* A bounded tail can start or end within a native record. */ }
      }
    }
  }
  private agentMessage(item: SessionActivity, message: JsonRecord, at?: string, uuid?: string) {
    item.model = string(message.model, 160) ?? item.model;
    for (const b of blocks(message.content)) {
      if (b.type === 'tool_use') {
        const input = object(b.input), description = string(input.description) || string(input.file_path) || string(input.command) || string(input.pattern);
        this.event(item, [string(b.name), description].filter(Boolean).join(' · '), String(b.id), at);
      } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        this.event(item, b.text.trim(), uuid || at + b.text.slice(0, 64), at);
      }
    }
  }
}
