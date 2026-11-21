import type { JsonRecord } from './jsonl';

// Claude Code decides how to show a thinking block from its signature, a
// base64 protobuf: field 2 → field 1 → field 8 names the block's purpose.
// "narration" is a progress note written to the user and shown as text; the
// TUI folds every other non-empty thinking block into "Thought for Ns".
function varint(bytes: Uint8Array, offset: number): { value: number; next: number } | undefined {
  let value = 0, scale = 1;
  for (let i = 0; i < 10; i++) {
    const at = offset + i;
    if (at >= bytes.length) return;
    const byte = bytes[at];
    value += (byte & 127) * scale;
    if ((byte & 128) === 0) return { value, next: at + 1 };
    scale *= 128;
  }
}
function field(bytes: Uint8Array, wanted: number): Uint8Array | undefined {
  let offset = 0, found: Uint8Array | undefined;
  while (offset < bytes.length) {
    const key = varint(bytes, offset);
    if (!key) return;
    offset = key.next;
    const type = key.value & 7, number = Math.floor(key.value / 8);
    if (type === 0) {
      const skipped = varint(bytes, offset);
      if (!skipped) return;
      offset = skipped.next;
    } else if (type === 1) offset += 8;
    else if (type === 5) offset += 4;
    else if (type === 2) {
      const length = varint(bytes, offset);
      if (!length || length.value > bytes.length - length.next) return;
      if (number === wanted) found = bytes.subarray(length.next, length.next + length.value);
      offset = length.next + length.value;
    } else return;
    if (offset > bytes.length) return;
  }
  return found;
}

export function thinkingPurpose(signature: unknown): string | undefined {
  if (typeof signature !== 'string' || !signature || !/^[A-Za-z0-9+/=_-]+$/.test(signature)) return;
  const outer = field(Buffer.from(signature, 'base64'), 2);
  const inner = outer && field(outer, 1);
  const purpose = inner && field(inner, 8);
  return purpose && Buffer.from(purpose).toString('utf8');
}

/** A thinking block Claude Code shows as reply text rather than folding it. */
export function isNarration(block: JsonRecord): boolean {
  return block.type === 'thinking' && typeof block.thinking === 'string' && !!block.thinking.trim()
    && thinkingPurpose(block.signature) === 'narration';
}

/** Non-empty reasoning the TUI folds into "Thought for Ns". */
export function isFoldedThought(block: JsonRecord): boolean {
  return block.type === 'thinking' && typeof block.thinking === 'string' && !!block.thinking.trim() && !isNarration(block);
}
