/** Only durable, newline-terminated main-session replies can raise a sidebar notification.
 * In particular an idle redraw, tool result, truncated answer or lone timing row cannot. */
export function completedReplyOffset(data: Buffer, start: number, after: number, sessionId: string): number | undefined {
  let completed: number | undefined;
  let candidate: string | null | undefined;
  for (let at = 0, lf: number; (lf = data.indexOf(10, at)) !== -1; at = lf + 1) {
    let row;
    try { row = JSON.parse(data.toString('utf8', at, lf)); } catch { candidate = undefined; continue; }
    if (!row || typeof row !== 'object' || row.isSidechain || row.sessionId && row.sessionId !== sessionId) continue;
    const end = start + lf + 1;
    if (row.type === 'last-prompt' && row.rewound || row.type === 'system' && row.subtype === 'compact_boundary') {
      candidate = undefined;
      if (end > after) completed = undefined;
    } else if (row.type === 'system' && row.subtype === 'turn_duration') {
      if (end > after && candidate !== undefined && (!row.parentUuid || row.parentUuid === candidate)) completed = end;
      candidate = undefined;
    } else if (row.type === 'user' || row.type === 'attachment' && row.attachment?.humanTurn) {
      candidate = undefined;
    } else if (row.type === 'assistant') {
      candidate = undefined;
      const msg = row.message, content = msg?.content;
      if (row.isMeta || row.isApiErrorMessage || row.isCompactSummary || row.isVisibleInTranscriptOnly || row.isUnmetered || msg?.model === '<synthetic>') continue;
      const text = typeof content === 'string' ? !!content.trim() : Array.isArray(content) &&
        content.some(b => b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) && !content.some(b => b?.type === 'tool_use');
      if (!text) continue;
      if (msg.stop_reason === 'end_turn' || msg.stop_reason === 'stop_sequence') {
        if (end > after) completed = end;
      } else if (msg.stop_reason == null) candidate = typeof row.uuid === 'string' ? row.uuid : null;
    }
  }
  return completed;
}
