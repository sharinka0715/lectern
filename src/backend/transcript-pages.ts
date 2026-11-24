import { completedReplyOffset } from '../core/reply-completion';
import { t } from '../shared/i18n';
import { isTranscriptTurnStart } from '../core/transcript-store';
import { adoptSidechain } from '../core/subagent-records';
import { goalStatusOf } from '../core/goal-records';
import type { JsonRecord } from '../core/jsonl';
import { diagnostic } from '../diagnostics';
import type { Workspace } from '../shared/types';
import { historyPageSizeMiB } from '../shared/history-paging';
import { quoteShell as q, type Transport } from './transport';

export interface HistoryCursor { before: number; inode: string; size: number; guard?: string; layout?: string; frozenStamp?: string }
export interface HistoryPage { jsonl: Buffer; olderCursor?: HistoryCursor; skippedHistoryRecords?: number; sourceSessionId?: string }
export interface LiveCursor { offset: number; inode: string; stamp?: string; guard?: string; skipPartial?: boolean }
interface FileWindow { inode: string; size: number; offset: number; end: number; data: Buffer; reset: boolean; stamp?: string; guard?: string }

const WINDOW = 128 * 1024;
const PAGE_TURNS = 24;
const PAGE_ROWS = 256;
// UTF-8 needs at most three bytes per UTF-16 code unit. Anything larger than
// this cannot fit the decoder's 16M-code-unit record limit, even as CJK text.
const MAX_RECORD_BYTES = 3 * 16 * 1024 * 1024;
const stale = () => t('backend.transcriptChanged');

function checkCursor(cursor: HistoryCursor) {
  if (!cursor || !/^\d+$/.test(cursor.inode) || !Number.isSafeInteger(cursor.size) ||
      !Number.isSafeInteger(cursor.before) || cursor.before <= 0 || cursor.before > cursor.size) throw new Error(stale());
}

// Stat the open file descriptor. A rename between opening the file and seeking
// cannot silently combine metadata from one inode with bytes from another.
function withTranscript(files: string[], body: string, missing: string) {
  return `set -e
for f in ${files.map(q).join(' ')}; do
 d=\${f%/*}; [ ! -L "$d" ] && [ ! -L "\${d%/*}" ] && [ -f "$f" ] && [ ! -L "$f" ] || continue
 exec 3< "$f"
 case "$(uname -s)" in (Darwin|*BSD) stamp=$(stat -Lf '%i %z %.9Fm %.9Fc' /dev/fd/3);; (*) stamp=$(stat -Lc '%i %s %y %z' /dev/fd/3);; esac
 set -- $stamp; inode=$1; size=$2; shift 2; stamp="$*"
 ${guardAt}
 ${body}
 exit 0
done
${missing}`;
}

// dd seeks on the regular file. Any alignment padding discarded by tail/head
// is at most one block on each side, regardless of the absolute byte offset.
const range = `if [ "$end" -gt "$start" ]; then
 dd bs=32768 skip=$((start / 32768)) count=$(((end - 1) / 32768 - start / 32768 + 1)) 2>/dev/null <&3 |
 tail -c +$((start % 32768 + 1)) | head -c $((end - start))
fi`;

// Keep fd 3 at byte zero for the main data read. BSD duplicates an open file
// description when opening /dev/fd/3, so each independently seeking reader
// reopens the path and checks the new descriptor against the original inode.
const openSameFile = `exec 4< "$f"
 [ /dev/fd/3 -ef /dev/fd/4 ] || { echo ${q(stale())} >&2; exit 1; }`;

// The checksum covers a small immutable sample immediately before a cursor.
// It detects copy-truncate followed by rapid regrowth even if inode/size
// alone would look like an append. Idle polls reuse the previous stat stamp.
const guardAt = `guard_at() (
 ${openSameFile}
 end=$1; start=$((end - 128)); [ "$start" -ge 0 ] || start=0
 set -- $( { ${range}; } 3<&4 | cksum)
 printf '%s-%s' "$1" "$2"
)`;

export function liveTranscriptScript(files: string[], cursor: LiveCursor | undefined, tailFirst: boolean) {
  const start = cursor?.offset ?? 0;
  return withTranscript(files, `reset=0; start=${start}; guard=${q(cursor?.guard ?? '')}
 if [ "$inode" != ${q(cursor?.inode ?? '')} ] || [ "$size" -lt "$start" ]; then reset=1
 elif [ "$stamp" != ${q(cursor?.stamp ?? '')} ] && [ -n "$guard" ] && [ "$(guard_at "$start")" != "$guard" ]; then reset=1
 fi
 if [ "$reset" -eq 1 ]; then
  start=0
  ${tailFirst ? `if [ "$size" -gt ${WINDOW} ]; then start=$((size - ${WINDOW})); fi` : ''}
 fi
 end=$((start + 524288)); [ "$end" -le "$size" ] || end=$size
 if [ "$reset" -eq 1 ] || [ "$end" != "$start" ]; then guard=$(guard_at "$end"); fi
 printf '%s %s %s %s %s %s\\n' "$size" "$inode" "$start" "$reset" "$guard" "$stamp"
 ${range}`, `printf '0 missing 0 ${cursor?.inode === 'missing' ? 0 : 1} - -\\n'`);
}

export function decodeFileWindow(frame: Buffer): FileWindow {
  const lf = frame.indexOf(10);
  const match = lf >= 0 && /^(\d+) (\d+|missing) (\d+) ([01]) (\d+-\d+|-) ([0-9.: +TZ-]+)$/.exec(frame.subarray(0, lf).toString('ascii'));
  if (!match) throw new Error('Invalid transcript read response');
  const size = Number(match[1]), offset = Number(match[3]), data = frame.subarray(lf + 1);
  const end = Math.min(offset + 524288, size);
  if (!Number.isSafeInteger(size) || !Number.isSafeInteger(offset) || offset > size ||
      data.length !== end - offset) throw new Error('Invalid transcript byte range');
  return { size, end, offset, inode: match[2], reset: match[4] === '1', guard: match[5], stamp: match[6], data };
}

// A destructive rewind can depend on a duplicate prompt's ordinal. Bind its
// key dispatch to the very same file revision that produced the observed branch.
// Claude Code may append its own notices meanwhile, e.g. the one-time auto mode
// note ("Auto mode lets Claude handle permission prompts automatically …", a
// system/informational record) when the first command is submitted in auto mode.
// They never change the branch's prompts: growth made only of such complete lines,
// after an unchanged prefix (the guard sample), keeps the revision. So does a new
// modification time alone: Claude Code 2.1.330 sets it (utimes, no write) when /rewind
// first opens its menu in a process, so the first rewind after a resume failed at its
// first menu key ("The conversation history file has changed").
const noticesOnly = `awk 'BEGIN { ok = 1 } !/^[{]"parentUuid":("[^"]*"|null),"isSidechain":(true|false),"type":"system","subtype":"informational",/ { ok = 0 } END { print (ok && NR > 0 ? "ok" : "no") }'`;
export function transcriptVersionGuard(files: string[], cursor: LiveCursor) {
  if (!/^\d+$/.test(cursor.inode) || !Number.isSafeInteger(cursor.offset) || !cursor.stamp) throw new Error(stale());
  const sample = `[ "$(guard_at ${cursor.offset})" = ${q(cursor.guard ?? '')} ]`;
  const notices = cursor.guard && /^\d+-\d+$/.test(cursor.guard)
    ? ` || { [ "$size" = ${cursor.offset} ] && ${sample}; } || { [ "$size" -gt ${cursor.offset} ] && ${sample} && start=${cursor.offset} && end=$size && [ "$( { ${range}; } | ${noticesOnly})" = ok ]; }` : '';
  return `(\n${withTranscript(files, `[ "$inode" = ${q(cursor.inode)} ] && { { [ "$size" = ${cursor.offset} ] && [ "$stamp" = ${q(cursor.stamp)} ]; }${notices}; } || exit 1`, 'exit 1')}\n) || { echo ${q(stale())} >&2; exit 1; }\n`;
}

/** Run a guard before input; when it fails, print `receipt` and stop the script with
 * status 0 (an explicit "nothing was sent" for the caller) instead of failing. */
export function receiptOnFailure(guard: string, receipt: string) {
  return `(\n${guard}) 2>/dev/null || { printf '%s' ${q(receipt)}; exit 0; }\n`;
}

function verified(cursor: HistoryCursor) {
  return `[ "$inode" = ${q(cursor.inode)} ] && [ "$size" -ge ${cursor.size} ] ${cursor.frozenStamp ? `&& [ "$size" = ${cursor.size} ] && [ "$stamp" = ${q(cursor.frozenStamp)} ]` : ''} ${cursor.guard ? `&& [ "$(guard_at ${cursor.size})" = ${q(cursor.guard)} ]` : ''} || { echo ${q(stale())} >&2; exit 1; }`;
}
const noFile = () => `echo ${q(stale())} >&2; exit 1`;

export function historyRevisionGuard(file: string, cursor: HistoryCursor) {
  return `(\n${withTranscript([file], verified(cursor), noFile())}\n) || exit 1\n`;
}

// A repair read is not another user-requested page. Try just its suffix from
// the nearest candidate question; if the projection rejects it (e.g. a fork),
// the caller can consume the rest without downloading the same bytes again.
export function* repairSlices(page: HistoryPage, cursor: HistoryCursor, sessionId: string): Generator<HistoryPage> {
  const data = page.jsonl;
  for (let end = data.length - 1; end > 0;) {
    const start = data.lastIndexOf(10, end - 1) + 1;
    if (!start) break;
    let prompt = false;
    try { prompt = isTranscriptTurnStart(JSON.parse(data.toString('utf8', start, end)), page.sourceSessionId ?? sessionId); }
    catch { /* Report invalid records once, in the normal decoder. */ }
    if (prompt) {
      const suffix = data.subarray(start);
      yield { jsonl: suffix, sourceSessionId: page.sourceSessionId, olderCursor: { ...cursor, before: cursor.before - suffix.length } };
      // An oversized skipped record, if any, precedes the returned bytes.
      yield { ...page, jsonl: data.subarray(0, start) };
      return;
    }
    end = start - 1;
  }
  yield page;
}

export class TranscriptPages {
  /** With `agentId`, the files are that subagent's own transcript: its sidechain
   * records count as turns, as they do in its column. */
  constructor(private readonly transport: Transport, private readonly workspace: Workspace,
    private readonly sessionId: string, private readonly files: string[], private readonly historyGuard = '', private readonly agentId?: string) {}

  private turnStart(record: JsonRecord) {
    const row = this.agentId ? adoptSidechain(record, this.agentId) : record;
    return !!row && isTranscriptTurnStart(row, this.sessionId);
  }

  private async run(script: string, maxBytes: number, tag = 'session.history_page') {
    return (await this.transport.run(this.workspace, this.historyGuard + script, { maxBytes, tag })).stdout;
  }

  private async bytes(cursor: HistoryCursor, start: number, end: number) {
    if (start === end) return Buffer.alloc(0);
    const script = withTranscript(this.files, `${verified(cursor)}
start=${start}; end=${end}
${range}`, noFile());
    const data = await this.run(script, end - start + 1);
    diagnostic.event('backend.history.byte_range', { sessionId: this.sessionId, inode: cursor.inode, offset: start, end, bytes: data.length }, 'debug');
    if (data.length !== end - start) throw new Error(stale());
    return data;
  }

  // A page entirely inside one huge tool result or unfinished append needs
  // one earlier LF. Find its offset on the target, even over SSH. Only an
  // integer crosses the network; each tail invocation sees a bounded block.
  private async lineStart(cursor: HistoryCursor, before: number) {
    const script = withTranscript(this.files, `${verified(cursor)}
end=${before}; block=${WINDOW}
while [ "$end" -gt 0 ]; do
 start=$((end - block)); [ "$start" -ge 0 ] || start=0
 ${openSameFile}
 trailing=$({ { ${range}; } 3<&4; printf .; } | tail -n 1 | wc -c)
 length=$((end - start)); trailing=$((trailing - 1))
 if [ "$trailing" -lt "$length" ]; then printf '%s' "$((end - trailing))"; exit 0; fi
 end=$start; block=1048576
done
printf 0`, noFile());
    const output = (await this.run(script, 32)).toString('ascii');
    const offset = Number(output);
    if (!/^\d+$/.test(output) || !Number.isSafeInteger(offset) || offset > before) throw new Error(stale());
    diagnostic.event('backend.history.line_start', { sessionId: this.sessionId, inode: cursor.inode, before, start: offset }, 'debug');
    return offset;
  }

  /** lineStart and, when the result fits `limit`, the bytes from there to `end`, in one command. */
  private async lineStartWithBytes(cursor: HistoryCursor, before: number, end: number, limit: number) {
    const script = withTranscript(this.files, `${verified(cursor)}
target=${end}; end=${before}; block=${WINDOW}; found=0
while [ "$end" -gt 0 ]; do
 start=$((end - block)); [ "$start" -ge 0 ] || start=0
 ${openSameFile}
 trailing=$({ { ${range}; } 3<&4; printf .; } | tail -n 1 | wc -c)
 length=$((end - start)); trailing=$((trailing - 1))
 if [ "$trailing" -lt "$length" ]; then found=$((end - trailing)); break; fi
 end=$start; block=1048576
done
printf '%s\n' "$found"
if [ $((target - found)) -le ${limit} ]; then
 start=$found; end=$target
 ${range}
fi`, noFile());
    const output = await this.run(script, limit + 32);
    const lf = output.indexOf(10);
    const text = lf > 0 ? output.subarray(0, lf).toString('ascii') : '';
    const offset = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(offset) || offset > before) throw new Error(stale());
    const data = output.subarray(lf + 1);
    if (end - offset <= limit ? data.length !== end - offset : data.length) throw new Error(stale());
    diagnostic.event('backend.history.line_start', { sessionId: this.sessionId, inode: cursor.inode, before, start: offset, withBytes: data.length }, 'debug');
    return { start: offset, data: end - offset <= limit ? data : undefined };
  }

  /** Use the same verified file and range reader as the open conversation. Cold
   * discovery never calls this: the original EOF is the per-file baseline. */
  async replyProgress(inode: string, size: number, after: number) {
    const cursor = { inode, size, before: size };
    let start = Math.max(0, after - 16384), end = Math.min(size, after + WINDOW * 2);
    let data = await this.bytes(cursor, start, end);
    if (end === size && data.lastIndexOf(10) < after - start) return { inode, offset: end };
    if (start) {
      const lf = data.indexOf(10);
      // Recover the prefix if an old partial write finishes now, or a legacy
      // timing row needs its preceding null-stop answer for corroboration.
      if (lf < 0 || start + lf >= after || data.includes('turn_duration')) {
        const boundary = await this.lineStart(cursor, start);
        if (end - boundary <= MAX_RECORD_BYTES) { data = Buffer.concat([await this.bytes(cursor, boundary, start), data]); start = boundary; }
        else { start += lf < 0 ? data.length : lf + 1; data = data.subarray(lf < 0 ? data.length : lf + 1); }
      } else { start += lf + 1; data = data.subarray(lf + 1); }
    }
    const lf = data.lastIndexOf(10);
    if (end < size && start + lf + 1 > after) {
      data = data.subarray(0, lf + 1); end = start + data.length;
    } else if (end < size) {
      // One large intersected line. Find its end on the host rather than
      // repeatedly transferring its growing prefix on successive polls.
      const script = withTranscript(this.files, `${verified(cursor)}\nstart=${end}; end=${size}\n{ ${range}; } | head -n 1 | wc -c`, noFile());
      const count = Number((await this.run(script, 64)).toString().trim());
      if (!Number.isSafeInteger(count) || count <= 0 || count > size - end) throw new Error(stale());
      if (end + count - start <= MAX_RECORD_BYTES) data = Buffer.concat([data, await this.bytes(cursor, end, end + count)]);
      end += count;
    }
    return { inode, offset: end, completedThrough: completedReplyOffset(data, start, after, this.sessionId) };
  }

  async older(cursor: HistoryCursor, sizeMiB?: number): Promise<HistoryPage> {
    checkCursor(cursor);
    const pageBytes = Math.round(historyPageSizeMiB(sizeMiB) * 1024 * 1024);
    const offset = Math.max(0, cursor.before - pageBytes);
    // 左边界落在一条记录中时，将这条记录完整纳入本页。下一页从其起点往前读。
    // 行首与本页字节在同一条命令里取回。
    const found = offset ? await this.lineStartWithBytes(cursor, offset, cursor.before, MAX_RECORD_BYTES + 1) : undefined;
    const start = found?.start ?? 0;
    let jsonl: Buffer, skipped = 0;
    if (cursor.before - start <= MAX_RECORD_BYTES + 1) {
      jsonl = found?.data ?? await this.bytes(cursor, start, cursor.before);
    } else {
      // 窗口本身至多 32 MiB，只有最左侧跨界的记录可能超过上限。
      const window = await this.bytes(cursor, offset, cursor.before);
      const lf = window.indexOf(10);
      if (lf < 0 || window.at(-1) !== 10) throw new Error(stale());
      if (offset + lf - start > MAX_RECORD_BYTES) {
        jsonl = window.subarray(lf + 1);
        skipped = 1;
      } else {
        jsonl = Buffer.concat([await this.bytes(cursor, start, offset), window]);
      }
    }
    if (jsonl.length && jsonl.at(-1) !== 10) throw new Error(stale());
    diagnostic.event('backend.history.older_page', { sessionId: this.sessionId, before: cursor.before,
      nextBefore: start, pageBytes, selectedBytes: jsonl.length, skipped }, 'debug');
    return { jsonl, olderCursor: start ? { ...cursor, before: start } : undefined, ...(skipped && { skippedHistoryRecords: skipped }) };
  }

  /**
   * The newest `goal_status` record before `cursor.before` (Claude Code's native /goal,
   * core/goal-records.ts), for a conversation whose first page does not reach back to it.
   * The target streams those bytes through a fixed-string grep for the record's own key
   * sequence (a quoted copy inside a message is escaped and never matches), keeps lines up
   * to 64 KiB and returns the last four; only a record of this session in the exact shape counts.
   */
  async lastGoalStatus(cursor: HistoryCursor): Promise<JsonRecord | undefined> {
    checkCursor(cursor);
    const script = withTranscript(this.files, `${verified(cursor)}
start=0; end=${cursor.before}
{ ${range}; } | { LC_ALL=C grep -F '"attachment":{"type":"goal_status",' || [ "$?" = 1 ]; } | LC_ALL=C awk 'length($0) <= 65536' | tail -n 4`, noFile());
    const lines = (await this.run(script, 4 * 65538, 'session.goal_probe')).toString('utf8').split('\n').filter(Boolean).reverse();
    for (const line of lines) {
      try {
        const record = JSON.parse(line) as JsonRecord;
        if (goalStatusOf(record) && record.sessionId === this.sessionId && !record.isSidechain) return record;
      } catch { /* not a record */ }
    }
  }

  async page(window: FileWindow): Promise<HistoryPage & { skipPartial?: boolean }> {
    let { offset, data } = window;
    const end = window.end;
    const cursor = { before: end, size: window.size, inode: window.inode, guard: window.guard };
    if (!offset) return this.select(data, 0, cursor);
    const lf = data.indexOf(10);
    if (lf >= 0 && data.indexOf(10, lf + 1) >= 0) {
      return this.select(data.subarray(lf + 1), offset + lf + 1, cursor);
    }
    // Include the intersected record when discarding its first fragment would
    // leave no complete lines. Keep one ordinary window immediately before it
    // so a giant final result or in-progress append can still show its prompt.
    const start = await this.lineStart(cursor, offset);
    const prefixOffset = Math.max(0, start - WINDOW);
    const lineEnd = lf < 0 ? end : offset + lf;
    const oversized = lineEnd - start > MAX_RECORD_BYTES;
    const prefix = await this.bytes(cursor, prefixOffset, oversized ? start : offset);
    let first = 0;
    if (prefixOffset > 0) {
      const prefixLF = prefix.subarray(0, start - prefixOffset).indexOf(10);
      first = prefixLF < 0 ? start - prefixOffset : prefixLF + 1;
    }
    if (oversized) {
      diagnostic.event('backend.history.oversized_record', { start, lineEnd, bytes: lineEnd - start }, 'warn');
      const page = this.select(prefix.subarray(first), prefixOffset + first, cursor);
      return { ...page, jsonl: lf < 0 ? page.jsonl : Buffer.concat([page.jsonl, data.subarray(lf + 1)]), skipPartial: lf < 0, skippedHistoryRecords: 1 };
    }
    data = Buffer.concat([prefix.subarray(first), data]);
    offset = prefixOffset + first;
    return this.select(data, offset, cursor);
  }

  private select(data: Buffer, offset: number, cursor: HistoryCursor): HistoryPage {
    let turns = 0, rows = 0, first = 0;
    let newline = data.lastIndexOf(10);
    while (newline >= 0) {
      const start = newline === 0 ? 0 : data.lastIndexOf(10, newline - 1) + 1;
      const bytes = data.subarray(start, newline);
      // Larger records can be displayed; avoid parsing a multi-MB attachment
      // again merely to decide where to cut this page.
      if (bytes.length < WINDOW) {
        try {
          const record = JSON.parse(bytes.toString('utf8'));
          if (record && typeof record === 'object' && this.turnStart(record)) turns++;
        } catch { /* The normal decoder reports malformed records. */ }
      }
      if (++rows >= PAGE_ROWS || turns >= PAGE_TURNS) { first = start; break; }
      newline = start - 1;
    }
    // Keep intersected turns. Only the projected branch can tell whether a
    // leading result, image or assistant block needs its prompt from before.
    const before = offset + first;
    return { jsonl: data.subarray(first), olderCursor: before ? { ...cursor, before } : undefined };
  }
}
