import type { CompactReceipt, TurnProgressObservation } from '../shared/types';
import type { JsonRecord } from './jsonl';
import { composerLines, rowAboveEditor, turnComposer } from './turn-controls';

const spinner = /^([·✢✳✶✻✽✺*●∴∷∵]) +(.{1,200}?)\s*$/u;
const timer = /^(?:\d+(?:\.\d+)?(?:ms|[smhd])\s*){1,4}$/;
const tokens = /^(?:([↑↓])\s*)?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?[kmb]?)\s+tokens?$/i;
const effortBadge = /^\s*[◐◉○◌●]\s+\S+\s*·\s*\/effort\s*$/u;
const phase = (label: string): TurnProgressObservation['compactPhase'] => {
  if (/^Compacting (?:conversation|session)$/i.test(label)) return 'compacting';
  if (/^Running PreCompact hooks$/i.test(label)) return 'before';
  if (/^Running PostCompact hooks$/i.test(label)) return 'after';
};

// Read the rows `turnComposer` parsed, up from its upper border (`editor.top`). Counted from
// the bottom, background tasks listed below the footer put the start inside the input box.
const activityAboveEditor = (lines: string[], editor: { top: number }) => rowAboveEditor(lines, editor.top);

/** The native command may report success before the boundary flushes. Permit
 * that short gap only for the current /compact's own result, never just idle. */
export function showsCompactCompletion(viewport: string, editor = turnComposer(viewport)): boolean {
  if (!editor || editor.running) return false;
  const lines = composerLines(viewport);
  const end = activityAboveEditor(lines, editor);
  return /^\s+⎿\s+Compacted \([^()]+ to see full summary\)\s*$/u.test(lines[end] ?? '') &&
    /^❯\s+\/compact(?:\s|$)/u.test(lines[end - 1] ?? '');
}

/** Use only the live row adjacent to the current native composer, not a search
 * for the most recent spinner anywhere in the pane. Shell output, old turns
 * and a boxed composer in scrollback are not progress for this turn. */
export function parseTurnProgress(viewport: string, editor = turnComposer(viewport), nativeBusy = false): TurnProgressObservation | undefined {
  const lines = composerLines(viewport);
  let end = editor ? activityAboveEditor(lines, editor) : lines.length - 1;
  while (end >= 0 && !lines[end]) end--;
  // Older layouts have a bare interrupt hint (no input box) at the very bottom.
  const bareHint = !editor && /^\s*esc to interrupt\s*$/i.test(lines[end] ?? '');
  if (bareHint) end--;
  while (end >= 0 && (!lines[end] || effortBadge.test(lines[end]))) end--;
  const match = spinner.exec(lines[end] ?? '');
  if (!match) return;
  const [, glyph, text] = match;
  const fields = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(text);
  const heading = (fields?.[1] ?? text).trimEnd();
  const activity = heading.replace(/(?:…|\.{3})+$/, '').trimEnd();
  const compactPhase = phase(activity);
  const metrics = fields?.[2].split(/\s*[·•]\s*/u) ?? [];
  const inlineHint = metrics.some(item => /^esc to interrupt$/i.test(item));
  if (!editor?.running && !bareHint && !inlineHint && !(nativeBusy && editor)) return;
  if (!activity || (!compactPhase && activity === heading) || ('∴∷∵'.includes(glyph) && !compactPhase)) return;
  // A literal spinner at the end of an unfinished code block is not chrome.
  let fenced = false;
  for (let i = 0; i < end; i++) if (/^\s*(?:[⏺●]\s*)?```/.test(lines[i])) fenced = !fenced;
  if (fenced) return;
  // In reduced-motion mode Claude can use the ordinary assistant bullet. An
  // ellipsis alone is ambiguous even if the composer is currently busy.
  const progress: TurnProgressObservation = { activity, ...(compactPhase && { compactPhase }) };
  for (const metric of metrics) {
    if (timer.test(metric)) progress.elapsed = metric;
    else {
      const token = tokens.exec(metric);
      if (token) progress.tokens = { display: token[2], ...(token[1] && { direction: token[1] === '↓' ? 'down' : 'up' }) };
      // "running Stop hook": the /goal evaluator (or another Stop hook) checks whether the turn may end.
      else if (/^(?:thinking\b|thought for |running tool for |ran tool for |running stop hooks?$)/i.test(metric)) progress.detail = metric;
    }
  }
  if (glyph === '●' && !(progress.elapsed || progress.tokens || inlineHint)) return;
  return progress;
}

type TokenSample = NonNullable<TurnProgressObservation['tokens']>;

/** Watch-local correlation only. Never reconstruct an estimate from context,
 * reload it on a history-only read, or carry it across a pane/input change. */
export class CompactSamples {
  private pending?: { turn: string | undefined; at: number; tokens: TokenSample; ended: boolean };
  private matched?: { id: string; tokens: TokenSample };

  get awaitingReceipt() { return !!this.pending; }
  interrupt() { this.pending = undefined; }
  receipt(record?: CompactReceipt) {
    return record && this.matched?.id === record.id ? { ...record, lastObservedTokens: this.matched.tokens } : record;
  }
  observe(live: TurnProgressObservation | undefined, turn: string | undefined, newRecords: number,
    record: CompactReceipt | undefined, completionFrame: boolean, now = Date.now()) {
    if (this.pending && (this.pending.turn !== turn || now < this.pending.at || now - this.pending.at > 5000)) this.interrupt();
    if (newRecords) {
      if (newRecords === 1 && record && this.pending && live?.compactPhase !== 'before' && live?.compactPhase !== 'compacting') {
        this.matched = { id: record.id, tokens: this.pending.tokens };
      }
      this.interrupt();
      return;
    }
    if (live?.compactPhase === 'compacting') {
      if (this.pending?.ended) this.interrupt();
      if (live.tokens) this.pending = { turn, at: now, tokens: live.tokens, ended: false };
      // Each contiguous sample can confirm the same operation even if the
      // terminal narrows and temporarily hides its counter.
      else if (this.pending) this.pending.at = now;
    } else if (this.pending && (completionFrame || live?.compactPhase === 'after')) this.pending.ended = true;
    else this.interrupt();
  }
}

const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const object = (v: unknown): JsonRecord => v && typeof v === 'object' && !Array.isArray(v) ? v as JsonRecord : {};
/** Native 2.1.326 persists duration and the pre/post context estimates, not
 * the compaction model request's usage. Cost-state, the next request and
 * cumulativeDroppedTokens are all different counters. */
export function compactReceipt(row: JsonRecord): CompactReceipt | undefined {
  if (row.type !== 'system' || row.subtype !== 'compact_boundary' || typeof row.uuid !== 'string' || !row.uuid || row.isSidechain) return;
  const meta = object(row.compactMetadata);
  // The CLI also uses a zero-duration, self-anchored retention boundary to
  // reconnect existing rows, without doing any summarization.
  if (meta.durationMs === 0 && object(meta.preservedMessages).anchorUuid === row.uuid) return;
  return {
    id: row.uuid,
    timestamp: typeof row.timestamp === 'string' && Number.isFinite(Date.parse(row.timestamp)) ? row.timestamp : undefined,
    trigger: meta.trigger === 'auto' || meta.trigger === 'manual' ? meta.trigger : undefined,
    durationMs: count(meta.durationMs), preTokens: count(meta.preTokens), postTokens: count(meta.postTokens),
  };
}
