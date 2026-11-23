import type { ChildProcess } from 'node:child_process';

/**
 * Ending an SSH client so that its target notices.
 *
 * Killing a local ssh client does not end the remote command: sshd keeps the
 * session (and its MaxSessions place) until the remote process exits, and an
 * OpenSSH mux client even waits for that before it exits itself. Lectern's remote
 * wrappers end their command when their input reaches EOF instead (`remoteRequest`
 * for one-off sessions, `channelScript` for command channels; a terminal link's
 * loop simply stops reading). Hanging up therefore closes the client's stdin and
 * lets the client exit once the remote session is over; only a client still
 * running after a grace period is killed, and its session may still be open on
 * the target (`whenGone` reports it as unconfirmed).
 */
export const hangUpGraceMs = 5000;

const forced = new WeakSet<ChildProcess>();
const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

export function hangUp(child: ChildProcess, graceMs = hangUpGraceMs): void {
  if (!running(child)) return;
  try { if (child.stdin && !child.stdin.writableEnded) child.stdin.end(); } catch { /* already closed */ }
  const timer = setTimeout(() => {
    if (!running(child)) return;
    forced.add(child);
    child.kill();
  }, graceMs);
  timer.unref?.();
  child.once('exit', () => clearTimeout(timer));
}

/**
 * Calls `done` once, when the client is gone: `confirmed` when it ended by itself
 * (its remote session closed first) or never started, not when hangUp had to kill it.
 */
export function whenGone(child: ChildProcess, done: (confirmed: boolean) => void): void {
  let called = false;
  const finish = (confirmed: boolean) => { if (!called) { called = true; done(confirmed); } };
  child.once('close', () => finish(!forced.has(child)));
  // A spawn failure: no process, no session.
  child.once('error', () => { if (child.pid === undefined) finish(true); });
}
