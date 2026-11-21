import type { RedirectFile } from './shell-redirects';

// A background shell's or monitor's output in the task column: the last 256 KiB
// first, older bytes on request (512 KiB a step, at most 4 MiB kept), new bytes
// appended while it runs (more than 1 MiB at once reads the tail again).
export const OUTPUT_TAIL_BYTES = 256 * 1024;
export const OUTPUT_PAGE_BYTES = 512 * 1024;
export const OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
export const OUTPUT_APPEND_BYTES = 1024 * 1024;

/** Claude Code 2.1.300–2.1.330 end a task's output file with "\n[exited with code N]\n",
 * or "\n[killed]\n" when its process went away first. */
export function outputTrailer(text: string): { body: string; exitCode?: number; killed?: boolean } {
  const match = /(?:^|\n)\[(?:exited with code (-?\d{1,4})|(killed))\]\n?$/.exec(text);
  if (!match) return { body: text };
  return { body: text.slice(0, match.index), ...(match[1] !== undefined ? { exitCode: Number(match[1]) } : { killed: true }) };
}

/** Text as a terminal would leave it: colours and cursor codes dropped, a carriage
 * return overwriting its line (progress bars), backspaces applied. */
export function terminalText(raw: string): string {
  const text = raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r+\n/g, '\n');
  const lines = text.split('\n').map(line => {
    let shown = line;
    if (shown.includes('\r')) shown = shown.split('\r').reduce((screen, part) => part + screen.slice(part.length), '');
    while (shown.includes('\x08')) { const next = shown.replace(/[^\x08]\x08/, ''); if (next === shown) break; shown = next; }
    return shown;
  });
  return lines.join('\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

/** Bytes to skip at the start of a window cut mid-file: a broken UTF-8 sequence, then
 * the rest of a broken line when its end is near (so the first shown line is whole). */
export function windowStart(bytes: Uint8Array, cut: boolean): number {
  if (!cut) return 0;
  let skip = 0;
  while (skip < 3 && skip < bytes.length && (bytes[skip] & 0xc0) === 0x80) skip++;
  const newline = bytes.subarray(skip, skip + 4096).indexOf(10);
  return newline >= 0 ? skip + newline + 1 : skip;
}

/** The length of `bytes` without an unfinished UTF-8 sequence at the end (read again next time). */
export function completeUtf8(bytes: Uint8Array): number {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const byte = bytes[bytes.length - back];
    if ((byte & 0xc0) === 0x80) continue;
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? bytes.length - back : bytes.length;
  }
  return bytes.length;
}

/** Where the shown output comes from: the task's own output file, a file its
 * command redirected to (`file:<n>`, n into redirectFiles), or the transcript. */
export type OutputSourceKey = 'task' | 'transcript' | `file:${number}`;
export interface OwnOutput { found: boolean; empty: boolean }

/** The source shown without a choice: the task's own output when it has any; else
 * the file its command wrote to; else what the transcript recorded when the task
 * file is gone; else the (empty or missing) task output itself. */
export function defaultOutputSource(own: OwnOutput, files: readonly RedirectFile[], transcript: boolean): OutputSourceKey {
  if (own.found && !own.empty) return 'task';
  if (files.length) return 'file:0';
  if (!own.found && transcript) return 'transcript';
  return 'task';
}

/** A choice that still names an existing source, else the default. */
export function shownOutputSource(choice: string | undefined, own: OwnOutput, files: readonly RedirectFile[], transcript: boolean): OutputSourceKey {
  if (choice === 'task' || choice === 'transcript' && transcript) return choice;
  const file = /^file:(\d)$/.exec(choice ?? '');
  if (file && Number(file[1]) < files.length) return choice as OutputSourceKey;
  return defaultOutputSource(own, files, transcript);
}
