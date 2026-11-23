import assert from 'node:assert/strict';
import test from 'node:test';
import { LIVE_GAP_MS, SETTLE_MS, sightQuota, type QuotaEvidence, type QuotaSighting } from '../src/main/quota-as-of';

// 2026-11-23 10:00:00 UTC, in ms.
const t0 = Date.UTC(2026, 10, 23, 10, 0);
const min = 60_000;
const five = (used: number, resetsAt = t0 / 1000 + 4 * 3600) => ({ fiveHour: { usedPercentage: used, resetsAt } });
const both = (used: number, week: number) => ({ ...five(used), sevenDay: { usedPercentage: week, resetsAt: t0 / 1000 + 3 * 86400 } });

/** Reads in order: each [figures, evidence, read time]; the sightings they leave. */
function reads(steps: [Parameters<typeof sightQuota>[1], QuotaEvidence, number][]) {
  const seen: QuotaSighting[] = [];
  for (const [line, evidence, now] of steps) seen.push(sightQuota(seen.at(-1), line, evidence, now));
  return seen;
}

test('figures read for the first time are never dated by the read', () => {
  // Nothing known: no reply in the transcript, no registration time.
  assert.equal(sightQuota(undefined, five(30), {}, t0).asOf, undefined);
  // The newest reply of the main conversation dates them.
  assert.equal(sightQuota(undefined, five(30), { lastReply: t0 - 90 * min }, t0).asOf, t0 - 90 * min);
  // A process started after that reply (a resumed conversation; Claude Code asks for its quota
  // at startup) has figures at least as new as itself.
  assert.equal(sightQuota(undefined, five(30), { lastReply: t0 - 3 * 86400_000, processStart: t0 - 20 * min }, t0).asOf, t0 - 20 * min);
  assert.equal(sightQuota(undefined, five(30), { lastReply: t0 - 5 * min, processStart: t0 - 20 * min }, t0).asOf, t0 - 5 * min);
  // Without figures the registration time says nothing about them.
  assert.equal(sightQuota(undefined, {}, { processStart: t0 - 20 * min }, t0).asOf, undefined);
});

test('a reply still settling into the status line is not counted yet', () => {
  const fresh = t0 - SETTLE_MS + 1000;
  const [first, later] = reads([[five(30), { lastReply: fresh, processStart: t0 - 30 * min }, t0], [five(30), { lastReply: fresh }, t0 + 2000]]);
  assert.equal(first.asOf, t0 - 30 * min, 'only the process start');
  assert.equal(later.asOf, fresh, 'settled on a later read, the figures unchanged');
});

test('a change seen live after a new reply is as new as the read that saw it', () => {
  const [, , changed, kept] = reads([
    [five(30), { lastReply: t0 - 60 * min }, t0],
    [five(30), { lastReply: t0 + 4000 }, t0 + 5000],
    // The status line ran again after the reply: the figures changed one read later.
    [five(31.5), { lastReply: t0 + 4000 }, t0 + 6000],
    [five(31.5), { lastReply: t0 + 4000 }, t0 + 60_000],
  ]);
  assert.equal(changed.asOf, t0 + 6000);
  assert.equal(kept.asOf, t0 + 6000, 'unchanged figures keep their time');
  // Either window counts, and so does the reset time alone.
  const [, other] = reads([[both(30, 50), { lastReply: t0 - min }, t0], [both(30, 51), { lastReply: t0 + 500 }, t0 + 1000]]);
  assert.equal(other.asOf, t0 + 1000);
  const [, reset] = reads([[five(30), { lastReply: t0 - min }, t0], [five(30, t0 / 1000 + 5 * 3600), { lastReply: t0 + 500 }, t0 + 1000]]);
  assert.equal(reset.asOf, t0 + 1000);
});

test('a change without a new reply is not dated by the read', () => {
  // A resize, a mode switch or a timer ran the status line: it can show figures of an
  // earlier subagent or side request. The previous bound and the evidence still hold.
  const [, changed] = reads([[five(30), { lastReply: t0 - 30 * min }, t0], [five(34), { lastReply: t0 - 30 * min }, t0 + 1000]]);
  assert.equal(changed.asOf, t0 - 30 * min);
  // The first figures of a process after its startup quota request, shown by such a run.
  const [none, appeared] = reads([[{}, { processStart: t0 - 10 * min }, t0], [five(30), { processStart: t0 - 10 * min }, t0 + 1000]]);
  assert.equal(none.asOf, undefined);
  assert.equal(appeared.asOf, t0 - 10 * min);
  // The first reply of a new conversation brings them: seen live.
  const [, first] = reads([[{}, { processStart: t0 - 10 * min }, t0], [five(30), { lastReply: t0 + 500, processStart: t0 - 10 * min }, t0 + 1000]]);
  assert.equal(first.asOf, t0 + 1000);
});

test('a change after a gap in the reads, or long after the reply, is not seen live', () => {
  const gap = LIVE_GAP_MS + 1000, reply = t0 + gap - SETTLE_MS - 1000;
  const [, late] = reads([[five(30), { lastReply: t0 - 30 * min }, t0], [five(40), { lastReply: reply }, t0 + gap]]);
  assert.equal(late.asOf, reply, 'the reply, not the read');
  // Reads every 10 s, but the reply came 22 s before the change.
  const [, , , stale] = reads([
    [five(30), { lastReply: t0 - 30 * min }, t0],
    [five(30), { lastReply: t0 + 1000 }, t0 + 2000],
    [five(30), { lastReply: t0 + 1000 }, t0 + 12_000],
    [five(40), { lastReply: t0 + 1000 }, t0 + 24_000],
  ]);
  assert.equal(stale.asOf, t0 + 1000);
});

test('a window that is gone is no new reading, and figures only move forward', () => {
  const [, gone, back] = reads([
    [both(30, 50), { lastReply: t0 - 30 * min }, t0],
    // The 5h window reset; Claude Code drops it and runs the status line again.
    [{ sevenDay: both(30, 50).sevenDay }, { lastReply: t0 - 30 * min }, t0 + 1000],
    [both(30, 50), { lastReply: t0 - 30 * min }, t0 + 2000],
  ]);
  assert.equal(gone.asOf, t0 - 30 * min);
  assert.equal(back.asOf, t0 - 30 * min);
  // An earlier bound survives evidence that is older (a transcript read again from its end).
  const [, kept] = reads([[five(30), { lastReply: t0 - 5 * min }, t0], [five(30), {}, t0 + 1000]]);
  assert.equal(kept.asOf, t0 - 5 * min);
});

test('the time never passes the read, whatever the target clock says', () => {
  assert.equal(sightQuota(undefined, five(30), { processStart: t0 + 10 * min }, t0).asOf, t0);
  const [, live] = reads([[five(30), {}, t0], [five(31), { lastReply: t0 + 3 * min }, t0 + 1000]]);
  assert.equal(live.asOf, t0 + 1000);
});
