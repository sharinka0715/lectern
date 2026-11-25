#!/usr/bin/env node
/** Offline only: reads bounded diagnostic files and replays the display reducer. */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { observedSessionStatus, type NativeActivity } from '../src/core/observed-status';
import { parseQuestionScreen } from '../src/core/question-screen';
import { MessageDisplay } from '../src/core/message-display';
import { classifySessionScreen, type SessionScreenClassification } from '../src/core/screen';
import { summarize } from '../src/diagnostics';
import type { ChatMessage, SessionStatus } from '../src/shared/types';

export interface DiagnosticEntry {
  schemaVersion: number;
  runId: string;
  seq: number;
  timestamp?: string;
  event: string;
  context: Record<string, unknown>;
  data: Record<string, unknown>;
}
export interface ReplayOptions { sessionId?: string; watchId?: string }
export interface ReplayWatch {
  runId: string;
  watchId: string;
  sessionId: string;
  complete: boolean;
  warnings: string[];
  validation: { checked: number; matched: number; mismatched: number; unverifiable: number };
  messages: ChatMessage[];
  status: SessionStatus;
  notice?: string;
  trace: { seq: number; event: string; detail: Record<string, unknown> }[];
}
export interface ReplayReport {
  schemaVersion: 1;
  eventCount: number;
  files: string[];
  warnings: string[];
  watches: ReplayWatch[];
}
type ReplayState = { report: ReplayWatch; display: MessageDisplay; startSeq?: number; lastSeq: number; active: boolean; hasMore: boolean; paneId?: string; error?: string; errorName?: string;
  nativeStatus?: NativeActivity; navigationError?: boolean;
  observedStatus?: SessionScreenClassification['status']; observationMatches?: boolean };
const string = (value: unknown) => typeof value === 'string' ? value : undefined;
function metadata(entry: DiagnosticEntry, key: string): unknown { return entry.data[key] ?? entry.context[key]; }
function isDigest(value: unknown): value is { bytes: number; sha256: string } {
  return !!value && typeof value === 'object' && typeof (value as any).sha256 === 'string' && typeof (value as any).bytes === 'number';
}
function presentedMessages(display: MessageDisplay, inactiveFilter: boolean): ChatMessage[] {
  const messages = display.getMessages();
  return inactiveFilter ? messages.filter(message => message.role !== 'assistant' || message.text || message.tools.length)
    .map(message => message.status === 'streaming' ? { ...message, status: 'complete' as const } : message) : messages;
}

/** The input order may span rotated files; runId+seq establish the replay order. */
export function replayEntries(input: DiagnosticEntry[], options: ReplayOptions = {}): ReplayReport {
  const report: ReplayReport = { schemaVersion: 1, eventCount: input.length, files: [], warnings: [], watches: [] };
  const unique = new Map<string, DiagnosticEntry>();
  const runOrder = new Map<string, number>();
  let structurallyIncomplete = false;
  for (const entry of input) {
    if (entry.schemaVersion !== 1 || !entry.runId || !Number.isInteger(entry.seq) || !entry.event) {
      report.warnings.push('Ignored an invalid or unsupported diagnostic entry; this input is incomplete.');
      structurallyIncomplete = true;
      continue;
    }
    if (!runOrder.has(entry.runId)) runOrder.set(entry.runId, runOrder.size);
    const key = `${entry.runId}:${entry.seq}`;
    if (unique.has(key) && JSON.stringify(unique.get(key)) !== JSON.stringify(entry)) {
      report.warnings.push(`Conflicting duplicate sequence ${key}; kept the first record.`);
      structurallyIncomplete = true;
    }
    else if (!unique.has(key)) unique.set(key, entry);
  }
  const entries = [...unique.values()].sort((a, b) => runOrder.get(a.runId)! - runOrder.get(b.runId)! || a.seq - b.seq);
  const captures = new Map<string, DiagnosticEntry>();
  const gaps: { runId: string; from: number; to: number }[] = [];
  const previousSeq = new Map<string, number>();
  for (const entry of entries) {
    const previous = previousSeq.get(entry.runId);
    if (previous === undefined && entry.seq > 1) report.warnings.push(`Run ${entry.runId} starts at sequence ${entry.seq}; older rotated records are unavailable.`);
    if (previous !== undefined && entry.seq > previous + 1) {
      gaps.push({ runId: entry.runId, from: previous + 1, to: entry.seq - 1 });
      report.warnings.push(`Sequence gap in run ${entry.runId}: ${previous + 1}–${entry.seq - 1}.`);
    }
    previousSeq.set(entry.runId, entry.seq);
    if (entry.event.startsWith('capture.') && typeof entry.data.captureId === 'string') captures.set(`${entry.runId}:${entry.data.captureId}`, entry);
    if (entry.data.truncated === true && !entry.event.startsWith('capture.')) {
      gaps.push({ runId: entry.runId, from: entry.seq, to: entry.seq });
      report.warnings.push(`Diagnostic metadata was truncated at ${entry.runId}:${entry.seq}.`);
    }
    if (entry.event === 'diagnostics.queue_dropped') report.warnings.push(`Logger dropped events in run ${entry.runId}; exact replay may be unavailable.`);
  }
  const states = new Map<string, ReplayState>();
  const warn = (state: ReplayState, warning: string) => {
    state.report.complete = false;
    if (!state.report.warnings.includes(warning)) state.report.warnings.push(warning);
  };
  function capture(state: ReplayState, entry: DiagnosticEntry, id: unknown, kind: string, expected?: unknown): Buffer | undefined {
    if (typeof id !== 'string') { warn(state, `Missing ${kind} capture at sequence ${entry.seq}; raw capture may have been disabled.`); return; }
    const source = captures.get(`${entry.runId}:${id}`);
    if (!source || source.event !== `capture.${kind}` || source.seq > entry.seq) {
      warn(state, `Missing or invalid ${kind} capture ${id} referenced at sequence ${entry.seq}; rotation or dropped events may have removed it.`); return;
    }
    if (source.data.redacted || source.data.truncated) {
      warn(state, `${kind} capture ${id} is ${source.data.redacted ? 'redacted' : 'truncated'}; original bytes cannot be reconstructed.`); return;
    }
    if (typeof source.data.content !== 'string' || !['base64', 'utf8'].includes(String(source.data.encoding))) {
      warn(state, `Invalid ${kind} capture encoding at sequence ${source.seq}.`); return;
    }
    const bytes = Buffer.from(source.data.content, source.data.encoding === 'base64' ? 'base64' : 'utf8');
    const digest = summarize(bytes);
    if (digest.bytes !== source.data.bytes || digest.sha256 !== source.data.sha256) {
      warn(state, `${kind} capture ${id} fails byte/hash verification.`); return;
    }
    if (isDigest(expected) && (digest.bytes !== expected.bytes || digest.sha256 !== expected.sha256)) {
      warn(state, `${kind} capture ${id} differs from the expected reducer-input digest at sequence ${entry.seq}.`); return;
    }
    return bytes;
  }
  for (const entry of entries) {
    const watchId = string(metadata(entry, 'watchId'));
    const sessionId = string(metadata(entry, 'sessionId'));
    if (!watchId || (options.watchId && options.watchId !== watchId)) continue;
    const key = `${entry.runId}:${watchId}`;
    let state = states.get(key);
    if (!state) {
      if (!sessionId || (options.sessionId && options.sessionId !== sessionId)) continue;
      const watch: ReplayWatch = { runId: entry.runId, watchId, sessionId, complete: true, warnings: [],
        validation: { checked: 0, matched: 0, mismatched: 0, unverifiable: 0 }, messages: [], status: 'connecting', trace: [] };
      state = { report: watch, display: new MessageDisplay(sessionId), lastSeq: entry.seq, active: false, hasMore: false };
      states.set(key, state); report.watches.push(watch);
    }
    state.lastSeq = entry.seq;
    if (entry.event === 'controller.watch.start') {
      state.startSeq = entry.seq;
      state.display = new MessageDisplay(state.report.sessionId);
      state.report.trace.push({ seq: entry.seq, event: entry.event, detail: {} });
    } else if (entry.event === 'controller.history.initial') {
      const bytes = capture(state, entry, entry.data.jsonlCaptureId, 'jsonl', entry.data.jsonl);
      if (bytes) state.display.ingestJsonl(bytes, true, true);
      if (typeof entry.data.skippedHistoryRecords === 'number') state.display.noteSkippedHistoryRecords(entry.data.skippedHistoryRecords);
    } else if (entry.event === 'controller.poll.apply') {
      state.display.setRewindProcess(typeof entry.data.rewindStartedAt === 'number' ? entry.data.rewindStartedAt : undefined);
      const incoming = isDigest(entry.data.jsonl) ? entry.data.jsonl : undefined;
      let chunk: Buffer | undefined;
      if (entry.data.jsonlCaptureId) chunk = capture(state, entry, entry.data.jsonlCaptureId, 'jsonl', entry.data.jsonl);
      else if (incoming?.bytes === 0 && entry.data.reset !== true) chunk = Buffer.alloc(0);
      else warn(state, `JSONL input unavailable at sequence ${entry.seq}.`);
      if (!entry.data.initialAlreadyApplied) {
        if (chunk) state.display.ingestJsonl(chunk, entry.data.reset === true,
          typeof entry.data.hasOlder === 'boolean' ? entry.data.hasOlder : undefined);
        if (typeof entry.data.skippedHistoryRecords === 'number') state.display.noteSkippedHistoryRecords(entry.data.skippedHistoryRecords);
      }
      if (entry.data.screenApplied === true) {
        const screen = capture(state, entry, entry.data.screenCaptureId, 'screen', entry.data.screen);
        const viewport = entry.data.viewportApplied === true
          ? capture(state, entry, entry.data.viewportCaptureId, 'viewport', entry.data.viewport) : undefined;
        if (screen) state.display.ingestScreen(screen.toString('utf8'), viewport?.toString('utf8'));
      }
      state.observedStatus = undefined;
      state.observationMatches = undefined;
      if (entry.data.manualRecovery === true || entry.data.terminalControlActive === true || entry.data.questionScreen === true) {
        const kind = entry.data.observedStatusSource === 'viewport' ? 'viewport' : 'screen';
        const screen = capture(state, entry, entry.data[`${kind}CaptureId`], kind, entry.data[kind]);
        if (screen) {
          // Classify the raw frame independently, never ingest unknown menu text
          // into a chat turn and never trust the logged status as the answer.
          const frame = screen.toString('utf8');
          state.observedStatus = entry.data.questionScreen === true && parseQuestionScreen(frame) ? 'waiting' : classifySessionScreen(frame).status;
          state.observationMatches = state.observedStatus === entry.data.observedStatus;
        }
      }
      const native = entry.data.nativeStatus;
      state.nativeStatus = native === 'busy' || native === 'idle' || native === 'shell' || native === 'waiting' ? native : undefined;
      state.navigationError = entry.data.navigationError === true;
      state.active = entry.data.active === true;
      state.hasMore = entry.data.hasMore === true;
      state.paneId = string(entry.data.paneId);
      state.error = undefined;
      state.errorName = undefined;
      state.report.trace.push({ seq: entry.seq, event: entry.event, detail: { reset: entry.data.reset, hasMore: state.hasMore, screenApplied: entry.data.screenApplied,
        viewportApplied: entry.data.viewportApplied === true, bytes: incoming?.bytes, decoder: state.display.diagnosticState.decoder } });
    } else if (entry.event === 'controller.history.prepend') {
      const bytes = capture(state, entry, entry.data.jsonlCaptureId, 'jsonl', entry.data.jsonl);
      if (bytes) state.display.prependJsonl(bytes, entry.data.hasOlder === true, entry.data.deferUntilPrompt === true,
        typeof entry.data.requireNewTurn === 'boolean' ? entry.data.requireNewTurn : undefined,
        typeof entry.data.sourceSessionId === 'string' ? entry.data.sourceSessionId : undefined);
      if (typeof entry.data.skippedHistoryRecords === 'number') state.display.noteSkippedHistoryRecords(entry.data.skippedHistoryRecords);
      state.report.trace.push({ seq: entry.seq, event: entry.event, detail: { bytes: bytes?.length, hasOlder: entry.data.hasOlder } });
    } else if (entry.event === 'controller.history.rewind_pages' && Array.isArray(entry.data.pages)) {
      const captured = entry.data.pages.flatMap((value: unknown) => {
        if (!value || typeof value !== 'object') return [];
        const page = value as Record<string, unknown>;
        const jsonl = capture(state, entry, page.jsonlCaptureId, 'jsonl', page.jsonl);
        return jsonl ? [{ jsonl, sourceSessionId: string(page.sourceSessionId),
          skippedHistoryRecords: typeof page.skippedHistoryRecords === 'number' ? page.skippedHistoryRecords : undefined }] : [];
      });
      if (captured.length === entry.data.pages.length) state.display.prependCompleteHistory(captured);
      else warn(state, `Rewind history batch unavailable at sequence ${entry.seq}.`);
      state.report.trace.push({ seq: entry.seq, event: entry.event, detail: { pages: entry.data.pages.length } });
    } else if (entry.event === 'controller.optimistic_user') {
      const input = capture(state, entry, entry.data.inputCaptureId, 'input', entry.data.text);
      if (input) state.display.optimisticUser(input.toString('utf8'));
      state.report.trace.push({ seq: entry.seq, event: entry.event, detail: { inputCaptureId: entry.data.inputCaptureId } });
    } else if (entry.event === 'controller.interrupt') {
      state.display.markInterrupted();
      state.report.trace.push({ seq: entry.seq, event: entry.event, detail: { reason: entry.data.reason, key: entry.data.key } });
    } else if (entry.event === 'controller.poll.failed') {
      state.error = string((entry.data.error as Record<string, unknown> | undefined)?.message);
      state.errorName = string((entry.data.error as Record<string, unknown> | undefined)?.name);
    } else if (entry.event === 'controller.snapshot') {
      // Failed polls retain the last presented message list, including inactive
      // history filtering; successful polls are reconstructed from the reducer.
      const failedPoll = entry.data.reason === 'poll' && !!state.error;
      // Settings lifecycle changes only settingBusy, which is excluded from the
      // state digest. In particular an offline poll must stay offline at end.
      const presentationOnly = ['settings-start', 'settings-end', 'settings-cache', 'trust-start', 'trust-end', 'question-start', 'terminal-control-start', 'terminal-control-end', 'terminal-input-failed'].includes(string(entry.data.reason) ?? '');
      const messages = failedPoll || presentationOnly ? state.report.messages : presentedMessages(state.display, entry.data.inactiveFilter === true);
      const actual = summarize(JSON.stringify(messages));
      const expected = entry.data.messagesDigest;
      const computedStatus: SessionStatus = presentationOnly || entry.data.reason === 'history-prepend' ? state.report.status
        : entry.data.reason === 'send' ? 'working' : entry.data.reason === 'key' ? state.display.status
        : failedPoll ? state.errorName === 'SessionMappingError' ? 'error' : 'offline'
          : state.hasMore ? 'connecting' : state.active ? observedSessionStatus(
            state.observedStatus && state.observedStatus !== 'unknown' ? state.observedStatus : state.display.status,
            state.nativeStatus, state.navigationError) : 'idle';
      const computedNotice = failedPoll || presentationOnly || entry.data.reason === 'send' ? state.report.notice : state.display.notice;
      const actualState = summarize(JSON.stringify({ messages, status: computedStatus, paneId: entry.data.paneId, notice: computedNotice, error: entry.data.error }));
      const expectedState = entry.data.fullStateDigest;
      const fullStateMatches = isDigest(expectedState) ? expectedState.sha256 === actualState.sha256 && expectedState.bytes === actualState.bytes : undefined;
      const messageDigestMatches = isDigest(expected) ? actual.bytes === expected.bytes && actual.sha256 === expected.sha256 && messages.length === entry.data.messageCount : undefined;
      let validation: 'matched' | 'mismatched' | 'unverifiable' = 'unverifiable';
      state.report.validation.checked++;
      if (state.report.complete && isDigest(expected)) {
        validation = messageDigestMatches && fullStateMatches !== false && state.observationMatches !== false ? 'matched' : 'mismatched';
      }
      state.report.validation[validation]++;
      if (validation === 'mismatched') state.report.warnings.push(`Snapshot mismatch at sequence ${entry.seq}; messages or presentation state differ from the recorded digest (including possible parser-version differences).`);
      const status = string(entry.data.status) as SessionStatus | undefined;
      state.report.messages = messages;
      state.report.status = computedStatus;
      state.report.notice = computedNotice;
      state.report.trace.push({ seq: entry.seq, event: entry.event, detail: { validation, expected, actual, messageCount: messages.length, fullStateMatches,
        messageDigestMatches, recordedStatus: status, computedStatus, notice: computedNotice } });
    }
  }
  for (const state of states.values()) {
    if (structurallyIncomplete) warn(state, 'Invalid or conflicting diagnostic entries prevent an exact replay guarantee.');
    if (state.startSeq === undefined) warn(state, 'Watch start is missing; the log may have rotated before this session was opened.');
    if (gaps.some(gap => gap.runId === state.report.runId && gap.to >= (state.startSeq ?? 0) && gap.from <= state.lastSeq)) warn(state, 'A sequence gap overlaps this watch; some reducer inputs may be absent.');
    if (!state.report.validation.checked) warn(state, 'No snapshot checkpoints were available for validation.');
    if (!state.report.complete) {
      // Completeness may only become knowable after scanning for rotated starts
      // and sequence gaps. Do not label earlier checkpoint matches lossless.
      state.report.validation.unverifiable += state.report.validation.matched + state.report.validation.mismatched;
      state.report.validation.matched = 0;
      state.report.validation.mismatched = 0;
    }
  }
  if (!report.watches.length) report.warnings.push('No matching controller watch found; check --session/--watch or capture a new session.');
  return report;
}

export async function replayDiagnostics(directory: string, options: ReplayOptions = {}): Promise<ReplayReport> {
  const names = (await readdir(directory)).filter(name => /^events\.\d+\.jsonl$/.test(name))
    .sort((a, b) => Number(b.split('.')[1]) - Number(a.split('.')[1]));
  const entries: DiagnosticEntry[] = [];
  const warnings: string[] = [];
  for (const name of names) {
    let content: string;
    try { content = await readFile(path.join(directory, name), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      warnings.push(`Diagnostic file ${name} disappeared during reading; live rotation may have removed part of the timeline.`);
      continue;
    }
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      try {
        const entry = JSON.parse(lines[index]);
        if (!entry || typeof entry !== 'object' || !entry.data || !entry.context) throw new Error('invalid entry');
        entries.push(entry as DiagnosticEntry);
      } catch { warnings.push(`Unreadable diagnostic line ${name}:${index + 1}; possibly a partial write or damaged log.`); }
    }
  }
  const report = replayEntries(entries, options);
  report.files = names;
  report.warnings.unshift(...warnings);
  if (warnings.length) for (const watch of report.watches) {
    watch.complete = false;
    watch.warnings.push('Unreadable diagnostic lines prevent an exact replay guarantee.');
    watch.validation.unverifiable += watch.validation.matched + watch.validation.mismatched;
    watch.validation.matched = 0; watch.validation.mismatched = 0;
  }
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const directory = args.shift();
  if (!directory || directory === '--help') {
    process.stdout.write('Usage: npx tsx scripts/replay-diagnostics.ts LOG_DIRECTORY [--session UUID] [--watch WATCH_ID] [--output report.json]\nReads local logs only; never connects to SSH or sends model requests.\n');
    return;
  }
  const options: ReplayOptions = {};
  let output: string | undefined;
  while (args.length) {
    const flag = args.shift(), value = args.shift();
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === '--session') options.sessionId = value;
    else if (flag === '--watch') options.watchId = value;
    else if (flag === '--output') output = value;
    else throw new Error(`Unknown option ${flag}`);
  }
  const report = await replayDiagnostics(path.resolve(directory), options);
  const serialized = JSON.stringify(report, null, 2) + '\n';
  if (output) await writeFile(path.resolve(output), serialized, { mode: 0o600 });
  else process.stdout.write(serialized);
  if (report.watches.some(watch => watch.validation.mismatched > 0)) process.exitCode = 2;
  else if (!report.watches.length || report.watches.some(watch => !watch.complete)) process.exitCode = 3;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`Replay failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
