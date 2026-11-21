import { createHash } from 'node:crypto';
import { quoteShell } from './transport';
import { t } from '../shared/i18n';

export const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type NativeStatus = 'idle' | 'busy' | 'waiting' | 'shell';
export interface NativePresence {
  sessionId: string;
  procStart: string;
  /** Immutable part of the verified interactive registration. Older records
   * can identify a live pane without supporting cache reuse across launches. */
  registrationId?: string;
  status?: NativeStatus;
  waitingFor?: string;
  /** When this Claude process registered (ms, the target's clock). */
  startedAt?: number;
}
export interface PresenceFrame { pid: number; start: string; domain: string; bytes: Buffer; fingerprint?: string }
const MAX_BYTES = 32 * 1024;

/** A present but malformed/stale record cannot authorize a legacy tmux binding. */
export function matchPresence(frame: PresenceFrame, tmuxTarget: string, cwdAliases: string[]): NativePresence | undefined {
  if (!frame.start || !frame.domain || !frame.bytes.length || frame.bytes.length > MAX_BYTES) return;
  try {
    const record = JSON.parse(frame.bytes.toString('utf8'));
    if (!record || record.pid !== frame.pid || typeof record.sessionId !== 'string' || !SESSION_UUID.test(record.sessionId)
      || record.procStart !== frame.start || (record.pidDomain !== undefined && record.pidDomain !== frame.domain)
      || record.kind !== 'interactive' || record.tmux !== tmuxTarget || !cwdAliases.includes(record.cwd)) return;
    const status = ['idle', 'busy', 'waiting', 'shell'].includes(record.status) ? record.status as NativeStatus : undefined;
    const waitingFor = status === 'waiting' && typeof record.waitingFor === 'string' && /^[^\x00-\x1f\x7f]{1,100}$/u.test(record.waitingFor) ? record.waitingFor : undefined;
    const sessionId = record.sessionId.toLowerCase();
    const completeDomain = frame.domain === 'darwin' || /^linux:[^:\s]+:pid:\[\d+\]$/.test(frame.domain);
    // Linux process start ticks are relative to boot. The native registration
    // time is an absolute clock value, set once even as status/cwd are updated.
    const registrationId = record.pidDomain === frame.domain && completeDomain && Number.isSafeInteger(record.startedAt) && record.startedAt > 0
      ? createHash('sha256').update(JSON.stringify([sessionId, tmuxTarget, frame.pid, frame.domain, frame.start, record.startedAt])).digest('hex')
      : undefined;
    const startedAt = Number.isSafeInteger(record.startedAt) && record.startedAt > 0 ? record.startedAt as number : undefined;
    return { sessionId, procStart: record.procStart, registrationId, status, waitingFor, startedAt };
  } catch { return; }
}

/** Claude Code 2.1.329 rewrites its record in place (new bytes, then truncate), so a
 * read can catch the new JSON followed by the old record's tail, e.g. `…833}47,
 * "waitingFor":"dialog open"}`; its own reader reads such a record again. An empty or
 * unparsable record of a live process is such a torn read, not a verdict on identity. */
export function tornPresence(frame: PresenceFrame): boolean {
  if (!frame.bytes.length) return true;
  try { JSON.parse(frame.bytes.toString('utf8')); return false; } catch { return true; }
}

/** Only named process IDs from the pane's foreground process tree are candidates.
 * No directory listing, peer credentials or sockets. Retain a physical directory
 * as cwd, then open each basename with O_NOFOLLOW and a fixed byte budget. */
export function presenceReadScript(claudeDir: string, pid?: number): string {
  if (pid !== undefined && (!Number.isSafeInteger(pid) || pid < 2)) throw new Error('Invalid native process ID');
  const pidExpression = pid ?? '$lectern_foreground';
  const perl = 'sysopen(my $fh, $ARGV[0], O_RDONLY|O_NOFOLLOW|O_NONBLOCK) or exit 1; -f $fh && -s $fh <= 32768 or exit 1; binmode $fh; my $n=sysread($fh,my $data,32769); defined($n) && $n <= 32768 or exit 1; print $data';
  return `(
    cd -P ${quoteShell(claudeDir.normalize('NFC'))} 2>/dev/null || exit 0
    lectern_registry="$(pwd -P)/sessions"
    if [ -L sessions ]; then printf 'unsafe-registry\\0'; exit 0; fi
    [ -d sessions ] || exit 0
    cd -P sessions && [ "$(pwd -P)" = "$lectern_registry" ] || { printf 'unsafe-registry\\0'; exit 0; }
    for lectern_pid in ${pidExpression}; do
      case "$lectern_pid" in ''|0*|*[!0-9]*) continue;; esac
      lectern_file="$lectern_pid.json"
      [ -e "$lectern_file" ] || [ -L "$lectern_file" ] || continue
      lectern_start='' lectern_domain=''
      if [ -f "/proc/$lectern_pid/stat" ]; then
        lectern_start=$(sed 's/^.*) //' "/proc/$lectern_pid/stat" | awk '{print $20}')
        lectern_domain="linux:$(cat /etc/machine-id 2>/dev/null):$(readlink /proc/self/ns/pid 2>/dev/null)"
      elif [ "$(uname -s)" = Darwin ]; then
        lectern_start=$(LC_ALL=C TZ=UTC ps -p "$lectern_pid" -o lstart= | sed 's/^ *//;s/ *$//')
        lectern_domain='darwin'
      fi
      printf '%s\\0%s\\0%s\\0' "$lectern_pid" "$lectern_start" "$lectern_domain"
      if [ -f "$lectern_file" ] && [ ! -L "$lectern_file" ]; then
        if [ -d /proc/self ] && dd --version >/dev/null 2>&1; then
          dd if="$lectern_file" iflag=nofollow,nonblock,fullblock bs=${MAX_BYTES + 1} count=1 2>/dev/null | base64
        elif command -v perl >/dev/null 2>&1; then
          perl -MFcntl=:DEFAULT -e ${quoteShell(perl)} "$lectern_file" 2>/dev/null | base64
        fi
      fi
      printf '\\0'
    done
  )`;
}

export function decodePresence(raw: string[]): { unsafe: boolean; frames: Map<number, PresenceFrame> } {
  const frames = new Map<number, PresenceFrame>();
  for (let i = 0; i + 3 < raw.length; i += 4) {
    if (!/^[1-9]\d*$/.test(raw[i])) continue;
    const pid = Number(raw[i]);
    frames.set(pid, { pid, start: raw[i + 1], domain: raw[i + 2], fingerprint: createHash('sha256').update(raw.slice(i, i + 4).join('\0') + '\0').digest('hex'), bytes: Buffer.from(raw[i + 3], 'base64') });
  }
  return { unsafe: raw[0] === 'unsafe-registry', frames };
}

/** Run in the same remote shell immediately before a destructive action.
 * Reject an intervening native write (including /clear) or reused PID.
 * No JSON parser or Claude executable is needed on the target. Input guards pass a
 * message that says no keys were sent, so their callers may read again and retry. */
export function presenceUnchangedGuard(claudeDir: string, pid: number, fingerprint: string, message = t('backend.presenceChanged')): string {
  if (!Number.isSafeInteger(pid) || pid < 2 || !/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error('Invalid native process identity');
  return `lectern_capture_presence() {
${presenceReadScript(claudeDir, pid)}
}
lectern_observed=$(lectern_capture_presence | { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; }
)
[ "\${lectern_observed%% *}" = ${quoteShell(fingerprint)} ] || { echo ${quoteShell(message)} >&2; exit 1; }`;
}
