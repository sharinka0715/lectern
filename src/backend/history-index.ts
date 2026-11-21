import type { Workspace } from '../shared/types';
import type { HistoryIndexPersistence } from './history-index-disk-store';
import { diagnostic } from '../diagnostics';
import { quoteShell as q, type Transport } from './transport';
import { historyMetadata, expandHistoryHeads, missingCwdReason, type MetadataFrame, type MissingCwdReason } from './history';
import { recordForkParent } from './native-fork';
import { SESSION_UUID } from './native-presence';
import { nativeSessionHint, provePhysicalHistory } from './physical-history';

type Titles = { custom?: string; ai?: string; summary?: string };
type TitleSource = keyof Titles | 'prompt';
interface Metadata { cwd?: string; missingCwd?: MissingCwdReason; title?: string; titleSource?: TitleSource; updatedAt?: string; forkParentId?: string; continuedInSessionId?: string;
  /** A completely read file with no prompt and no reply: cost records, a /model switch, an unused new chat. */
  contentless?: boolean }

function reusable(metadata?: Metadata) {
  return !!metadata && (!!metadata.cwd || !!metadata.missingCwd && metadata.missingCwd !== 'partial');
}

// Command echoes such as <command-name>/model</command-name> and synthetic
// replies are bookkeeping; a typed prompt or a model reply is a conversation.
function userPrompt(r: any): string | undefined {
  if (r.isCompactSummary || r.isVisibleInTranscriptOnly) return;
  const content = r.message?.content;
  const body = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('') : '';
  const first = body.trim();
  if (first && !first.startsWith('<')) return first.slice(0, 100);
}

function readSection(text: string, id: string) {
  const titles: Titles = {};
  let prompt: string | undefined, updatedAt: string | undefined, forkParentId: string | undefined;
  let continuation: string | null | undefined, conversation = false;
  for (const line of text.split('\n')) {
    let r: any;
    try { r = JSON.parse(line); } catch { continue; } // A bounded head or tail can split a record.
    // A copy may carry its source's turns under the source's session ID.
    if (r && !r.isSidechain && (r.type === 'assistant' && r.message?.model !== '<synthetic>' || r.type === 'user' && !r.isMeta && userPrompt(r))) conversation = true;
    if (!r || r.sessionId && r.sessionId !== id || r.isSidechain) continue;
    if (r.type === 'continued-in') {
      const target = r.continuedInSessionId;
      continuation = r.sessionId === id && typeof target === 'string' && target !== id && SESSION_UUID.test(target) ? target : null;
    } else if (r.type === 'user' || r.type === 'assistant') continuation = null;
    if (r.forkedFrom) forkParentId ??= recordForkParent(r, id);
    if (typeof r.timestamp === 'string') updatedAt = r.timestamp;
    if (r.type === 'custom-title' && typeof r.customTitle === 'string') titles.custom = r.customTitle.trim();
    if (r.type === 'ai-title' && typeof r.aiTitle === 'string') titles.ai = r.aiTitle.trim();
    if (r.type === 'summary' && typeof r.summary === 'string') titles.summary = r.summary.trim();
    if (prompt || r.type !== 'user' || r.isMeta || r.isCompactSummary || r.isVisibleInTranscriptOnly) continue;
    prompt = userPrompt(r);
  }
  return { titles, prompt, updatedAt, forkParentId, continuation, conversation };
}

export interface IndexedFile {
  id: string;
  path: string;
  inode: string;
  size: number;
  stamp: string;
  sidecarStamp?: string;
  titles: Titles;
  guard?: string;
  titlesComplete?: boolean;
  nativeHint?: string;
  groupProof?: { key: string; order: number };
  continuationProof?: { key: string; before: number };
  /** Message UUIDs only (never text): the first main-chain record and the
   * last compact boundary. A resumed copy starts at one of these. */
  anchors?: HistoryAnchors;
  /** Proofs that this file continues a predecessor, keyed by both stamps. */
  linkProofs?: LinkProof[];
  metadata: Metadata;
}
export type AnchorKind = 'root' | 'boundary' | 'other';
export interface HistoryAnchors { head?: string; headKind?: AnchorKind; lastBoundary?: string }
export interface LinkProof { key: string; before: number; depth: number }
const sessionName = /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i;
/** stat's modification time as an ISO timestamp: BSD `%.9Fm` gives epoch seconds,
 * GNU `%y` gives `2026-11-20 15:09:01.123456789 +0800`. */
export function statTime(value: string | undefined): string | undefined {
  if (!value) return;
  let time: number;
  if (/^\d+(?:\.\d+)?$/.test(value)) time = Number(value) * 1000;
  else {
    const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d+))? ([+-])(\d{2}):?(\d{2})$/.exec(value);
    if (!match) return;
    const [, date, clock, fraction = '0', sign, hours, minutes] = match;
    time = Date.parse(`${date}T${clock}.${fraction.padEnd(3, '0').slice(0, 3)}${sign}${hours}:${minutes}`);
  }
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : undefined;
}
const tailBytes = 16384;

// Native title and legacy summary records are flat objects of strings. On large
// histories, select the last of each on the target, independent of key order.
// Validate the flat shape before collecting fields, so nested tool payloads or
// JSON quoted inside messages can never displace an actual session title.
const collectTitles = String.raw`
length($0) <= 16384 && /"type"[[:space:]]*:[[:space:]]*"(custom-title|ai-title|summary)"/ {
  line = $0
  if (!sub(/^[[:space:]]*\{[[:space:]]*/, "", line)) next
  for (key in fields) delete fields[key]
  while (match(line, /^"[[:alnum:]_]+"[[:space:]]*:[[:space:]]*/)) {
    key = substr(line, 2, index(substr(line, 2), "\"") - 1)
    line = substr(line, RLENGTH + 1)
    if (!match(line, /^"([^"\\[:cntrl:]]|\\(["\\\/bfnrt]|u[[:xdigit:]][[:xdigit:]][[:xdigit:]][[:xdigit:]]))*"/)) next
    fields[key] = substr(line, 1, RLENGTH)
    line = substr(line, RLENGTH + 1)
    if (!sub(/^[[:space:]]*,[[:space:]]*/, "", line)) break
    if (line !~ /^"/) next
  }
  if (line !~ /^[[:space:]]*\}[[:space:]]*$/ || ("sessionId" in fields && fields["sessionId"] != "\"" id "\"")) next
  type = fields["type"]
  if (type == "\"custom-title\"" && "customTitle" in fields) custom = fields["customTitle"]
  if (type == "\"ai-title\"" && "aiTitle" in fields) ai = fields["aiTitle"]
  if (type == "\"summary\"" && "summary" in fields) summary = fields["summary"]
}
END {
  if (custom) print "{\"type\":\"custom-title\",\"customTitle\":" custom "}"
  if (ai) print "{\"type\":\"ai-title\",\"aiTitle\":" ai "}"
  if (summary) print "{\"type\":\"summary\",\"summary\":" summary "}"
}`;

// Only a new/replaced large file needs a complete streaming pass. Append reads
// overlap by one bounded title record to include a partially written last line.
const readFile = `guard_at() (
 set -- $(tail -c +$(($2 - 127)) "$1" | head -c 128 | cksum)
 printf '%s-%s' "$1" "$2"
)
read_metadata() {
 file=$1; size=$2; previous=$3; guard=$4
 dir=\${file%/*}; [ ! -L "$dir" ] && [ ! -L "\${dir%/*}" ] && [ -f "$file" ] && [ ! -L "$file" ] || return 0
 id=\${file##*/}; id=\${id%.jsonl}
 printf '%s\\0' "$file"; head -c 8192 "$file" | base64; printf '\\0'; tail -c ${tailBytes} "$file" | base64; printf '\\0'
 side=\${file%.jsonl}/custom-title.json
 if [ ! -L "\${side%/*}" ] && [ -f "$side" ] && [ ! -L "$side" ]; then head -c ${tailBytes + 1} "$side" | base64; fi
 printf '\\0'
 start=0
 if [ "$previous" -gt ${tailBytes} ] && [ "$size" -ge "$previous" ] && [ -n "$guard" ]; then
  sample=$(guard_at "$file" "$previous")
  if [ "$sample" = "$guard" ]; then start=$((previous - ${tailBytes})); fi
 fi
 printf '%s\\0' "$start"
 if [ "$size" -gt ${tailBytes} ]; then guard_at "$file" "$size"; fi
 printf '\\0'
}`;

// macOS awk spends seconds on a single multi-MB tool result. Where available,
// Perl rejects long lines in native byte mode before awk sees them. The POSIX
// grep fallback likewise feeds the field parser only potential title records.
const readTitles = `if command -v perl >/dev/null 2>&1; then
 candidates() { LC_ALL=C perl -ne 'print if length($_) <= 16385 && /"type"\\s*:\\s*"(?:custom-title|ai-title|summary)"/'; }
else
 candidates() { LC_ALL=C grep -E '"type"[[:space:]]*:[[:space:]]*"(custom-title|ai-title|summary)"' || [ "$?" = 1 ]; }
fi
read_titles() {
 file=$1; start=$2
 dir=\${file%/*}; [ ! -L "$dir" ] && [ ! -L "\${dir%/*}" ] && [ -f "$file" ] && [ ! -L "$file" ] || return 0
 id=\${file##*/}; id=\${id%.jsonl}
 printf '%s\\0%s\\0' "$file" "$start"
 if [ "$start" -eq 0 ]; then candidates < "$file"; else tail -c +$((start + 1)) "$file" | candidates; fi |
  LC_ALL=C awk -v id="$id" ${q(collectTitles)}
 printf '\\0'
}`;

// 标记可能埋在退出时追加的统计记录之前。仅在尾窗口看不到消息或标记时查找，
// 目标端最多送回一条短候选。下面的过滤可以保守地放弃关联；接收端还要核对顶层字段。
const readContinuation = String.raw`read_continuation() {
 file=$1; dir=$(dirname "$file"); [ ! -L "$dir" ] && [ ! -L "$(dirname "$dir")" ] && [ -f "$file" ] && [ ! -L "$file" ] || return 0
 printf '%s\0' "$file"
 if LC_ALL=C grep -q '"continued-in"' "$file"; then
  if command -v perl >/dev/null 2>&1; then
   LC_ALL=C perl -ne 'if (/"type"\s*:\s*"(?:user|assistant)"/) { $link="" } elsif (length($_)<=2048 && /"type"\s*:\s*"continued-in"/) { $link=$_ } END { print $link if $link }' "$file"
  else
   LC_ALL=C awk '/"type"[[:space:]]*:[[:space:]]*"(user|assistant)"/ { link=""; next }
    length($0)<=2048 && /"type"[[:space:]]*:[[:space:]]*"continued-in"/ { link=$0 } END { if (link) print link }' "$file"
  fi
 fi
 printf '\0'
}`;

// A resumed native session starts with a copy of its predecessor: either from
// the root message or from the latest compact boundary. Record those UUIDs so
// discovery can pair a copy with its source without reading message bodies.
// Only lines that may carry such a record are decoded; the output is two short
// lines of UUIDs. Appends re-read only the new bytes for a later boundary.
const anchorScript = String.raw`use strict; use JSON::PP; my $j = JSON::PP->new->utf8;
my ($id, $want) = @ARGV; my ($head, $kind, $last);
my $uu = qr/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
while (my $l = <STDIN>) {
 my $h = $want && !defined($head) && index($l, '"parentUuid"') >= 0;
 my $b = index($l, '"compact_boundary"') >= 0;
 next unless $h || $b;
 my $r = eval { $j->decode($l) }; next unless ref($r) eq 'HASH' && !$r->{isSidechain};
 my $t = $r->{type} // ''; my $u = $r->{uuid} // '';
 next unless $u =~ $uu && $t =~ /^(user|assistant|system|attachment|progress)$/;
 my $isb = $t eq 'system' && ($r->{subtype} // '') eq 'compact_boundary' && !defined($r->{parentUuid});
 if ($h) { $head = $u; $kind = defined($r->{parentUuid}) || ($r->{sessionId} // '') ne $id || exists $r->{forkedFrom} ? 'other' : $isb ? 'boundary' : $t eq 'user' ? 'root' : 'other'; }
 $last = $u if $isb && ($r->{sessionId} // '') eq $id;
}
print "H $head $kind\n" if defined $head; print "B $last\n" if defined $last;`;
const readAnchors = `read_anchors() {
 file=$1; start=$2
 dir=\${file%/*}; [ ! -L "$dir" ] && [ ! -L "\${dir%/*}" ] && [ -f "$file" ] && [ ! -L "$file" ] || return 0
 id=\${file##*/}; id=\${id%.jsonl}
 printf '%s\\0%s\\0' "$file" "$start"
 if command -v perl >/dev/null 2>&1 && perl -MJSON::PP -e 1 2>/dev/null; then
  if [ "$start" -eq 0 ]; then LC_ALL=C perl -e ${q(anchorScript)} "$id" 1 < "$file"; else tail -c +$((start + 1)) "$file" | LC_ALL=C perl -e ${q(anchorScript)} "$id" 0; fi
 fi
 printf '\\0'
}`;
function parseAnchors(text: string, previous?: HistoryAnchors): HistoryAnchors {
  const anchors: HistoryAnchors = previous ? { head: previous.head, headKind: previous.headKind, lastBoundary: previous.lastBoundary } : {};
  for (const line of text.split('\n')) {
    const [tag, uuid, kind] = line.split(' ');
    if (!uuid || !SESSION_UUID.test(uuid)) continue;
    if (tag === 'H' && (kind === 'root' || kind === 'boundary' || kind === 'other')) Object.assign(anchors, { head: uuid, headKind: kind });
    if (tag === 'B') anchors.lastBoundary = uuid;
  }
  return anchors;
}

interface ChangedFrame extends MetadataFrame { guard: string; sidecar?: string; start: number }

async function readBatches(transport: Transport, workspace: Workspace, functions: string, commands: string[], tag: string, bytesPerFile: number, consume: (fields: string[]) => void) {
  for (let index = 0; index < commands.length;) {
    const batch: string[] = [];
    let length = 0;
    while (index < commands.length && length < 48000 && batch.length < 500) {
      const call = commands[index++];
      batch.push(call); length += Buffer.byteLength(call) + 1;
    }
    const script = `set -e\n${functions}\n${batch.join('\n')}`;
    const result = await transport.run(workspace, script, { tag, maxBytes: batch.length * bytesPerFile, timeoutMs: 60000 });
    consume(result.stdout.toString().split('\0'));
  }
}

/** Only parsed names, workspace metadata, and a small append guard stay in
 * memory. Unchanged transcripts and title sidecars require only batched stats. */
export class HistoryIndex {
  private files?: Map<string, IndexedFile>;
  private hydration?: Promise<Map<string, IndexedFile>>;
  private revision = 0;
  private dirty = false;
  constructor(private readonly disk?: HistoryIndexPersistence) {}

  // An in-flight scan of a removed/reconfigured workspace may finish its
  // remote reads, but must not resurrect the old disk snapshot.
  invalidate() { this.revision++; }

  async scan(transport: Transport, workspace: Workspace, dirs: string[], aliases = [workspace.cwd]) {
    const revision = ++this.revision;
    const cache = this.files ?? (this.disk ? await (this.hydration ??= this.disk.read()) : new Map<string, IndexedFile>());
    const script = `set -eu
count=0; index=0
platform=$(uname -s)
for dir in ${dirs.map(q).join(' ')}; do
 printf '@%s\\n' "$index"; index=$((index + 1))
 [ -d "$dir" ] && [ ! -L "$dir" ] && [ ! -L "\${dir%/*}" ] || continue
 cd "$dir"; set --
 for file in *.jsonl; do
  case "$file" in ????????-????-????-????-????????????.jsonl) ;; *) continue;; esac
  case "\${file%.jsonl}" in *[!a-fA-F0-9-]*) continue;; esac
  [ -f "$file" ] && [ ! -L "$file" ] || continue
  count=$((count + 1)); [ "$count" -le 1000 ] || break
  set -- "$@" "./$file"
  side="./\${file%.jsonl}/custom-title.json"
  if [ ! -L "\${side%/*}" ] && [ -f "$side" ] && [ ! -L "$side" ]; then set -- "$@" "$side"; fi
 done
 if [ "$#" -gt 0 ]; then
  case "$platform" in Darwin|*BSD) stat -f '%N|%i|%z|%.9Fm|%.9Fc' "$@";; *) stat -c '%n|%i|%s|%y|%z' "$@";; esac
 fi
 [ "$count" -le 1000 ] || { echo '!limit'; break; }
done`;
    const listing = await transport.run(workspace, script, { tag: 'history.file_stamps', maxBytes: 512 * 1024 });
    const rows = new Map<string, IndexedFile>();
    const sidecars = new Map<string, string>();
    let directory: string | undefined, truncated = false;
    for (const line of listing.stdout.toString().trimEnd().split('\n')) {
      if (/^@\d+$/.test(line)) { directory = dirs[Number(line.slice(1))]; continue; }
      if (line === '!limit') { truncated = true; continue; }
      const [name, inode, rawSize, mtime, ctime] = line.split('|');
      const relative = name.replace(/^\.\//, '');
      const sidecar = relative.endsWith('/custom-title.json');
      const filename = sidecar ? relative.slice(0, -'/custom-title.json'.length) + '.jsonl' : relative;
      const id = sessionName.exec(filename)?.[1], size = Number(rawSize);
      if (!directory || !id || !/^\d+$/.test(inode) || !/^\d+$/.test(rawSize) || !Number.isSafeInteger(size) || !mtime || !ctime) throw new Error('Invalid transcript file listing');
      const path = `${directory}/${filename}`, stamp = [inode, size, mtime, ctime].join('|');
      if (sidecar) sidecars.set(path, stamp);
      else rows.set(path, { path, id, inode, size, stamp, titles: {}, metadata: {} });
    }
    const changed: IndexedFile[] = [];
    // A local snapshot from disk lends only its proofs (see proofsOnly).
    const proofsOnly = !this.files && !!this.disk?.proofsOnly;
    for (const row of rows.values()) {
      row.sidecarStamp = sidecars.get(row.path);
      const cached = cache.get(row.path);
      const same = cached?.stamp === row.stamp && cached.sidecarStamp === row.sidecarStamp;
      // Reuse a row only with everything a full read records: its anchors and,
      // for a file the tail window reads whole, the contentless flag.
      if (!proofsOnly && same && reusable(cached.metadata) && cached.anchors
        && (row.size > tailBytes || typeof cached.metadata.contentless === 'boolean')) rows.set(row.path, cached);
      else {
        // Proof keys name both files' stamps, so an unchanged file keeps them.
        if (proofsOnly && same) Object.assign(row, { groupProof: cached.groupProof, continuationProof: cached.continuationProof, linkProofs: cached.linkProofs });
        changed.push(row);
      }
    }
    const frames: ChangedFrame[] = [];
    const reads = changed.map(row => {
      const cached = proofsOnly ? undefined : cache.get(row.path);
      const previous = cached?.inode === row.inode && (cached.stamp === row.stamp || cached.size < row.size) ? cached : undefined;
      return `read_metadata ${q(row.path)} ${row.size} ${previous?.size ?? 0} ${q(previous?.guard ?? '')}`;
    });
    await readBatches(transport, workspace, readFile, reads, 'history.changed_metadata', 64 * 1024, parts => {
      for (let i = 0; i + 5 < parts.length; i += 6) {
        if (!rows.has(parts[i])) throw new Error('Unexpected transcript path');
        const sidecarData = Buffer.from(parts[i + 3], 'base64');
        let sidecar: string | undefined;
        if (sidecarData.length && sidecarData.length <= tailBytes) {
          try {
            const value = JSON.parse(sidecarData.toString())?.customTitle;
            if (typeof value === 'string' && value.trim()) sidecar = value.trim();
          } catch { /* Incomplete sidecar writes can be retried on the next stat change. */ }
        }
        frames.push({ path: parts[i], head: Buffer.from(parts[i + 1], 'base64').toString(), tail: Buffer.from(parts[i + 2], 'base64').toString(), sidecar, start: Number(parts[i + 4]), guard: parts[i + 5] });
      }
    });
    const { limited } = await expandHistoryHeads(transport, workspace, frames);
    const middleReads: string[] = [];
    const sections = frames.map(frame => {
      const row = rows.get(frame.path)!, cached = cache.get(frame.path);
      const head = readSection(frame.head, row.id), tail = readSection(frame.tail, row.id);
      // /resume checks a transcript-tail custom title (including a clear)
      // before consulting <uuid>/custom-title.json, then earlier transcript rows.
      const custom = tail.titles.custom ?? frame.sidecar;
      const reuse = frame.start > 0 && cached?.titlesComplete;
      row.guard = frame.guard;
      row.titles = { ...head.titles, ...(reuse ? cached.titles : {}) };
      row.titlesComplete = row.size <= tailBytes || !!reuse && cached.stamp === row.stamp;
      if (!custom && !row.titlesComplete) {
        // The middle may contain an older native rename or the only AI title.
        // A clear in the tail also needs the lower-priority AI/summary entries.
        middleReads.push(`read_titles ${q(row.path)} ${reuse ? frame.start : 0}`);
      }
      return { frame, row, head, tail, custom };
    });
    await readBatches(transport, workspace, readTitles, middleReads, 'history.title_records', 64 * 1024, parts => {
      for (let i = 0; i + 2 < parts.length; i += 3) {
        const row = rows.get(parts[i]);
        if (!row) throw new Error('Unexpected transcript path');
        Object.assign(row.titles, readSection(parts[i + 2], row.id).titles);
        row.titlesComplete = true;
      }
    });
    const anchorReads: string[] = [];
    for (const { frame, row } of sections) {
      const cached = cache.get(frame.path);
      const appended = frame.start > 0 && cached?.inode === row.inode && !!cached.anchors?.headKind;
      anchorReads.push(`read_anchors ${q(row.path)} ${appended ? frame.start : 0}`);
    }
    await readBatches(transport, workspace, readAnchors, anchorReads, 'history.anchors', 512, parts => {
      for (let i = 0; i + 2 < parts.length; i += 3) {
        const row = rows.get(parts[i]);
        if (!row) throw new Error('Unexpected transcript path');
        const start = Number(parts[i + 1]), cached = cache.get(row.path);
        row.anchors = parseAnchors(parts[i + 2], start > 0 ? cached?.anchors : undefined);
      }
    });
    const continuationReads = sections.filter(({ frame, row, tail }) =>
      row.size > tailBytes && frame.tail.endsWith('\n') && tail.continuation === undefined);
    const earlierLinks = new Map<string, string>();
    await readBatches(transport, workspace, readContinuation, continuationReads.map(({ row }) => `read_continuation ${q(row.path)}`),
      'history.continued_in', 8192, parts => {
        for (let i = 0; i + 1 < parts.length; i += 2) {
          const row = rows.get(parts[i]);
          if (!row) throw new Error('Unexpected continuation path');
          const target = readSection(parts[i + 1], row.id).continuation;
          if (target) earlierLinks.set(row.path, target);
        }
      });
    for (const { frame, row, head, tail, custom } of sections) {
      Object.assign(row.titles, tail.titles);
      const names = { ...row.titles, custom: custom ?? row.titles.custom, prompt: head.prompt ?? tail.prompt };
      const titleSource = (['custom', 'ai', 'summary', 'prompt'] as const).find(source => names[source]);
      const { cwd } = historyMetadata(frame);
      row.nativeHint = nativeSessionHint(frame.head, frame.tail, row.id);
      row.metadata = { cwd, ...(!cwd && { missingCwd: missingCwdReason(frame, row.size) }),
        continuedInSessionId: frame.tail.endsWith('\n') ? tail.continuation ?? earlierLinks.get(row.path) : undefined,
        forkParentId: head.forkParentId ?? tail.forkParentId, title: titleSource ? names[titleSource] : undefined, titleSource,
        // A single record longer than the tail window (a long tool result or reply)
        // leaves the tail without a timestamp. Its write time is the file's mtime;
        // the head's timestamp is when the conversation started and sorts it too low.
        updatedAt: tail.updatedAt ?? (row.size > tailBytes ? statTime(row.stamp.split('|')[2]) : undefined) ?? head.updatedAt,
        // Only a file the tail window read whole can be known to hold no conversation.
        ...(row.size <= tailBytes && { contentless: !tail.conversation && !head.conversation }) };
    }
    const proofsChanged = await provePhysicalHistory(transport, workspace, rows, aliases);
    if (revision === this.revision) {
      this.files = rows;
      this.hydration = undefined;
      // Partial/vanished reads never become disk hints. Retrying just those
      // files should not rewrite the entire index on every sidebar refresh.
      if (this.disk && (this.dirty || proofsChanged || cache.size !== rows.size || changed.some(row => {
        const old = cache.get(row.path);
        return !old || reusable(row.metadata) || reusable(old.metadata);
      }))) {
        this.dirty = true;
        const persisted = await this.disk.write(rows.values());
        if (revision === this.revision) this.dirty = !persisted;
      }
    }
    diagnostic.event('history.index.updated', { files: rows.size, changed: changed.length, cached: rows.size - changed.length });
    return { files: [...rows.values()], truncated, limited };
  }
}
