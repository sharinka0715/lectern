import { readTaskList } from '../core/conversation-tasks';
import { SESSION_UUID } from './native-presence';
import { quoteShell as q } from './transport';

// 工作目录已在目标端解析。只读取原生任务按钮对应的当前会话，缩减字段后再跨连接返回。
export function taskListFrame(config: string, sessionId: string) {
  if (!SESSION_UUID.test(sessionId)) throw new Error('Invalid task list UUID');
  const reader = `
    use strict; use warnings;
    my (@tasks, $total);
    opendir(my $dir, '.') or exit;
    while (defined(my $file = readdir($dir))) {
      next unless $file =~ /^([0-9]{1,12})\\.json$/;
      my $id = $1;
      exit if @tasks >= 200;
      sysopen(my $fh, $file, O_RDONLY|O_NOFOLLOW|O_NONBLOCK) or exit;
      my $size = -s $fh;
      exit unless -f $fh && defined $size && $size <= 131072 && ($total += $size) <= 2097152;
      local $/; my $item = decode_json(<$fh>);
      exit unless ref($item) eq 'HASH' && ($item->{id}//'') eq $id && length($item->{subject}//'') && length($item->{subject}) <= 4096 && ($item->{status}//'') =~ /^(pending|in_progress|completed)$/;
      push @tasks,{id=>"$id",subject=>$item->{subject},status=>$item->{status}};
    }
    print encode_json([sort { length($a->{id}) <=> length($b->{id}) || $a->{id} cmp $b->{id} } @tasks]) if @tasks;
  `;
  return `(
    case "$lectern_visible" in *'to show tasks'*|*'to hide tasks'*) ;; *) exit 0;; esac
    [ -z "\${CLAUDE_CODE_TASK_LIST_ID:-}" ] || [ "$CLAUDE_CODE_TASK_LIST_ID" = ${q(sessionId)} ] || exit 0
    cd -P ${q(config)} && [ ! -L tasks ] && cd -P tasks && [ ! -L ${q(sessionId)} ] && cd -P ${q(sessionId)} || exit 0
    perl -MFcntl=:DEFAULT -MJSON::PP -e ${q(reader)}
  ) 2>/dev/null`;
}

export function decodeTaskList(raw: string) {
  if (!raw || raw.length > 1_000_000) return;
  try { return readTaskList(JSON.parse(raw)); } catch { return; }
}
