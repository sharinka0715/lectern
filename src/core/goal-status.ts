import type { GoalEvent, GoalObservation } from '../shared/types';
import { goalClearArguments } from './goal-records';
import type { TranscriptRow } from './transcript-store';

const stamp = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : undefined;
/** The arguments of a `/goal …` command row. */
const goalArguments = (row: TranscriptRow) => {
  const match = row.kind === 'command' ? /^\/goal(?:\s+([\s\S]*))?$/u.exec(row.text ?? '') : undefined;
  return match ? (match[1] ?? '').trim() : undefined;
};

type State = Omit<GoalObservation, 'source' | 'screen' | 'history'> & { restated?: boolean };

/**
 * The session's goal from its records in the conversation's order (Claude Code's own rule,
 * research §3.8): the last `goal_status` decides; met or failed means none is active. It reads
 * the rows the chat shows the goal's events from (TranscriptStore, chained by parentUuid), in
 * the same order, so the input area and the chat always agree. Claude Code 2.1.300 can write a
 * new session's first turn (the set record, the command, the reply) after the check that
 * follows it; the file's order is no guide. Like the activity card it never depends on how
 * the records were read (pages, small live reads); sidechains and other sessions never count.
 * An ended goal (met, failed, cleared) stays the current one until the next human prompt, as
 * the compaction receipt does.
 *
 * A /compact restates an active goal after its boundary with the same set record; that is a
 * new setting only when the `/goal <condition>` command record follows it.
 */
export class GoalTracker {
  private state?: State;
  private compactSince = false;
  /** The last record was a set: a `/goal` command record right after it confirms a new setting. */
  private setting?: string;
  private promptAfterEnd = false;
  private pendingError?: string;
  /** A set record was read: the "Goal set: …" echo that follows it adds nothing. */
  private echoed?: string;

  /** Some goal record was read: the records read decide (never the probe before them). */
  get seen() { return !!this.state; }

  get current(): Omit<GoalObservation, 'source'> | undefined {
    const state = this.state;
    if (!state || state.status !== 'active' && this.promptAfterEnd) return;
    const { restated: _, ...goal } = state;
    return goal;
  }

  /** The projection's rows, in its order (MessageDisplay.applyRow). */
  ingest(rows: readonly TranscriptRow[]) {
    for (const row of rows) {
      // Only the next prompt-like record can confirm a setting (bookkeeping records may come between).
      const setting = this.setting, goal = row.goal, at = stamp(row.timestamp);
      if (row.type === 'user' || row.type === 'assistant') this.setting = undefined;
      if (row.kind === 'compact') { this.compactSince = true; continue; }
      // A goal_status record (goal-records.ts): neither a check-in nor Claude Code's own notice.
      if (goal && !row.goalEcho && goal.kind !== 'checkin' && goal.notice === undefined) { this.status(goal, at); continue; }
      if (goal && row.goalEcho) { this.echo(goal.condition ?? '', at); continue; }
      if (row.type === 'assistant') this.echoed = undefined;
      this.other(row, setting);
    }
  }

  private status(record: GoalEvent, at?: string) {
    const { kind, condition = '', reason, iterations, durationMs, tokens } = record;
    const met = kind === 'met' || kind === 'cleared', sentinel = kind === 'set' || kind === 'cleared', failed = kind === 'failed';
    const state = this.state, compacted = this.compactSince;
    this.compactSince = false;
    if (sentinel && !met) {
      // Restated after a compaction: the same goal goes on, its checks and reason kept (unless
      // the `/goal` command record follows: then it was set anew right after the compaction).
      this.echoed = condition;
      if (state?.status === 'active' && compacted && state.condition === condition) { this.setting = at ?? ''; return; }
      this.state = { status: 'active', phase: 'set', condition, checks: 0, ...!compacted && at && { setAt: at }, ...compacted && { restated: true } };
      this.setting = at ?? '';
      this.promptAfterEnd = false;
      this.pendingError = undefined;
      return;
    }
    const base = state?.condition === condition ? state : undefined;
    const ended = (status: 'met' | 'failed' | 'cleared', extra: Partial<State> = {}) => {
      this.state = { status, condition, checks: base?.checks ?? 0, ...base?.setAt && { setAt: base.setAt },
        ...base?.lastReason && { lastReason: base.lastReason }, ...at && { endedAt: at }, ...extra };
      this.promptAfterEnd = false;
    };
    if (sentinel) {
      ended('cleared', this.pendingError ? { notice: this.pendingError } : {});
      this.pendingError = undefined;
    } else if (met || failed) ended(met ? 'met' : 'failed', { result: { reason, iterations, durationMs, tokens } });
    else if (base?.status === 'active' || !base) {
      const checks = (base?.checks ?? 0) + 1;
      const { notice: _notice, deferred: _deferred, lastReason: _reason, ...kept } = base ?? {};
      this.state = { ...kept, status: 'active', condition, phase: 'not-met', checks, ...reason !== undefined && { lastReason: reason },
        ...at && { lastCheckAt: at } };
    }
  }

  /** A successful `/goal <condition>` whose set record was not read (a page read from the end stops at
   * the command, just after that record): the same setting, timed by the echo. */
  private echo(condition: string, at?: string) {
    if (this.echoed === condition) { this.echoed = undefined; return; }
    this.state = { status: 'active', phase: 'set', condition, checks: 0, ...at && { setAt: at } };
    this.setting = undefined;
    this.compactSince = false;
    this.promptAfterEnd = false;
    this.pendingError = undefined;
  }

  private other(row: TranscriptRow, setting?: string) {
    const state = this.state, at = stamp(row.timestamp), goal = row.goal;
    if (setting !== undefined && state?.status === 'active') {
      const args = goalArguments(row);
      // `/goal <condition>` right after its set record: a new setting, even after a compaction.
      if (args && !goalClearArguments.test(args)) {
        this.state = { status: 'active', phase: 'set', condition: state.condition, checks: 0, ...setting && { setAt: setting } };
        return;
      }
    }
    if (goal && goal.kind !== 'checkin') {
      // Claude Code's notice (system/informational): paused, retrying, or cleared by an error.
      if (goal.kind === 'cleared') {
        // Whichever comes first, the error's notice or the cleared record, they describe one clearing.
        if (state?.status === 'cleared' && !this.promptAfterEnd) state.notice = goal.notice;
        else this.pendingError = goal.notice;
      } else if (state?.status === 'active') {
        state.phase = goal.kind === 'paused' ? 'paused' : 'retrying';
        state.notice = goal.notice;
      }
      return;
    }
    if (goal) {
      // A check-in: the evaluation deferred while background work runs.
      const checkin = goal;
      if (state?.status !== 'active') return;
      const summary = checkin.notice ?? '';
      state.deferred = { ...at && { at }, ...checkin.minutes !== undefined && { minutes: checkin.minutes }, tasks: checkin.tasks ?? [], summary };
      state.phase = /continuing after/u.test(summary) ? 'retrying' : /no longer running/u.test(summary) ? state.checks ? 'not-met' : 'set' : 'deferred';
      return;
    }
    // A turn's start (isTranscriptTurnStart): a prompt, or a command other than /goal.
    if (!state || row.kind !== 'user' && row.kind !== 'command' || goalArguments(row) !== undefined) return;
    // The user's next message: an ended goal is history, a paused or retrying one goes on.
    if (state.status !== 'active') this.promptAfterEnd = true;
    else if (state.phase === 'paused' || state.phase === 'retrying') {
      state.phase = state.checks ? 'not-met' : 'set';
      delete state.notice;
    }
  }
}
