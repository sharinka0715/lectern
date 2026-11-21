import { activityTaskId, type ActivityReadTarget, type ActivitySample } from '../core/session-activity';
import { SESSION_UUID } from './native-presence';
import { quoteShell as q } from './transport';

// Only basenames derived from the native task and selected session are accepted.
// Never follow an output-file reference in assistant text or a shell result.
// Claude's agent .output is a symlink; open its actual project transcript instead.
export function readActivityFiles(sessionId: string, projectDirs: string[], targets: ActivityReadTarget[]): string {
  if (!SESSION_UUID.test(sessionId)) throw new Error('Invalid activity session');
  const safe = targets.filter(t => activityTaskId(t.taskId)).slice(0, 8);
  if (!safe.length) return '';
  const slugs = [...new Set(projectDirs.map(d => d.slice(d.lastIndexOf('/') + 1)))];
  const agentDirs = projectDirs.map(d => q(d + '/' + sessionId + '/subagents'));
  const taskDirs = slugs.map(slug => '"$lectern_task_root"/' + q(slug + '/' + sessionId + '/tasks'));
  // GNU dd and the system Perl on macOS both open the leaf without following
  // symlinks, nonblocking, so a replacement FIFO cannot hang the poll.
  const perl = 'sysopen(my $f,$ARGV[0],O_RDONLY|O_NOFOLLOW|O_NONBLOCK) or exit; -f $f or exit; binmode $f; sysseek($f,$ARGV[1],0); my $n=sysread($f,my $b,$ARGV[2]); print $b if defined $n';
  return `(
    lectern_task_root="/tmp/claude-$(id -u)"
    lectern_activity_read() (
      lectern_dir=$1; lectern_file=$2; lectern_id=$3; lectern_kind=$4; lectern_prev=$5
      [ -d "$lectern_dir" ] || exit 0
      # Starting at a physical base permits the normal macOS /tmp alias but
      # rejects links anywhere in the project/session/task-specific suffix.
      lectern_base="\${lectern_dir%/*/*/*}"
      lectern_suffix="\${lectern_dir#"$lectern_base"/}"
      [ ! -L "$lectern_base" ] && cd -P "$lectern_base" 2>/dev/null || exit 0
      lectern_base=$(pwd -P)
      cd -P "./$lectern_suffix" 2>/dev/null && [ "$(pwd -P)" = "$lectern_base/$lectern_suffix" ] || exit 0
      [ -f "$lectern_file" ] && [ ! -L "$lectern_file" ] || exit 0
      lectern_meta=$(stat -f '%i:%z:%m' "$lectern_file" 2>/dev/null) || lectern_meta=$(stat -c '%i:%s:%Y' "$lectern_file" 2>/dev/null) || exit 0
      case "$lectern_meta" in (*[!0-9:]*) exit 0;; esac
      printf '%s\\0%s\\0' "$lectern_id" "$lectern_meta"
      lectern_size=\${lectern_meta#*:}; lectern_size=\${lectern_size%:*}
      lectern_cap=4096; [ "$lectern_kind" = agent ] && lectern_cap=65536
      lectern_skip=$((lectern_size > lectern_cap ? lectern_size - lectern_cap : 0))
      printf '%s\\0' "$lectern_skip"
      if [ "$lectern_meta" != "$lectern_prev" ]; then
        lectern_bytes() {
          if [ -d /proc/self ] && dd --version >/dev/null 2>&1; then
            dd if="$lectern_file" iflag=nofollow,nonblock,skip_bytes,count_bytes skip="$lectern_skip" count="$lectern_cap" bs=65536 2>/dev/null
          elif command -v perl >/dev/null 2>&1; then
            perl -MFcntl=:DEFAULT -e ${q(perl)} "$lectern_file" "$lectern_skip" "$lectern_cap" 2>/dev/null
          fi
        }
        if [ "$lectern_kind" = agent ]; then
          lectern_bytes | LC_ALL=C awk 'substr($0,1,14)=="{\\"parentUuid\\":" && index($0,"\\"type\\":\\"assistant\\"") && index($0,"\\"isSidechain\\":true") {print}' | base64
        else lectern_bytes | base64; fi
      fi
      printf '\\0'
    )
    ${safe.map(t => {
      const dirs = t.kind === 'agent' ? agentDirs : taskDirs;
      const file = t.kind === 'agent' ? 'agent-' + t.taskId + '.jsonl' : t.taskId + '.output';
      const stamp = /^\d+:\d+:\d+$/.test(t.stamp ?? '') ? t.stamp! : '';
      return `for lectern_d in ${dirs.join(' ')}; do lectern_activity_read "$lectern_d" ${q(file)} ${q(t.taskId)} ${q(t.kind)} ${q(stamp)}; done`;
    }).join('\n')}
  )`;
}

export function decodeActivityFiles(frame: Buffer): ActivitySample[] {
  const fields = frame.toString('ascii').split('\0'), samples: ActivitySample[] = [];
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const [taskId, stamp, skip, encoded] = fields.slice(i, i + 4);
    if (!activityTaskId(taskId) || !/^\d+:\d+:\d+$/.test(stamp) || !/^\d+$/.test(skip) || encoded.length > 92000) continue;
    samples.push({ taskId, stamp, clipped: skip !== '0', tail: Buffer.from(encoded, 'base64').toString('utf8') });
  }
  return samples;
}
