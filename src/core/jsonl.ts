import { StringDecoder } from 'node:string_decoder';
import { diagnostic, summarize } from '../diagnostics';

export type JsonRecord = Record<string, unknown>;

/** A byte-oriented JSONL reader. A trailing partial line belongs to the next read. */
export class JsonlDecoder {
  private decoder = new StringDecoder('utf8');
  private pending = '';
  private discarding = false;
  invalidLines = 0;
  oversizedLines = 0;
  private totalBytes = 0;
  private totalLines = 0;
  private totalRecords = 0;

  get stats() {
    return { totalBytes: this.totalBytes, totalLines: this.totalLines, totalRecords: this.totalRecords,
      pendingBytes: Buffer.byteLength(this.pending), discarding: this.discarding,
      invalidLines: this.invalidLines, oversizedLines: this.oversizedLines, maxLineLength: this.maxLineLength };
  }

  constructor(private readonly maxLineLength = 16 * 1024 * 1024) {}

  reset(): void {
    diagnostic.event('jsonl.decoder.reset', { previous: this.stats });
    this.decoder = new StringDecoder('utf8');
    this.pending = '';
    this.discarding = false;
    this.invalidLines = 0;
    this.oversizedLines = 0;
    this.totalBytes = 0;
    this.totalLines = 0;
    this.totalRecords = 0;
  }

  push(chunk: Buffer | string): JsonRecord[] {
    const incoming = summarize(chunk);
    this.totalBytes += incoming.bytes;
    let text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    if (this.discarding) {
      const newline = text.indexOf('\n');
      if (newline === -1) {
        diagnostic.event('jsonl.decoder.discarding', { incoming, stats: this.stats });
        return [];
      }
      text = text.slice(newline + 1);
      this.discarding = false;
    }
    text = this.pending + text;
    this.pending = '';
    const records: JsonRecord[] = [];
    let start = 0;
    for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', start)) {
      const line = text.slice(start, end).trim();
      start = end + 1;
      this.totalLines++;
      if (line.length > this.maxLineLength) {
        this.oversizedLines++;
        diagnostic.event('jsonl.decoder.skipped', { reason: 'oversized-complete-line', line: this.totalLines, content: summarize(line), limit: this.maxLineLength }, 'warn');
        continue;
      }
      if (!line) continue;
      try {
        const record: unknown = JSON.parse(line);
        if (record && typeof record === 'object' && !Array.isArray(record)) records.push(record as JsonRecord);
        else {
          this.invalidLines++;
          diagnostic.event('jsonl.decoder.skipped', { reason: 'non-object-record', line: this.totalLines, content: summarize(line) }, 'warn');
        }
      } catch {
        this.invalidLines++;
        diagnostic.event('jsonl.decoder.skipped', { reason: 'invalid-json', line: this.totalLines, content: summarize(line) }, 'warn');
      }
    }
    this.pending = text.slice(start);
    if (this.pending.length > this.maxLineLength) {
      diagnostic.event('jsonl.decoder.skipped', { reason: 'oversized-pending-line', line: this.totalLines + 1, content: summarize(this.pending), limit: this.maxLineLength }, 'warn');
      this.pending = '';
      this.discarding = true;
      this.oversizedLines++;
    }
    this.totalRecords += records.length;
    diagnostic.event('jsonl.decoder.chunk', { incoming, decoded: records.length,
      types: records.reduce<Record<string, number>>((counts, record) => { const type = typeof record.type === 'string' ? record.type : 'unknown'; counts[type] = (counts[type] ?? 0) + 1; return counts; }, {}), stats: this.stats });
    return records;
  }
}
