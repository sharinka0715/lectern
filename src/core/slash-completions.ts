/** One run of slash completion rows: lines [start, end) of the parsed rows. */
export interface CompletionBlock {
  start: number;
  end: number;
  /** The focused (❯) rows; `description` joins its wrapped rows with single spaces. */
  focused: { command: string; hasDescription: boolean; description?: string }[];
}

/** Completion descriptions can span multiple terminal rows: a skill's long description,
 * CJK or not, wraps onto rows aligned under the description column, including when they
 * start with /. Such a row belongs to the row above it, never starts a new entry. */
export function completionBlocks(lines: string[]): CompletionBlock[] {
  const blocks: CompletionBlock[] = [];
  let active: CompletionBlock | undefined, last: CompletionBlock['focused'][number] | undefined, descriptionColumn = -1;
  for (const [i, line] of lines.entries()) {
    if (active && descriptionColumn >= 0 && line.search(/\S/u) >= descriptionColumn) {
      active.end = i + 1;
      if (last?.description !== undefined) last.description += ' ' + line.trim();
      continue;
    }
    const row = /^(\s*)([❯>]\s*)?(\/\S+)(?:([ \t]+)(\S.*))?$/u.exec(line.trimEnd());
    if (!row) { active = last = undefined; continue; }
    if (!active) {
      active = { start: i, end: i + 1, focused: [] };
      blocks.push(active);
    }
    active.end = i + 1;
    descriptionColumn = row[5] ? row[1].length + (row[2]?.length ?? 0) + row[3].length + row[4].length : -1;
    last = row[2] ? { command: row[3], hasDescription: !!row[5], ...(row[5] ? { description: row[5] } : {}) } : undefined;
    if (last) active.focused.push(last);
  }
  return blocks;
}
