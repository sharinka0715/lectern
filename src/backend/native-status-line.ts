import type { NativeStatusLineObservation } from '../shared/types';
import { SESSION_UUID } from './native-presence';
import { customRouteCase } from './endpoint-billing';
import { quoteShell as q } from './transport';

const limit = 24 * 1024;
const encodedLimit = limit / 3 * 4;
export const statusLineMarker = '@lectern_status_launch';
const samplePrefix = '@lectern_status_';
const noncePattern = /^[0-9a-f]{32}$/;

function processStart(pid: string): string {
  return `if [ -r "/proc/${pid}/stat" ]; then sed 's/^.*) //' "/proc/${pid}/stat" | awk '{print $20}'; else LC_ALL=C TZ=UTC ps -p "${pid}" -o lstart= | sed 's/^ *//;s/ *$//'; fi`;
}

// The pane option holds only the latest callback and disappears with the pane.
// Send data to tmux on stdin: native JSON must stay out of process arguments.
export function statusLineLaunch(sessionId: string, nonce: string, tmuxVersion: string) {
  if (!SESSION_UUID.test(sessionId) || !noncePattern.test(nonce)) throw new Error('Invalid status line registration');
  const owner = `@lectern_status_writer_${nonce}`, option = samplePrefix + nonce;
  // Starting in 3.1, source-file recognizes "-" as the invoking client's stdin.
  // On 3.0a it is a literal filename, which must never be opened incidentally.
  const version = /^tmux (\d+)\.(\d+)[a-z]?$/.exec(tmuxVersion);
  const stdinSource = version && (+version[1] > 3 || (+version[1] === 3 && +version[2] >= 1));
  const publish = stdinSource ? 'status_record | tmux source-file -' : `umask 077
    tmp=$(mktemp /tmp/lectern-status.XXXXXXXXXX) || exit 0
    trap 'rm -f "$tmp"' EXIT
    trap 'exit 0' HUP INT TERM
    status_record > "$tmp" && tmux source-file "$tmp"`;
  const command = `(
    export LC_ALL=C
    pane=\${TMUX_PANE:-}
    case "$pane" in (%*) ;; (*) exit 0;; esac
    case "\${pane#%}" in (''|*[!0-9]*) exit 0;; esac
    tmux set-option -p -t "$pane" ${owner} "$$" || exit 0
    sample=$(head -c ${limit + 1} | base64 | tr -d '\\r\\n')
    if [ -z "$sample" ] || [ "\${#sample}" -gt ${encodedLimit} ]; then sample=invalid; fi
    ${customRouteCase}
    if [ "$custom" = 1 ]; then sample="custom:$sample"; fi
    status_record() {
      printf 'if-shell -F -t %s "#{==:#{${owner}},%s}" "set-option -p -t %s ${option} %s"\\n' "$pane" "$$" "$pane" "$sample"
    }
    ${publish}
  ) >/dev/null 2>&1`;
  // Store the OS process start value before exec, bound to this server and pane.
  const register = `lectern_birth=$( ${processStart('$$')} ); tmux set-option -pF -t "$TMUX_PANE" ${statusLineMarker} "#{pid}:#{start_time},#{pane_id},#{pane_pid},$$,${sessionId},$lectern_birth,${nonce}"`;
  return { register, settings: JSON.stringify({ statusLine: { type: 'command', command } }) };
}

// Read only the selected pane's sample in the existing poll. The probe that
// follows independently checks its marker and the foreground/native identity.
export function readStatusLineSample(paneId?: string, socket?: string): string {
  if (!paneId || !/^%\d+$/.test(paneId)) return "printf '\\0'";
  const show = ['tmux', ...(socket ? ['-L', socket] : []), 'show-options', '-pqv', '-t', paneId].map(q).join(' ');
  return `(
  marker=$(${show} ${statusLineMarker} 2>/dev/null | head -c 256)
  nonce=\${marker##*,}
  case "$nonce" in (''|*[!0-9a-f]*) exit 0;; esac
  [ "\${#nonce}" -eq 32 ] || exit 0
  launch_pid=$(printf '%s' "$marker" | awk -F, 'NF==7 && $4 ~ /^[1-9][0-9]*$/ {print $4}')
  [ -n "$launch_pid" ] || exit 0
  birth=$( ${processStart('$launch_pid')} )
  [ -n "$birth" ] || exit 0
  case "$marker" in (*,"$birth","$nonce") ;; (*) exit 0;; esac
  printf '%s,' "$nonce"
  ${show} "${samplePrefix}$nonce" 2>/dev/null | head -c ${encodedLimit + 9}
)
printf '\\0'`;
}

interface StatusPane {
  id: string; pid: number; claudePid?: number; serverInstance?: string; boundSessionId?: string;
  managed: boolean; active: boolean; statusMarker?: string; forkOrigin?: string; native?: { procStart: string; sessionId?: string };
}

export function statusLineRegistration(pane: StatusPane, verifiedNonce?: string): string | undefined {
  if (!pane.active || !pane.managed || !pane.claudePid || !pane.statusMarker || !pane.serverInstance) return;
  const [server, id, root, pid, origin, birth, nonce, ...extra] = pane.statusMarker.split(',');
  if (extra.length || server !== pane.serverInstance || id !== pane.id || root !== String(pane.pid) ||
    pid !== String(pane.claudePid) || (origin !== pane.boundSessionId && !(pane.forkOrigin && pane.native?.sessionId === pane.boundSessionId)) || !SESSION_UUID.test(origin) ||
    !birth || (pane.native ? birth !== pane.native.procStart : verifiedNonce !== nonce) || !noncePattern.test(nonce)) return;
  return nonce;
}

function label(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256 &&
    !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(value) ? value.trim() : undefined;
}
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function percentage(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}
// Native statusLine timestamps are in seconds. Never silently treat milliseconds as seconds.
function epochSeconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 253402300799 ? value : undefined;
}
function quotaWindow(raw: { used_percentage?: unknown; resets_at?: unknown } | undefined) {
  const usedPercentage = percentage(raw?.used_percentage), resetsAt = epochSeconds(raw?.resets_at);
  return usedPercentage === undefined ? undefined : { usedPercentage, ...(resetsAt !== undefined && { resetsAt }) };
}

export function decodeStatusLineSample(frame: string, nonce: string, sessionId: string): NativeStatusLineObservation | undefined {
  if (!noncePattern.test(nonce) || !frame.startsWith(nonce + ',')) return;
  const payload = frame.slice(nonce.length + 1).replace(/\n$/, '');
  const customRoute = payload.startsWith('custom:');
  const encoded = customRoute ? payload.slice(7) : payload;
  if (!encoded || encoded.length > encodedLimit || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return;
  try {
    const data = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    if (typeof data?.session_id !== 'string' || !SESSION_UUID.test(data.session_id) || data.session_id.toLowerCase() !== sessionId.toLowerCase()) return;
    const modelId = label(data.model?.id);
    if (!modelId) return;
    const result: NativeStatusLineObservation = { sessionId, modelId };
    const modelName = label(data.model?.display_name), effort = label(data.effort?.level);
    if (modelName) result.modelName = modelName;
    if (effort) result.effort = effort;
    if (typeof data.version === 'string' && /^\d+\.\d+\.\d+[\w.+-]{0,24}$/.test(data.version)) result.version = data.version;
    const context = data.context_window, capacity = count(context?.context_window_size), used = percentage(context?.used_percentage);
    if (capacity) result.contextWindowSize = capacity;
    if (used !== undefined) result.usedPercentage = used;
    const cache = data.prompt_cache;
    if (cache && typeof cache === 'object' && !Array.isArray(cache)) {
      const expiresAt = epochSeconds(cache.expires_at);
      result.promptCache = {
        ...(expiresAt !== undefined && { expiresAt }),
        ...((cache.ttl === '5m' || cache.ttl === '1h') && { ttl: cache.ttl }),
        ...(typeof cache.warm === 'boolean' && { warm: cache.warm }),
        ...(typeof cache.caching_observed === 'boolean' && { cachingObserved: cache.caching_observed }),
      };
    }
    const limits = data.rate_limits;
    if (limits?.spend_limit && typeof limits.spend_limit === 'object' && !Array.isArray(limits.spend_limit)) result.nonSubscriptionRoute = 'gateway';
    else if (customRoute) result.nonSubscriptionRoute = 'custom';
    else {
      const five = quotaWindow(limits?.five_hour), week = quotaWindow(limits?.seven_day);
      if (five) result.fiveHour = five;
      if (week) result.sevenDay = week;
    }
    const usage = context?.current_usage;
    const input = count(usage?.input_tokens), read = count(usage?.cache_read_input_tokens), write = count(usage?.cache_creation_input_tokens);
    if (input !== undefined && read !== undefined && write !== undefined && Number.isSafeInteger(input + read + write)) result.inputTokens = input + read + write;
    return result;
  } catch { return; }
}
