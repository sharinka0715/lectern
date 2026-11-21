import type { SessionStatus } from '../shared/types';

export type NativeActivity = 'idle' | 'waiting' | 'busy' | 'shell';

/** A native waiting dialog owns input. An idle PID file can outlast a
 * successful response, an API error, or a turn still draining to disk. */
export function observedSessionStatus(display: SessionStatus, native?: NativeActivity, navigationError = false, delegated = false): SessionStatus {
  if (navigationError || display === 'error') return 'error';
  if (native === 'waiting') return 'waiting';
  // Claude Code stays busy after a finished turn while background subagents or
  // workflows run (delegated); the conversation itself is idle then.
  if (native === 'busy' && !(delegated && display === 'idle')) return 'working';
  return display;
}
