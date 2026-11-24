import { quoteShell as q } from './transport';
import type { DialogHookObservation, DialogHookRecord } from '../shared/dialog-hooks';

/**
 * Claude Code hooks that only record (Settings → Session, off unless turned on): each call
 * leaves its stdin, the JSON Claude Code hands the hook, as one file in a private folder of
 * this launch, `${TMPDIR:-/tmp}/lectern-hooks-<uid>/<nonce>/`; the session poll reads the
 * new files back and deletes them (readDialogHooks). A hook prints nothing and always exits 0:
 * Claude Code then leaves no trace of it on screen or in the transcript, and its decision and
 * the tool's input are its own. Claude Code 2.1.300–2.1.331 measured
 * (scripts/cc-matrix and the hook probe described in CLAUDE.md).
 */
export const DIALOG_HOOK_EVENTS = ['PreToolUse', 'PermissionRequest', 'SessionStart'] as const;
export type DialogHookEvent = typeof DIALOG_HOOK_EVENTS[number];
/** The pane option holding this launch's hook folder (set by the launch prefix). */
export const dialogHookOption = '@lectern_hooks_dir';
const noncePattern = /^[0-9a-f]{32}$/;
/** A hook's stdin is kept up to this size; a larger one is cut and no longer valid JSON. */
export const HOOK_FILE_LIMIT = 1024 * 1024;
/** What one poll reads back: at most this many files and, past the first, this many bytes. */
export const HOOK_READ_FILES = 32;
export const HOOK_READ_BYTES = 1024 * 1024;
/** Only AskUserQuestion's PreToolUse: its tool_use_id names the question card's call, and a
 * PreToolUse hook on a tool makes Claude Code write a streamed call to the transcript about
 * 120 ms after the stream ends instead of once its dialog is answered. Only for the tools it
 * matches: a Bash call still waits for its answer under this matcher (2.1.300, 2.1.321 and
 * 2.1.331 measured). Permission cards do without the call's id until the transcript has it
 * (main/session-permission.ts earlyPermission), and every other tool call is spared a
 * synchronous shell (15–25 ms) and the telemetry of one more hook. */
export const PRE_TOOL_USE_MATCHER = 'AskUserQuestion';

/** The command one hook runs: its stdin into a new file of the launch's folder when that is a
 * real folder of this user, else read and dropped; nothing printed, exit 0 whatever happens
 * (a failing or missing command shows "hook error" lines on screen). */
export function dialogHookCommand(nonce: string, event: DialogHookEvent): string {
  if (!noncePattern.test(nonce) || !DIALOG_HOOK_EVENTS.includes(event)) throw new Error('Invalid dialog hook');
  return `{ d="\${TMPDIR:-/tmp}"; d="\${d%/}/lectern-hooks-$(id -u)/${nonce}"; umask 077; `
    + `if [ -d "$d" ] && [ -O "$d" ] && [ ! -L "$d" ] && f=$(mktemp "$d/.${event}.XXXXXXXX"); then `
    + `head -c ${HOOK_FILE_LIMIT} > "$f"; cat > /dev/null; mv -f "$f" "$d/$(date +%s)-$$-${event}.json" || rm -f "$f"; `
    + `else cat > /dev/null; fi; } > /dev/null 2>&1; exit 0`;
}

/** The `hooks` of the launch's `--settings`: synchronous, 5 s at most. They are added to the
 * user's own hooks; `disableAllHooks` (and managed `allowManagedHooksOnly`) turn them off. */
export function dialogHookSettings(nonce: string) {
  const hooks = (event: DialogHookEvent) => [{ type: 'command', command: dialogHookCommand(nonce, event), timeout: 5 }];
  return {
    PreToolUse: [{ matcher: PRE_TOOL_USE_MATCHER, hooks: hooks('PreToolUse') }],
    PermissionRequest: [{ hooks: hooks('PermissionRequest') }],
    SessionStart: [{ hooks: hooks('SessionStart') }],
  };
}

/**
 * Shell run in the pane before `exec claude` (the launch environment, local or over SSH alike):
 * the per-user base folder must be a real folder of this user (made private), folders older
 * than 7 days are swept, then this launch's folder is made and named in a pane option for the
 * poll (only inside tmux: never another server's current pane). Anything failing leaves no
 * folder: the hooks then drop what they get and Lectern reads the screen as without them;
 * Claude Code starts either way.
 */
export function dialogHookPrefix(nonce: string): string {
  if (!noncePattern.test(nonce)) throw new Error('Invalid dialog hook nonce');
  return `lectern_hooks=$(umask 077; b="\${TMPDIR:-/tmp}"; b="\${b%/}/lectern-hooks-$(id -u)"; mkdir -p "$b" 2>/dev/null; `
    + `if [ -d "$b" ] && [ ! -L "$b" ] && [ -O "$b" ] && chmod 700 "$b" 2>/dev/null; then `
    + `find "$b" -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null; `
    + `mkdir "$b/${nonce}" 2>/dev/null && printf '%s' "$b/${nonce}"; fi); `
    + `if [ -n "$lectern_hooks" ] && [ -n "\${TMUX:-}" ] && [ -n "\${TMUX_PANE:-}" ]; then tmux set-option -p -t "$TMUX_PANE" ${dialogHookOption} "$lectern_hooks" 2>/dev/null; fi; `;
}

/** The pane option's folder when it is this launch's (`nonce`, verified with the status line
 * registration): an absolute path ending in `lectern-hooks-<uid>/<nonce>`. */
export function dialogHookDir(raw: string | undefined, nonce: string | undefined): string | undefined {
  if (!raw || !nonce || !noncePattern.test(nonce) || raw.length > 1024 || /[\x00-\x1f\x7f]/.test(raw)) return;
  const parts = raw.split('/');
  if (parts[0] !== '' || parts.slice(1).some(part => !part || part === '.' || part === '..')) return;
  return parts.at(-1) === nonce && /^lectern-hooks-\d{1,10}$/.test(parts.at(-2) ?? '') ? raw : undefined;
}

/** Part of the poll, after the screen capture (a dialog on that screen had its hook files
 * written before it was drawn): the folder's new files oldest first, each as "<name> <size>"
 * and its base64, at most HOOK_READ_FILES and, past the first, HOOK_READ_BYTES; each one read
 * is deleted, except that the newest SessionStart is kept as `.started` and sent again when
 * `started` asks for it (after Lectern restarts). First line "ok" or "missing". */
export function readDialogHooks(dir: string, started: boolean): string {
  return `(
d=${q(dir)}
if [ -d "$d" ] && [ -O "$d" ] && [ ! -L "$d" ] && cd "$d" 2>/dev/null; then printf 'ok\\n'; else printf 'missing\\n'; exit 0; fi
if [ ${started ? 1 : 0} = 1 ] && [ -f .started ] && [ ! -L .started ]; then
 printf '.started %s\\n' "$(wc -c < .started | tr -d ' ')"; base64 < .started | tr -d '\\r\\n'; printf '\\n'
fi
n=0; total=0
for f in $(ls -tr 2>/dev/null); do
 case "$f" in ([0-9]*-[0-9]*-PreToolUse.json|[0-9]*-[0-9]*-PermissionRequest.json|[0-9]*-[0-9]*-SessionStart.json) ;; (*) continue;; esac
 [ -f "$f" ] && [ ! -L "$f" ] || continue
 size=$(wc -c < "$f" | tr -d ' ')
 [ "$n" -lt ${HOOK_READ_FILES} ] || break
 [ "$n" -eq 0 ] || [ $((total + size)) -le ${HOOK_READ_BYTES} ] || break
 printf '%s %s\\n' "$f" "$size"; base64 < "$f" | tr -d '\\r\\n'; printf '\\n'
 case "$f" in (*-SessionStart.json) mv -f "$f" .started;; (*) rm -f "$f";; esac
 n=$((n + 1)); total=$((total + size))
done
)`;
}

/** Removes a launch's folder once its process is gone or replaced. */
export function removeDialogHookDir(dir: string): string {
  return `d=${q(dir)}; if [ -d "$d" ] && [ -O "$d" ] && [ ! -L "$d" ]; then rm -rf "$d"; fi; exit 0`;
}

const fileName = /^(\d{1,12})-\d{1,10}-(PreToolUse|PermissionRequest|SessionStart)\.json$/;
const toolUseIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const label = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined;

/** One file as a record, or undefined when it is not a complete hook call of this session:
 * valid JSON whose hook_event_name is the file's event and whose session_id is `sessionId`;
 * tool events with a tool name and an object input; PreToolUse with its tool_use_id. */
export function decodeDialogHookFile(name: string, data: Buffer, sessionId: string): Omit<DialogHookRecord, 'seq'> | undefined {
  const match = name === '.started' ? ['', '0', 'SessionStart'] : fileName.exec(name);
  if (!match || data.length > HOOK_FILE_LIMIT) return;
  let value: unknown;
  try { value = JSON.parse(data.toString('utf8')); } catch { return; }
  const event = match[2] as DialogHookRecord['event'];
  if (!plain(value) || value.hook_event_name !== event || typeof value.session_id !== 'string'
    || value.session_id.toLowerCase() !== sessionId.toLowerCase()) return;
  const at = Number(match[1]);
  const agentId = label(value.agent_id);
  if (event === 'SessionStart') return { event, at, ...label(value.source) && { source: label(value.source) } };
  const toolName = label(value.tool_name), input = value.tool_input;
  if (!toolName || !plain(input)) return;
  const toolUseId = typeof value.tool_use_id === 'string' && toolUseIdPattern.test(value.tool_use_id) ? value.tool_use_id : undefined;
  if (event === 'PreToolUse' && !toolUseId) return;
  return { event, at, toolName, input, ...toolUseId && { toolUseId }, ...agentId && { agentId } };
}

/** The read's section as files: after the status line, "<name> <size>" and base64 lines. */
export function decodeDialogHookFrame(frame: string): { folder: boolean; files: { name: string; data: Buffer }[] } {
  const lines = frame.split('\n');
  const files: { name: string; data: Buffer }[] = [];
  for (let i = 1; i + 1 < lines.length; i += 2) {
    const head = /^(\S+) (\d{1,8})$/.exec(lines[i]), encoded = lines[i + 1];
    if (!head || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) break;
    const data = Buffer.from(encoded, 'base64');
    if (data.length !== Number(head[2])) break;
    files.push({ name: head[1], data });
  }
  return { folder: lines[0] === 'ok', files };
}

/** Records kept per launch: the open dialog's are among the newest few. */
const KEEP_RECORDS = 64;
interface Launch { dir: string; seq: number; records: DialogHookRecord[]; started?: DialogHookObservation['started']; last?: DialogHookObservation['last']; rejected: number; folder: boolean }

/** What each session's current launch delivered, kept across reads (and across switching
 * conversations) in memory: the poll deletes the files it reads. */
export class DialogHookStore {
  private readonly launches = new Map<string, Launch>();
  /** The session's launch folder now (undefined: none). Returns the previous folder when it
   * changed, for the caller to remove: that process is gone or was replaced. */
  bind(key: string, dir: string | undefined): string | undefined {
    const current = this.launches.get(key);
    if (current?.dir === dir) return;
    if (dir) this.launches.set(key, { dir, seq: 0, records: [], rejected: 0, folder: true });
    else this.launches.delete(key);
    return current?.dir;
  }
  /** Whether the read should send the kept SessionStart again (none seen in this launch yet). */
  wantsStarted(key: string): boolean { return !this.launches.get(key)?.started; }
  ingest(key: string, dir: string, frame: string, sessionId: string): void {
    const launch = this.launches.get(key);
    if (!launch || launch.dir !== dir) return;
    const { folder, files } = decodeDialogHookFrame(frame);
    launch.folder = folder;
    for (const file of files) {
      const record = decodeDialogHookFile(file.name, file.data, sessionId);
      if (!record) { launch.rejected++; continue; }
      if (record.event === 'SessionStart') {
        // The kept copy has no time of its own: a later start keeps the newer one.
        if (file.name !== '.started' || !launch.started) launch.started = { at: record.at, ...record.source && { source: record.source } };
        if (file.name === '.started') continue;
      }
      const seq = ++launch.seq;
      launch.records.push({ ...record, seq });
      launch.last = { event: record.event, ...record.toolName && { toolName: record.toolName }, at: record.at };
    }
    if (launch.records.length > KEEP_RECORDS) launch.records.splice(0, launch.records.length - KEEP_RECORDS);
  }
  observe(key: string): DialogHookObservation | undefined {
    const launch = this.launches.get(key);
    return launch && { folder: launch.folder, records: [...launch.records], rejected: launch.rejected,
      ...launch.started && { started: launch.started }, ...launch.last && { last: launch.last } };
  }
  dir(key: string): string | undefined { return this.launches.get(key)?.dir; }
}
