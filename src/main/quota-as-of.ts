// How recent the 5h and 7d figures of one Claude Code process are, for the
// "as of" line of their hover cards. Never later than the truth: every bound
// below is a time the figures are known to be at least as new as.
//
// What Claude Code does (2.1.300–2.1.330, read from the binaries):
// - It keeps the figures in the process's memory and sets them only from the
//   headers of its own API responses: replies of the main conversation, of its
//   subagents, side requests (titles, auto mode's check, compaction) and a small
//   quota request at startup. Nothing carries them from one process to the next
//   or between conversations, so two open conversations can disagree.
// - The statusLine command, which Lectern reads, runs again about 300 ms after a
//   new reply of the main conversation (or a token count) appears, after a
//   change of permission mode, model, effort or terminal size, and when a window
//   or the prompt cache expires. A subagent's or a side request's reply alone
//   does not run it: the figures it shows can be older than that reply.
//
// The rules, for the figures Lectern reads from one process (one settings handle):
// 1. They are at least as new as the process: its registration time.
// 2. They are at least as new as the main conversation's newest reply in the
//    transcript (assistant records, not synthetic or API error ones) once it is
//    SETTLE_MS old: by then the statusLine run it caused has been published.
//    The record's time is when Claude Code wrote its first block, a little after
//    the response's headers came; a long first block (thinking) is the margin.
//    Subagent transcripts are not used: their replies do not refresh what is shown.
// 3. Figures that changed since the last read are as new as this read when that
//    read was at most LIVE_GAP_MS ago and the main conversation got a new reply
//    within that time too: the reply refreshed them while Lectern watched. A change
//    without one comes from a run for another reason (size, mode, a timer) and can
//    show figures of an earlier subagent or startup request: no new bound.
// 4. Figures move forward only: what was known for the previous read still holds.
// Nothing of these, as on the first read of a process with no reply yet and no
// registration time: unknown, and the card says so instead of guessing.
//
// Transcript and registration times come from the target's clock, reads from this
// computer's; the result never passes the read itself. A session run by two
// processes at once (one outside Lectern) can lend this one the other's replies.

import type { NativeStatusLineObservation, SubscriptionWindow } from '../shared/types';

/** Reads further apart than this did not watch the figures change. */
export const LIVE_GAP_MS = 20_000;
/** A reply this recent may not have reached the statusLine output yet. */
export const SETTLE_MS = 5_000;

/** What one read of a process's figures established, kept for its next read. */
export interface QuotaSighting {
  /** Each window's figures as read, for comparison; absent when not reported. */
  figures: { fiveHour?: string; sevenDay?: string };
  /** When this read began (this computer's clock, ms). */
  readAt: number;
  /** The main conversation's newest reply at this read (its timestamp, ms). */
  reply?: number;
  /** When a read first found that reply (this computer's clock, ms); absent when the process's first read found it. */
  replySeenAt?: number;
  /** The figures are at least this recent (ms); absent: unknown. */
  asOf?: number;
}

export interface QuotaEvidence {
  /** The newest reply of the main conversation in its transcript (ms). */
  lastReply?: number;
  /** When the Claude Code process registered (ms). */
  processStart?: number;
}

const figure = (window?: SubscriptionWindow) => window && `${window.usedPercentage}@${window.resetsAt ?? ''}`;

/** The next sighting of a process's figures (`now`: when this read began). */
export function sightQuota(previous: QuotaSighting | undefined, line: Pick<NativeStatusLineObservation, 'fiveHour' | 'sevenDay'>,
  evidence: QuotaEvidence, now: number): QuotaSighting {
  const figures = { fiveHour: figure(line.fiveHour), sevenDay: figure(line.sevenDay) };
  const reported = figures.fiveHour !== undefined || figures.sevenDay !== undefined;
  const reply = evidence.lastReply;
  const replySeenAt = reply === undefined || !previous ? undefined : previous.reply === reply ? previous.replySeenAt : now;
  const bounds: number[] = [];
  if (previous?.asOf !== undefined) bounds.push(previous.asOf);
  if (reported && evidence.processStart !== undefined) bounds.push(evidence.processStart);
  if (reply !== undefined && reply <= now - SETTLE_MS) bounds.push(reply);
  // A window that is gone (its reset passed) is no new reading; one that appears or differs is.
  const changed = !!previous && (['fiveHour', 'sevenDay'] as const).some(name => figures[name] !== undefined && figures[name] !== previous.figures[name]);
  if (changed && now - previous!.readAt <= LIVE_GAP_MS && replySeenAt !== undefined && now - replySeenAt <= LIVE_GAP_MS) bounds.push(now);
  const asOf = bounds.length ? Math.min(now, Math.max(...bounds)) : undefined;
  return { figures, readAt: now, ...(reply !== undefined && { reply }), ...(replySeenAt !== undefined && { replySeenAt }), ...(asOf !== undefined && { asOf }) };
}
