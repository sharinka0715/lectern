import { activityTaskId } from '../core/session-activity';
import type { SubagentFile } from '../shared/types';
import { SESSION_UUID } from './native-presence';
import { quoteShell as q } from './transport';

// Claude Code 2.1.300–2.1.330 write each subagent's own transcript next to the
// session: <project>/<session>/subagents/agent-<agentId>.jsonl, with a small
// agent-<agentId>.meta.json (agentType, description, the launching toolUseId;
// `finished` from 2.1.310). Only names built from a checked session UUID and
// agent ID are ever opened; nothing is taken from transcript text.

/** Candidate transcript paths of one subagent, one per project directory. */
export function subagentPaths(projectDirs: string[], sessionId: string, agentId: string): string[] {
  if (!SESSION_UUID.test(sessionId) || !activityTaskId(agentId)) throw new Error('Invalid subagent');
  return [...new Set(projectDirs)].map(dir => `${dir}/${sessionId}/subagents/agent-${agentId}.jsonl`);
}

const LIST_LIMIT = 400;

/** Lists the session's subagent transcripts: ID, size, modification time and meta file. */
export function subagentListScript(projectDirs: string[], sessionId: string): string {
  if (!SESSION_UUID.test(sessionId)) throw new Error('Invalid subagent session');
  const dirs = [...new Set(projectDirs)].map(dir => q(`${dir}/${sessionId}/subagents`));
  return `lectern_count=0
case "$(uname -s)" in Darwin|*BSD) lectern_bsd=1;; *) lectern_bsd=;; esac
for lectern_s in ${dirs.join(' ')}; do
  [ -d "$lectern_s" ] && [ ! -L "$lectern_s" ] && [ ! -L "\${lectern_s%/*}" ] || continue
  for lectern_f in "$lectern_s"/agent-*.jsonl; do
    [ -f "$lectern_f" ] && [ ! -L "$lectern_f" ] || continue
    lectern_id=\${lectern_f##*/agent-}; lectern_id=\${lectern_id%.jsonl}
    case "$lectern_id" in ''|*[!A-Za-z0-9_-]*) continue;; esac
    [ "$lectern_count" -lt ${LIST_LIMIT} ] || break 2
    lectern_count=$((lectern_count + 1))
    if [ -n "$lectern_bsd" ]; then lectern_m=$(stat -f '%z:%m' "$lectern_f" 2>/dev/null); else lectern_m=$(stat -c '%s:%Y' "$lectern_f" 2>/dev/null); fi
    case "$lectern_m" in ''|*[!0-9:]*) continue;; esac
    printf '%s\\0%s\\0' "$lectern_id" "$lectern_m"
    lectern_meta="$lectern_s/agent-$lectern_id.meta.json"
    if [ -f "$lectern_meta" ] && [ ! -L "$lectern_meta" ]; then head -c 4096 "$lectern_meta" | base64 | tr -d '\\n'; fi
    printf '\\0'
  done
done`;
}

const text = (value: unknown, max = 400) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;

export function decodeSubagentList(frame: Buffer): SubagentFile[] {
  const fields = frame.toString('ascii').split('\0'), files = new Map<string, SubagentFile>();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [agentId, stamp, encoded] = fields.slice(i, i + 3);
    const match = /^(\d+):(\d+)$/.exec(stamp);
    if (!activityTaskId(agentId) || !match || encoded.length > 8192 || files.has(agentId)) continue;
    const file: SubagentFile = { agentId, size: Number(match[1]), modifiedAt: new Date(Number(match[2]) * 1000).toISOString() };
    if (encoded) {
      try {
        const meta = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
        if (meta && typeof meta === 'object') {
          file.agentType = text(meta.agentType, 160);
          file.description = text(meta.description);
          file.toolUseId = text(meta.toolUseId, 200);
          if (typeof meta.finished === 'boolean') file.finished = meta.finished;
        }
      } catch { /* A meta file being written is read again next time. */ }
    }
    files.set(agentId, file);
  }
  return [...files.values()].sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? ''));
}
