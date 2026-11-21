export interface EditHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** Claude writes the applied diff on the tool result record, outside message.content. */
export function editPatch(value: unknown): EditHunk[] | undefined {
  if (!Array.isArray(value) || !value.length) return;
  const hunks: EditHunk[] = [];
  for (const hunk of value) {
    if (!hunk || typeof hunk !== 'object') return;
    const { oldStart, oldLines, newStart, newLines, lines } = hunk;
    if (![oldStart, oldLines, newStart, newLines].every(n => Number.isSafeInteger(n) && n >= 0) ||
        !Array.isArray(lines) || !lines.every(l => typeof l === 'string' && /^[ +\\-]/.test(l))) return;
    hunks.push({ oldStart, oldLines, newStart, newLines, lines });
  }
  return hunks;
}
