import { activityTaskId } from '../core/session-activity';
import { SESSION_UUID } from './native-presence';
import { quoteShell as q } from './transport';

// Claude Code 2.1.300–2.1.330 write a background shell's (and a monitor's) output to
// /tmp/claude-<uid>/<project slug>/<session>/tasks/<task id>.output (CLAUDE_CODE_TMPDIR
// replaces /tmp), stdout and stderr together, ending with "[exited with code N]" or
// "[killed]". Only names built from the checked session UUID and task ID are opened:
// never the <output-file> path in the transcript. A subagent's .output is a symlink
// to its transcript and is refused here like any link.

export interface TaskOutputWindow {
  /** The stamp (inode:size:mtime) the caller holds: unchanged files send no bytes. */
  known?: string;
  /** Append from this offset (live). More than `appendLimit` new bytes reads the tail instead. */
  from?: number;
  /** An older page: the `limit` bytes before this offset. */
  before?: number;
  limit: number;
  appendLimit?: number;
}
export type TaskOutputRead =
  | { found: false }
  | { found: true; stamp: string; inode: string; size: number; unchanged: true }
  | { found: true; stamp: string; inode: string; size: number; unchanged?: false; start: number; mode: 'tail' | 'from' | 'before'; bytes: Buffer };

const DEFAULT_ROOTS = ['"/tmp/claude-$lectern_uid"', '${CLAUDE_CODE_TMPDIR:+"$CLAUDE_CODE_TMPDIR/claude-$lectern_uid"}'];
const int = (value: number | undefined) => value !== undefined && Number.isSafeInteger(value) && value >= 0 ? String(value) : '';

/** One read of a task's output file. `roots` replaces the temporary roots in tests (literal paths). */
export function taskOutputScript(projectDirs: string[], sessionId: string, taskId: string, window: TaskOutputWindow, roots?: string[]): string {
  if (!SESSION_UUID.test(sessionId) || !activityTaskId(taskId)) throw new Error('Invalid task output');
  const limit = Math.max(1, Math.min(8 * 1024 * 1024, Math.floor(window.limit)));
  const slugs = [...new Set(projectDirs.map(dir => dir.slice(dir.lastIndexOf('/') + 1)))].filter(slug => slug && slug !== '.' && slug !== '..');
  const bases = roots ? roots.map(root => q(root)) : DEFAULT_ROOTS;
  const known = /^\d+:\d+:\d+$/.test(window.known ?? '') ? window.known! : '';
  // Read whole: sysread may return less than asked.
  const perl = 'sysopen(my $f,$ARGV[0],O_RDONLY|O_NOFOLLOW|O_NONBLOCK) or exit; -f $f or exit; binmode $f; sysseek($f,$ARGV[1],0); my $left=$ARGV[2]; while ($left > 0) { my $n=sysread($f,my $b,$left > 65536 ? 65536 : $left); last unless $n; print $b; $left-=$n }';
  return `lectern_uid=$(id -u)
lectern_file=${q(taskId + '.output')}
lectern_task_read() (
  lectern_dir=$1
  [ -d "$lectern_dir" ] || exit 1
  # Start at the physical root (macOS's /tmp alias is fine); no links below it.
  lectern_base="\${lectern_dir%/*/*/*}"
  lectern_suffix="\${lectern_dir#"$lectern_base"/}"
  [ ! -L "$lectern_base" ] && cd -P "$lectern_base" 2>/dev/null || exit 1
  lectern_base=$(pwd -P)
  cd -P "./$lectern_suffix" 2>/dev/null && [ "$(pwd -P)" = "\${lectern_base%/}/$lectern_suffix" ] || exit 1
  [ -f "$lectern_file" ] && [ ! -L "$lectern_file" ] || exit 1
  lectern_meta=$(stat -f '%i:%z:%m' "$lectern_file" 2>/dev/null) || lectern_meta=$(stat -c '%i:%s:%Y' "$lectern_file" 2>/dev/null) || exit 1
  case "$lectern_meta" in *[!0-9:]*|'') exit 1;; esac
  printf 'found\\0%s\\0' "$lectern_meta"
  if [ "$lectern_meta" = ${q(known)} ]; then printf 'same\\0'; exit 0; fi
  lectern_size=\${lectern_meta#*:}; lectern_size=\${lectern_size%:*}
  lectern_from=${q(int(window.from))}; lectern_before=${q(int(window.before))}; lectern_limit=${limit}; lectern_append=${int(window.appendLimit) || limit}
  if [ -n "$lectern_before" ]; then
    lectern_mode=before; lectern_end=$lectern_before; [ "$lectern_end" -le "$lectern_size" ] || lectern_end=$lectern_size
    lectern_start=$((lectern_end > lectern_limit ? lectern_end - lectern_limit : 0))
  elif [ -n "$lectern_from" ] && [ "$lectern_from" -le "$lectern_size" ] && [ $((lectern_size - lectern_from)) -le "$lectern_append" ]; then
    lectern_mode=from; lectern_start=$lectern_from; lectern_end=$lectern_size
  else
    lectern_mode=tail; lectern_end=$lectern_size; lectern_start=$((lectern_size > lectern_limit ? lectern_size - lectern_limit : 0))
  fi
  printf '%s\\0%s\\0' "$lectern_start" "$lectern_mode"
  lectern_count=$((lectern_end - lectern_start))
  [ "$lectern_count" -gt 0 ] || exit 0
  # GNU dd and the system Perl on macOS both open the leaf without following links,
  # nonblocking, so a FIFO put in its place cannot hang the read.
  if [ -d /proc/self ] && dd --version >/dev/null 2>&1; then
    dd if="$lectern_file" iflag=nofollow,nonblock,skip_bytes,count_bytes skip="$lectern_start" count="$lectern_count" bs=65536 2>/dev/null
  elif command -v perl >/dev/null 2>&1; then
    perl -MFcntl=:DEFAULT -e ${q(perl)} "$lectern_file" "$lectern_start" "$lectern_count" 2>/dev/null
  fi
  exit 0
)
for lectern_root in ${bases.join(' ')}; do
  for lectern_slug in ${slugs.length ? slugs.map(slug => q(slug)).join(' ') : "''"}; do
    [ -n "$lectern_slug" ] || continue
    lectern_task_read "$lectern_root/$lectern_slug/"${q(sessionId + '/tasks')} && exit 0
  done
done
exit 0`;
}

/** The answer of taskOutputScript: nothing when no candidate file exists (or one is a link). */
export function decodeTaskOutput(frame: Buffer): TaskOutputRead {
  if (frame.toString('ascii', 0, 6) !== 'found\0') return { found: false };
  const metaEnd = frame.indexOf(0, 6);
  const stamp = frame.toString('ascii', 6, metaEnd);
  const meta = /^(\d+):(\d+):(\d+)$/.exec(stamp);
  if (metaEnd < 0 || !meta) return { found: false };
  const base = { found: true as const, stamp, inode: meta[1], size: Number(meta[2]) };
  if (frame.toString('ascii', metaEnd + 1, metaEnd + 6) === 'same\0') return { ...base, unchanged: true };
  const startEnd = frame.indexOf(0, metaEnd + 1), modeEnd = startEnd < 0 ? -1 : frame.indexOf(0, startEnd + 1);
  const start = Number(frame.toString('ascii', metaEnd + 1, startEnd)), mode = frame.toString('ascii', startEnd + 1, modeEnd);
  if (modeEnd < 0 || !Number.isSafeInteger(start) || (mode !== 'tail' && mode !== 'from' && mode !== 'before')) return { found: false };
  return { ...base, start, mode, bytes: frame.subarray(modeEnd + 1) };
}
