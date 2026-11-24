import type { GoalEvent } from '../shared/types';
import type { JsonRecord } from './jsonl';

/**
 * Claude Code's native /goal in its JSONL (2.1.300–2.1.331, same shapes throughout). The
 * authority is the `goal_status` attachment:
 *   set        {met:false, sentinel:true, condition}   (before the /goal command record)
 *   not met    {met:false, condition, reason}           (one per evaluation that said no)
 *   met        {met:true, condition, reason, iterations, durationMs, tokens}
 *   impossible {met:false, failed:true, condition, reason, iterations, durationMs, tokens}
 *   cleared    {met:true, sentinel:true, condition}     (/goal clear and aliases, the task
 *              panel's stop, an unrecoverable error; a busy clear writes only this)
 * A /compact writes the set shape again after its boundary while the goal is active. Pauses
 * and retries are system/informational notices ("Goal paused · …", "Goal still active · …");
 * a deferred check while background work runs comes back as a task notification (origin
 * source "goal-checkin", or a bare isMeta prompt at the end of a turn).
 */
const object = (v: unknown): JsonRecord => v && typeof v === 'object' && !Array.isArray(v) ? v as JsonRecord : {};
const text = (v: unknown, max = 8192) => typeof v === 'string' ? v.slice(0, max) : undefined;
const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
const contentText = (v: unknown) => typeof v === 'string' ? v
  : Array.isArray(v) ? v.map(object).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n') : '';

export { goalClearArguments } from '../shared/native-commands';

export interface GoalStatusRecord {
  met: boolean; sentinel: boolean; failed: boolean; condition: string;
  reason?: string; iterations?: number; durationMs?: number; tokens?: number;
}
/** A `goal_status` attachment of the main conversation, checked field by field. */
export function goalStatusOf(record: JsonRecord): GoalStatusRecord | undefined {
  if (record.type !== 'attachment' || record.isSidechain) return;
  const a = object(record.attachment);
  if (a.type !== 'goal_status' || typeof a.met !== 'boolean' || typeof a.condition !== 'string') return;
  return { met: a.met, sentinel: a.sentinel === true, failed: a.failed === true, condition: a.condition.slice(0, 8192),
    reason: text(a.reason), iterations: count(a.iterations), durationMs: count(a.durationMs), tokens: count(a.tokens) };
}

/** Claude Code's own notice about the goal (system/informational): paused, retrying, or cleared by an error. */
export function goalNoticeOf(content: string): GoalEvent | undefined {
  const notice = content.trim().slice(0, 4096);
  if (/^Goal paused(?: after \d+ automatic retries)? · \S/u.test(notice)) return { kind: 'paused', notice };
  if (/^Goal still active · \S/u.test(notice)) return { kind: 'retry', notice };
  // Its condition is cut to 80 characters: the cleared record that goes with it has the whole one.
  if (/^Goal cleared after an unrecoverable error\b[\s\S]*\bRun \/goal again to continue\.?$/u.test(notice)) return { kind: 'cleared', notice };
}

/**
 * A check-in Claude Code sends while background work holds the goal's evaluation back:
 * "<task-notification>\n<summary>Goal check-in: background work still running</summary>\n
 * </task-notification>\n<system-reminder>\nGoal check-in: «<condition>» is still active, and
 * evaluation has been deferred for 1 min because …:\n- <id> · shell · <command>\n…", or
 * the reminder's text alone (an isMeta prompt at the end of a turn). The other summaries:
 * "background work no longer running", "continuing after the last turn ended early" (a retry).
 */
export function goalCheckinOf(content: string): GoalEvent | undefined {
  const raw = content.trim();
  const wrapped = /^<task-notification>\s*<summary>(Goal check-in: [^<\n]*)<\/summary>\s*<\/task-notification>\s*(?:<system-reminder>\s*([\s\S]*?)\s*<\/system-reminder>)?\s*$/u.exec(raw);
  const body = wrapped ? wrapped[2] ?? '' : /^Goal check-in: «/u.test(raw) ? raw : undefined;
  if (body === undefined) return;
  const summary = wrapped?.[1].trim() ?? (/no longer running/u.test(body) ? 'Goal check-in: background work no longer running'
    : /ended before the goal could be evaluated/u.test(body) ? 'Goal check-in: continuing after the last turn ended early'
    : 'Goal check-in: background work still running');
  const minutes = Number(/\bdeferred for (\d{1,6}) min\b/u.exec(body)?.[1]);
  const tasks = body.split('\n').flatMap(line => /^- (\S.*)$/u.exec(line.trim())?.[1].slice(0, 400) ?? []).slice(0, 32);
  return { kind: 'checkin', notice: summary.slice(0, 400), condition: /«([\s\S]*?)»/u.exec(body)?.[1].slice(0, 8192),
    ...Number.isSafeInteger(minutes) && { minutes }, tasks };
}

/** The chat's goal event for a record, with Claude Code's own wording as plain `text`. */
export function goalEventOf(record: JsonRecord): { goal: GoalEvent; text: string } | undefined {
  const status = goalStatusOf(record);
  if (status) {
    const { condition, reason, iterations, durationMs, tokens } = status;
    const kind = status.sentinel ? status.met ? 'cleared' : 'set' : status.failed ? 'failed' : status.met ? 'met' : 'not-met';
    const goal: GoalEvent = { kind, condition, ...reason !== undefined && { reason },
      ...(kind === 'met' || kind === 'failed') && { iterations, durationMs, tokens } };
    const text = { set: 'Goal set', cleared: 'Goal cleared', failed: "Goal couldn't be achieved", met: 'Goal achieved', 'not-met': 'Goal not yet met' }[kind];
    return { goal, text: `${text}: ${kind === 'set' || kind === 'cleared' ? condition : reason ?? condition}` };
  }
  if (record.isSidechain) return;
  if (record.type === 'system' && record.subtype === 'informational' && typeof record.content === 'string') {
    const goal = goalNoticeOf(record.content);
    return goal && { goal, text: goal.notice! };
  }
}

/** A check-in record: delivered as a task notification (2.1.234+: origin source "goal-checkin"),
 * absorbed into a running turn (queued_command), an isMeta prompt, or (never seen, but never a
 * user's bubble either) the same text without any origin. A human's typed prompt is never one. */
export function goalCheckinRecord(record: JsonRecord): GoalEvent | undefined {
  if (record.isSidechain) return;
  const attached = object(record.attachment);
  if (record.type === 'attachment' && attached.type === 'queued_command'
    && (attached.commandMode === 'task-notification' || object(attached.origin).kind === 'task-notification')) return goalCheckinOf(contentText(attached.prompt));
  if (record.type !== 'user') return;
  const origin = object(record.origin).kind;
  if (origin !== 'task-notification' && record.isMeta !== true && (origin !== undefined || record.promptSource !== undefined)) return;
  return goalCheckinOf(contentText(object(record.message).content));
}

/** "Goal set: <condition>", what a successful `/goal <condition>` prints right after its command
 * record (a refused one prints its reason instead). Its own set record comes first, just before the
 * command, where a page read from the end can stop (the turn's prompt); the echo stands in for it. */
export function goalSetEcho(record: JsonRecord): string | undefined {
  if (record.type !== 'user' || record.isSidechain || record.isMeta) return;
  const match = /^<local-command-stdout>Goal set: ([\s\S]+)<\/local-command-stdout>$/u.exec(contentText(object(record.message).content).trim());
  return match?.[1].slice(0, 8192);
}
