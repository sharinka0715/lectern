import { JsonlDecoder } from './jsonl';
import { t, type MessageKey } from '../shared/i18n';
import { TranscriptStore, type TranscriptChange } from './transcript-store';
import type { ContextUsageObservation } from './request-usage';
export type { ContextUsageObservation } from './request-usage';
import { isEditorRule, stripTerminalEscapes, withoutRightNotice, withoutTaskRows } from './screen';

export type ExecutionMode = 'auto' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'default' | 'dontAsk';

export interface ExecutionModeObservation {
  mode: ExecutionMode;
  label: string;
  source: 'native-footer';
  evidence: string;
}

// The native footer resolves the user's binding. Accept a named key or
// modifier chord (including a two-stroke sequence) inside the explicit hint.
const stroke = String.raw`(?:(?:ctrl|control|alt|option|meta|cmd|command|shift|super)\+)*(?:[a-z0-9]|f(?:[1-9]|1[0-9]|2[0-4])|tab|space|enter|escape|esc|backspace|delete|up|down|left|right)`;
const cycleHint = new RegExp(String.raw`^\((?:${stroke})(?: ${stroke})? to cycle\)(?:\s*·.*)?$`, 'i');
const taskCount = String.raw`\d+ (?:shells?|agents?|monitors?|workflows?|(?:background )?tasks?)`;
const taskHint = new RegExp(String.raw`^(?:${taskCount}(?:, ${taskCount})*|↓ to manage|← for agents|esc to interrupt|\? for shortcuts)$`, 'u');
const modes: ReadonlyArray<{ mode: ExecutionMode; label: MessageKey; pattern: RegExp }> = [
  { mode: 'auto', label: 'core.modeAuto', pattern: /^auto mode on\b/i },
  { mode: 'acceptEdits', label: 'core.modeAcceptEdits', pattern: /^accept edits on\b/i },
  { mode: 'plan', label: 'core.modePlan', pattern: /^plan mode on\b/i },
  { mode: 'bypassPermissions', label: 'core.modeBypass', pattern: /^bypass permissions on\b/i },
  { mode: 'dontAsk', label: 'core.modeDontAsk', pattern: /^don['’]t ask on\b/i },
  { mode: 'default', label: 'core.modeManual', pattern: /^manual mode(?: on)?\b/i },
];

/**
 * Parse only the footer below the current, boxed native input. Pass the viewport,
 * not scrollback: historical input boxes cannot establish the current mode.
 * Missing mode badges (including "? for shortcuts") do not imply Manual mode.
 */
export function parseExecutionMode(screen: string): ExecutionModeObservation | undefined {
  const raw = stripTerminalEscapes(screen).split('\n');
  while (raw.length && !raw.at(-1)!.trim()) raw.pop();
  // Background tasks listed below the footer are not part of it.
  const lines = withoutTaskRows(raw);
  // A footer belongs to the last input box only. This also excludes quoted
  // examples in assistant prose and stale badges above a current open menu.
  let input = -1;
  for (let index = lines.length - 1; index >= Math.max(0, lines.length - 24); index--) {
    if (/^\s*❯(?:\s|$)/u.test(lines[index])) { input = index; break; }
  }
  if (input < 1 || !isEditorRule(lines[input - 1])) return undefined;
  let fenced = false;
  for (const line of lines.slice(0, input)) if (/^\s*```/.test(line)) fenced = !fenced;
  if (fenced) return undefined;
  let bottom = -1;
  for (let index = input + 1; index < Math.min(lines.length, input + 10); index++) {
    if (isEditorRule(lines[index])) { bottom = index; break; }
  }
  if (bottom < 0 || lines.length - bottom > 7) return undefined;
  for (const line of lines.slice(bottom + 1)) {
    // Native manual mode omits the cycle hint, including while a draft is in
    // the box. Its pause icon plus exact badge provides independent evidence.
    // A right-aligned notice can share the row with the mode badge.
    const evidence = withoutRightNotice(line).trim();
    if (/^⏸\s+manual mode on(?:\s*·\s*(?:\? for shortcuts|esc to interrupt))?(?:\s*·\s*← for agents)?\s*$/iu.test(evidence)) {
      return { mode: 'default', label: t('core.modeManual'), source: 'native-footer', evidence };
    }
    // Other native badges use the keyboard hint as independent footer evidence;
    // an arbitrary mention of a mode is not enough.
    const badge = evidence.replace(/^[⏵▶⏸►»]+\s*/u, '');
    const hintAt = badge.indexOf(' (');
    let label: string;
    if (hintAt >= 0 && cycleHint.test(badge.slice(hintAt + 1))) label = badge.slice(0, hintAt);
    else {
      // Background work can replace the cycle hint with counts and key hints
      // ("auto mode on · 1 shell, 1 monitor · ↓ to manage").
      const icon = /^[⏵▶⏸►»]+/u.exec(evidence)?.[0];
      const [first, ...rest] = badge.split(' · ');
      const pauseMode = /^(?:manual|plan) mode\b/iu.test(first);
      if (!icon || !rest.length || !rest.every(part => taskHint.test(part)) || icon.startsWith('⏸') !== pauseMode) continue;
      label = first;
    }
    const match = modes.find(entry => label.match(entry.pattern)?.[0] === label);
    if (match) return { mode: match.mode, label: t(match.label), source: 'native-footer', evidence };
  }
  return undefined;
}

/** The most recently completed request on the selected main-conversation branch. */
export class TranscriptUsage {
  private completed?: ContextUsageObservation;
  private pending?: ContextUsageObservation;
  private hasPendingAssistant = false;

  get context(): ContextUsageObservation | undefined {
    return this.completed ? { ...this.completed } : undefined;
  }

  reset(): void {
    this.completed = this.pending = undefined;
    this.hasPendingAssistant = false;
  }

  apply(change: TranscriptChange): void {
    if (change.replace) this.reset();
    for (const row of change.rows) {
      if (row.kind === 'compact') {
        this.reset();
      } else if (row.kind === 'user' || row.kind === 'command') {
        this.pending = undefined;
        this.hasPendingAssistant = false;
      } else if (row.kind === 'assistant' && row.realRequest && !change.preserved.has(row.key)) {
        this.pending = row.usage;
        this.hasPendingAssistant = true;
        if (row.responseComplete) this.publish();
      } else if (row.kind === 'duration' && this.hasPendingAssistant) this.publish();
    }
  }

  private publish(): void {
    this.completed = this.pending;
    this.pending = undefined;
    this.hasPendingAssistant = false;
  }
}

/** Standalone usage reader for callers that do not already have a MessageDisplay projection. */
export class SessionTelemetry {
  private decoder = new JsonlDecoder();
  private transcript = new TranscriptStore(undefined, false);
  private usage = new TranscriptUsage();

  get context() { return this.usage.context; }

  reset(): void {
    this.decoder.reset();
    this.transcript = new TranscriptStore(undefined, false);
    this.usage.reset();
  }

  ingestJsonl(chunk: Buffer | string, reset = false): void {
    if (reset) this.reset();
    this.usage.apply(this.transcript.append(this.decoder.push(chunk)));
  }
}
