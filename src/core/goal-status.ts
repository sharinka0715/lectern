import type { GoalObservation } from '../shared/types';
import type { JsonRecord } from './jsonl';
import { goalCheckinRecord, goalClearArguments, goalCommandArguments, goalNoticeOf, goalSetEcho, goalStatusOf } from './goal-records';
import { isTranscriptTurnStart } from './transcript-store';

const object = (v: unknown): JsonRecord => v && typeof v === 'object' && !Array.isArray(v) ? v as JsonRecord : {};
const stamp = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : undefined;
const contentText = (v: unknown) => typeof v === 'string' ? v
  : Array.isArray(v) ? v.map(object).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n') : '';

type State = Omit<GoalObservation, 'source' | 'screen' | 'history'> & { restated?: boolean };

/**
 * The session's goal from its records in order (Claude Code's own rule, research §3.8): the
 * last `goal_status` decides; met or failed means none is active. Like the activity card it
 * depends only on the records' order, never on how they were read (pages, small live reads),
 * and ignores sidechains and other sessions' records. An ended goal (met, failed, cleared)
 * stays the current one until the next human prompt, as the compaction receipt does.
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

  constructor(private readonly sessionId: string) {}

  /** Some goal record was read: the records read decide (never the probe before them). */
  get seen() { return !!this.state; }

  get current(): Omit<GoalObservation, 'source'> | undefined {
    const state = this.state;
    if (!state || state.status !== 'active' && this.promptAfterEnd) return;
    const { restated: _, ...goal } = state;
    return goal;
  }

  ingest(records: JsonRecord[]) {
    for (const r of records) {
      if (r.isSidechain || r.sessionId !== undefined && r.sessionId !== this.sessionId) continue;
      // Only the next prompt-like record can confirm a setting (bookkeeping records may come between).
      const setting = this.setting;
      if (r.type === 'user' || r.type === 'assistant') this.setting = undefined;
      if (r.type === 'system' && r.subtype === 'compact_boundary') { this.compactSince = true; continue; }
      const status = goalStatusOf(r);
      if (status) { this.status(status, stamp(r.timestamp)); continue; }
      const echo = goalSetEcho(r);
      if (echo !== undefined) { this.echo(echo, stamp(r.timestamp)); continue; }
      if (r.type === 'assistant') this.echoed = undefined;
      this.other(r, setting);
    }
  }

  private status(record: NonNullable<ReturnType<typeof goalStatusOf>>, at?: string) {
    const { met, sentinel, failed, condition, reason, iterations, durationMs, tokens } = record;
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

  private other(r: JsonRecord, setting?: string) {
    const state = this.state, at = stamp(r.timestamp);
    if (setting !== undefined && state?.status === 'active') {
      const args = goalCommandArguments(r);
      // `/goal <condition>` right after its set record: a new setting, even after a compaction.
      if (args && !goalClearArguments.test(args)) {
        this.state = { status: 'active', phase: 'set', condition: state.condition, checks: 0, ...setting && { setAt: setting } };
        return;
      }
    }
    if (r.type === 'system' && r.subtype === 'informational' && typeof r.content === 'string') {
      const notice = goalNoticeOf(r.content);
      if (notice?.kind === 'cleared') {
        // Whichever comes first, the error's notice or the cleared record, they describe one clearing.
        if (state?.status === 'cleared' && !this.promptAfterEnd) state.notice = notice.notice;
        else this.pendingError = notice.notice;
      } else if (notice && state?.status === 'active') {
        state.phase = notice.kind === 'paused' ? 'paused' : 'retrying';
        state.notice = notice.notice;
      }
      return;
    }
    const checkin = goalCheckinRecord(r);
    if (checkin) {
      if (state?.status !== 'active') return;
      const summary = checkin.notice ?? '';
      state.deferred = { ...at && { at }, ...checkin.minutes !== undefined && { minutes: checkin.minutes }, tasks: checkin.tasks ?? [], summary };
      state.phase = /continuing after/u.test(summary) ? 'retrying' : /no longer running/u.test(summary) ? state.checks ? 'not-met' : 'set' : 'deferred';
      return;
    }
    if (!state || !isTranscriptTurnStart(r, this.sessionId) || goalCommandArguments(r) !== undefined) return;
    // The user's next message: an ended goal is history, a paused or retrying one goes on.
    if (state.status !== 'active') this.promptAfterEnd = true;
    else if (state.phase === 'paused' || state.phase === 'retrying') {
      state.phase = state.checks ? 'not-met' : 'set';
      delete state.notice;
    }
  }
}
