import type { JsonRecord } from './jsonl';

/** The prefix and suffix Claude Code 2.1.300–2.1.330 wrap around a SendMessage
 * delivered to a subagent (a user record with `origin.kind: "coordinator"` and `isMeta`). */
const coordinatorWrapper = /^The coordinator sent a message while you were working:\n([\s\S]*?)(?:\n\nAddress this before completing your current task\.?)?\s*$/u;

/** The message the main agent sent, without the native wrapper around it. */
export function coordinatorMessage(text: string): string {
  return coordinatorWrapper.exec(text)?.[1]?.trim() || text;
}

const object = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};

/**
 * A subagent's own transcript (`<session>/subagents/agent-<id>.jsonl`) is a
 * sidechain of the session: every record has `isSidechain: true`, the parent's
 * `sessionId` and the subagent's `agentId`. Shown on its own, it is a
 * conversation like the main one: its launch prompt and each SendMessage that
 * resumes it are the human turns, the subagent's replies the answers. Returns
 * the record as the main transcript would hold it, or nothing for a record of
 * another chain.
 */
export function adoptSidechain(record: JsonRecord, agentId: string): JsonRecord | undefined {
  if (record.isSidechain !== true || record.agentId !== undefined && record.agentId !== agentId) return;
  const adopted: JsonRecord = { ...record, isSidechain: false };
  const message = object(record.message);
  if (record.type === 'user' && object(record.origin).kind === 'coordinator' && typeof message.content === 'string') {
    // A message from the main agent starts a new turn, as a prompt would. The
    // native record is also marked `isMeta` (model context, not typed input).
    delete adopted.origin;
    delete adopted.isMeta;
    adopted.message = { ...message, content: coordinatorMessage(message.content) };
  }
  return adopted;
}
