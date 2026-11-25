import type { GoalObservation } from '../shared/types';
import type { GoalIndicator } from '../core/goal-screen';

export interface GoalInputs {
  /** MessageDisplay.goal: the goal of the records read, or (`probe`) of the last goal record before
   * them (Backend.readGoalBefore) together with the records read after it. */
  records?: Omit<GoalObservation, 'source'>;
  source?: 'transcript' | 'probe';
  /** An active goal already shown for this conversation while the new page's prefix is unknown. */
  previous?: GoalObservation;
  /** A live Claude Code shows this conversation (its pane, the latest page read). */
  live: boolean;
  /** The indicator above its input box; `present` counts reads in a row that showed it, `absent`
   * reads in a row that showed the input box without it. */
  indicator?: GoalIndicator;
  present: number;
  absent: number;
  /** The spinner says a Stop hook runs (the evaluator, research §2). */
  checking: boolean;
}

/**
 * The goal the input area shows. The records say what the goal is and how its checks went;
 * with a live pane, the screen says whether it is still going: an indicator without an active
 * goal in the records read still shows one (its condition unknown), and an input box shown
 * twice in a row without the indicator ends an active one (a /rewind, hooks turned off, or a
 * clear whose record is not written yet). An ended goal stays until the next prompt.
 */
export function observeGoal(input: GoalInputs): GoalObservation | undefined {
  let goal: GoalObservation | undefined = input.records ? { ...input.records, source: input.source ?? 'transcript' } : undefined;
  if (!goal && !input.source && input.previous?.status === 'active') {
    const { screen: _screen, history: _history, ...previous } = input.previous;
    goal = previous;
  }
  if (!input.live) return goal?.status === 'active' ? { ...goal, history: true } : goal;
  const { indicator } = input;
  // Twice in a row: the indicator can outlast a goal's end by a repaint.
  if (indicator && input.present >= 2 && goal?.status !== 'active') goal = { status: 'active', condition: '', checks: 0, source: 'screen' };
  if (!indicator && goal?.status === 'active' && input.absent >= 2) return;
  if (goal?.status !== 'active') return goal;
  const phase = indicator?.state === 'paused' ? 'paused' : input.checking ? 'checking' : goal.phase ?? 'set';
  return { ...goal, phase, ...indicator && { screen: indicator } };
}
