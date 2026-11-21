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
case "$(uname -s)" in (Darwin|*BSD) lectern_bsd=1;; (*) lectern_bsd=;; esac
for lectern_s in ${dirs.join(' ')}; do
  [ -d "$lectern_s" ] && [ ! -L "$lectern_s" ] && [ ! -L "\${lectern_s%/*}" ] || continue
  for lectern_f in "$lectern_s"/agent-*.jsonl; do
    [ -f "$lectern_f" ] && [ ! -L "$lectern_f" ] || continue
    lectern_id=\${lectern_f##*/agent-}; lectern_id=\${lectern_id%.jsonl}
    case "$lectern_id" in (''|*[!A-Za-z0-9_-]*) continue;; esac
    [ "$lectern_count" -lt ${LIST_LIMIT} ] || break 2
    lectern_count=$((lectern_count + 1))
    if [ -n "$lectern_bsd" ]; then lectern_m=$(stat -f '%z:%m' "$lectern_f" 2>/dev/null); else lectern_m=$(stat -c '%s:%Y' "$lectern_f" 2>/dev/null); fi
    case "$lectern_m" in (''|*[!0-9:]*) continue;; esac
    printf '%s\\0%s\\0' "$lectern_id" "$lectern_m"
    lectern_meta="$lectern_s/agent-$lectern_id.meta.json"
    if [ -f "$lectern_meta" ] && [ ! -L "$lectern_meta" ]; then head -c 4096 "$lectern_meta" | base64 | tr -d '\\n'; fi
    printf '\\0'
  done
done`;
}

const text = (value: unknown, max = 400) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
const isoTime = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value).toISOString()
  : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : undefined;
type MetaFields = Pick<SubagentFile, 'agentType' | 'description' | 'toolUseId' | 'finished' | 'isBuiltIn' | 'revivedAt' | 'stoppedByUser' | 'foreground' | 'model'>;

/** What a subagent's `.meta.json` says (undefined when it is not a JSON object). */
export function subagentMeta(json: string): MetaFields | undefined {
  let meta: unknown;
  try { meta = JSON.parse(json); } catch { return; }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return;
  const m = meta as Record<string, unknown>, fields: MetaFields = {};
  fields.agentType = text(m.agentType, 160);
  fields.description = text(m.description);
  fields.toolUseId = text(m.toolUseId, 200);
  if (typeof m.finished === 'boolean') fields.finished = m.finished;
  if (typeof m.isBuiltIn === 'boolean') fields.isBuiltIn = m.isBuiltIn;
  if (m.stoppedByUser === true) fields.stoppedByUser = true;
  if (m.requestShape === 'foreground') fields.foreground = true;
  fields.revivedAt = isoTime(m.revivedAt);
  fields.model = text(m.model, 160);
  for (const key of Object.keys(fields) as (keyof MetaFields)[]) if (fields[key] === undefined) delete fields[key];
  return fields;
}

export function decodeSubagentList(frame: Buffer): SubagentFile[] {
  const fields = frame.toString('ascii').split('\0'), files = new Map<string, SubagentFile>();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [agentId, stamp, encoded] = fields.slice(i, i + 3);
    const match = /^(\d+):(\d+)$/.exec(stamp);
    if (!activityTaskId(agentId) || !match || encoded.length > 8192 || files.has(agentId)) continue;
    const file: SubagentFile = { agentId, size: Number(match[1]), modifiedAt: new Date(Number(match[2]) * 1000).toISOString() };
    // A meta file being written is read again next time.
    if (encoded) Object.assign(file, subagentMeta(Buffer.from(encoded, 'base64').toString('utf8')));
    files.set(agentId, file);
  }
  return [...files.values()].sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? ''));
}

/** The poll's view of a session's subagent folder, kept between polls (Backend). */
export interface SubagentPollState {
  /** The checksum of the last listing: the same listing is not sent again. */
  fingerprint?: string;
  revision: number;
  files: SubagentFile[];
  /** Meta files read, by agent ID, with the `size:mtime` they were read at. */
  metas: Map<string, { stamp: string; mtime: number; fields: MetaFields }>;
  /** The time of each transcript's first record (never changes once written). */
  starts: Map<string, string>;
}
export const subagentPollState = (): SubagentPollState => ({ revision: 0, files: [], metas: new Map(), starts: new Map() });

/**
 * One section of the session poll: the session's subagent folder. Lists the meta files
 * (size, mtime) and transcripts (names only: a running one grows all the time) with one
 * `stat` each; when that listing has the checksum of the last one, it answers `=` and
 * nothing else. Otherwise it sends the listing, the meta files not read at their current
 * stamp (one `grep` for all of them) and, for transcripts whose start is not known yet,
 * the time of their first record (one `head` for all). Only names built from a checked
 * session UUID are visited, and only regular files that are not symlinks are read.
 */
export function subagentPollScript(projectDirs: string[], sessionId: string, state: SubagentPollState, bsd: boolean): string {
  if (!SESSION_UUID.test(sessionId)) throw new Error('Invalid subagent session');
  const dirs = [...new Set(projectDirs)].slice(0, 4).map(dir => `${dir}/${sessionId}/subagents`);
  const known = ' ' + [...state.metas].map(([id, meta]) => `${id}:${meta.stamp}`).join(' ') + ' ';
  const started = ' ' + [...state.starts.keys()].join(' ') + ' ';
  // Inside $(…), already a subshell.
  const stat = (pattern: string, format: 'meta' | 'name') => `cd "$lectern_sd" 2>/dev/null || exit 0
  set -- ${pattern}; [ -e "$1" ] || [ -L "$1" ] || exit 0; [ $# -le ${LIST_LIMIT} ] || shift $(($# - ${LIST_LIMIT}))
  ${bsd ? `stat -f '${format === 'meta' ? '%N %z %m %p' : '%N %p'}'` : `stat -c '${format === 'meta' ? '%n %s %Y %f' : '%n %f'}'`} -- "$@" 2>/dev/null`;
  const visit = (body: (n: number) => string) => dirs.map((dir, i) => `lectern_sd=${q(dir)}
if [ -d "$lectern_sd" ] && [ ! -L "$lectern_sd" ] && [ ! -L "\${lectern_sd%/*}" ]; then
${body(i)}
fi`).join('\n');
  return `(
lectern_known=${q(known)}; lectern_started=${q(started)}; lectern_all=
${visit(i => `lectern_m${i}=$(${stat('agent-*.meta.json', 'meta')}); lectern_j${i}=$(${stat('agent-*.jsonl', 'name')})
lectern_all="$lectern_all|${i}|$lectern_m${i}|$lectern_j${i}"`)}
lectern_sum=$(printf '%s' "$lectern_all" | cksum)
if [ "$lectern_sum" = ${q(state.fingerprint ?? '')} ]; then printf '=%s\\0' "$lectern_sum"; exit 0; fi
printf '+%s\\0' "$lectern_sum"
${visit(i => `printf '@${i}\\0%s\\0%s\\0' "$lectern_m${i}" "$lectern_j${i}"
(cd "$lectern_sd" 2>/dev/null || exit 0
lectern_read=; lectern_heads=
while read -r lectern_n lectern_z lectern_t lectern_f; do
  case "$lectern_n" in (agent-*.meta.json) ;; (*) continue;; esac
  lectern_id=\${lectern_n#agent-}; lectern_id=\${lectern_id%.meta.json}
  case "$lectern_id" in (''|*[!A-Za-z0-9_-]*) continue;; esac
  case "$lectern_z:$lectern_t" in (*[!0-9:]*|:*|*:) continue;; esac
  [ "$lectern_z" -le 16384 ] || continue
  case "$lectern_known" in (*" $lectern_id:$lectern_z:$lectern_t "*) continue;; esac
  [ -f "$lectern_n" ] && [ ! -L "$lectern_n" ] && lectern_read="$lectern_read $lectern_n"
done <<LECTERN_META
$lectern_m${i}
LECTERN_META
while read -r lectern_n lectern_f; do
  case "$lectern_n" in (agent-*.jsonl) ;; (*) continue;; esac
  lectern_id=\${lectern_n#agent-}; lectern_id=\${lectern_id%.jsonl}
  case "$lectern_id" in (''|*[!A-Za-z0-9_-]*) continue;; esac
  case "$lectern_started" in (*" $lectern_id "*) continue;; esac
  [ -f "$lectern_n" ] && [ ! -L "$lectern_n" ] && lectern_heads="$lectern_heads $lectern_n"
done <<LECTERN_JSONL
$lectern_j${i}
LECTERN_JSONL
[ -z "$lectern_read" ] || LC_ALL=C grep -a -H '' $lectern_read 2>/dev/null | head -c 4194304 | base64
printf '\\0'
[ -z "$lectern_heads" ] || head -n 1 $lectern_heads /dev/null 2>/dev/null | LC_ALL=C grep -a -o -e '^==> agent-[A-Za-z0-9_-]*\\.jsonl <==$' -e '"timestamp":"[0-9T:.Z+-]*"'
printf '\\0')`)}
)`;
}

/** A `stat` mode (GNU: hex, BSD: octal) of a regular file. */
const regular = (mode: string | undefined, bsd: boolean) => !!mode && /^[0-9a-f]{1,7}$/i.test(mode) && (parseInt(mode, bsd ? 8 : 16) & 0o170000) === 0o100000;
const META_NAME = /^agent-([A-Za-z0-9_-]{1,100})\.meta\.json$/, JSONL_NAME = /^agent-([A-Za-z0-9_-]{1,100})\.jsonl$/;

/**
 * Applies one answer of subagentPollScript to `state`: true when the listing changed
 * (`state.files` and `state.revision` are new). A meta file that could not be parsed
 * (being written) leaves no fingerprint, so the next poll lists the folder again.
 */
export function applySubagentPoll(frame: Buffer, state: SubagentPollState, bsd: boolean): boolean {
  const fields = frame.toString('utf8').split('\0');
  const head = fields[0] ?? '';
  if (head.startsWith('=') && head.slice(1) === state.fingerprint) return false;
  if (!head.startsWith('+')) { state.fingerprint = undefined; return false; }
  let fingerprint: string | undefined = head.slice(1);
  const files = new Map<string, SubagentFile>(), seenMeta = new Map<string, { stamp: string; mtime: number }>();
  for (let i = 1; i < fields.length && fields[i].startsWith('@'); i += 5) {
    const [, metaStat = '', jsonlStat = '', metaText = '', heads = ''] = fields.slice(i, i + 5);
    const stamps = new Map<string, { stamp: string; mtime: number }>();
    for (const line of metaStat.split('\n')) {
      const [name, size, mtime, mode] = line.split(' '), id = META_NAME.exec(name ?? '')?.[1];
      if (!id || !/^\d+$/.test(size ?? '') || !/^\d+$/.test(mtime ?? '') || !regular(mode, bsd) || seenMeta.has(id)) continue;
      stamps.set(id, { stamp: `${size}:${mtime}`, mtime: Number(mtime) });
      seenMeta.set(id, stamps.get(id)!);
    }
    // grep -H: every line of a meta file after its name.
    const texts = new Map<string, string[]>();
    for (const line of Buffer.from(metaText, 'base64').toString('utf8').split('\n')) {
      const colon = line.indexOf(':'), id = META_NAME.exec(line.slice(0, colon))?.[1];
      if (colon > 0 && id) texts.set(id, [...texts.get(id) ?? [], line.slice(colon + 1)]);
    }
    for (const [id, lines] of texts) {
      const stamp = stamps.get(id), parsed = stamp && subagentMeta(lines.join('\n'));
      if (stamp && parsed) state.metas.set(id, { ...stamp, fields: parsed });
      else fingerprint = undefined;
    }
    let current: string | undefined;
    for (const line of heads.split('\n')) {
      const header = /^==> (.*) <==$/.exec(line);
      if (header) { current = JSONL_NAME.exec(header[1])?.[1]; continue; }
      const time = /^"timestamp":"([^"]*)"$/.exec(line)?.[1];
      if (current && time && Number.isFinite(Date.parse(time))) state.starts.set(current, new Date(Date.parse(time)).toISOString());
    }
    for (const line of jsonlStat.split('\n')) {
      const [name, mode] = line.split(' '), id = JSONL_NAME.exec(name ?? '')?.[1];
      if (!id || !regular(mode, bsd) || files.has(id)) continue;
      const stamp = stamps.get(id), meta = stamp && state.metas.get(id);
      // Without a meta file read at its current stamp, it is listed without one until it is.
      if (stamp && meta?.stamp !== stamp.stamp) fingerprint = undefined;
      files.set(id, { agentId: id, ...(meta?.stamp === stamp?.stamp && meta?.fields),
        ...(stamp && { metaModifiedAt: new Date(stamp.mtime * 1000).toISOString() }), ...(state.starts.has(id) && { startedAt: state.starts.get(id) }) });
    }
  }
  // Forget what was read of files that are gone.
  for (const id of state.metas.keys()) if (!seenMeta.has(id)) state.metas.delete(id);
  for (const id of state.starts.keys()) if (!files.has(id)) state.starts.delete(id);
  state.fingerprint = fingerprint;
  const list = [...files.values()];
  if (JSON.stringify(list) === JSON.stringify(state.files)) return false;
  state.files = list;
  state.revision++;
  return true;
}
