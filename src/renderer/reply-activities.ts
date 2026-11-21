import { sedEdit } from '../shared/sed-edit';
import { t, type MessageKey } from '../shared/i18n';
import { diffLines } from 'diff';
import type { ChatMessage, MessageAttachment, PeerMessage, ToolBlock } from '../shared/types';
import { artifactPath } from './artifact-paths';

export type LineChanges = { added: number; removed: number };
type Category = 'thought' | 'command' | 'read' | 'write' | 'agent' | 'listAgents' | 'sent' | 'received' | 'other';
export type ToolActivity = {
  kind: 'tool'; key: string; tool: ToolBlock; category: Category; verb: string;
  file?: string; subject?: string; changes?: LineChanges;
};
export type Activity = ToolActivity | { kind: 'peer'; key: string; peer: PeerMessage; category: 'received' };
export type ReplyPart = { kind: 'text'; key: string; text: string } |
  { kind: 'image'; key: string; attachment: MessageAttachment } |
  { kind: 'activities'; key: string; offset: number | null; rows: Activity[] };

// The verb is a message key, translated when the row is built.
const tools: Record<string, [Category, MessageKey]> = {
  Bash: ['command', 'chat.verbRun'], PowerShell: ['command', 'chat.verbRun'],
  Read: ['read', 'chat.verbRead'], NotebookRead: ['read', 'chat.verbRead'], Write: ['write', 'chat.verbWrite'],
  Edit: ['write', 'chat.verbEdit'], MultiEdit: ['write', 'chat.verbEdit'], NotebookEdit: ['write', 'chat.verbEdit'],
  Agent: ['agent', 'chat.verbAgent'], Task: ['agent', 'chat.verbAgent'], ListAgents: ['listAgents', 'chat.verbListAgents'],
  SendMessage: ['sent', 'chat.verbSend'], SubagentHandback: ['sent', 'chat.verbHandback'],
  mcp__ccd_session_mgmt__send_message: ['sent', 'chat.verbSessionMessage'],
};

// A requested replacement, a Write body, or stdout that resembles a diff is not
// evidence of changes applied to a file. Only count native successful results.
function appliedChanges(tool: ToolBlock): LineChanges | undefined {
  if (tool.isError || tool.result === undefined) return;
  let added = 0, removed = 0;
  if (tool.editPatch?.length) {
    for (const hunk of tool.editPatch) for (const line of hunk.lines) {
      if (line.startsWith('+')) added++;
      if (line.startsWith('-')) removed++;
    }
  } else if (tool.cellEdit) {
    const changes = diffLines(tool.cellEdit.before, tool.cellEdit.after, { timeout: 25 });
    if (!changes) return;
    for (const change of changes) {
      if (change.added) added += change.count;
      if (change.removed) removed += change.count;
    }
  } else return;
  return { added, removed };
}

export function activityExcerpt(value: string) {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > 90 ? `${text.slice(0, 52)} … ${text.slice(-32)}` : text;
}

// Claude records these two user decisions as error results. Match only the
// fixed native receipts (the question/answer list after the discussion prefix varies).
const rejected = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). ";
const askCancelled = rejected + 'STOP what you are doing and wait for the user to tell you how to proceed.';
const askClarified = rejected + `To tell you how to proceed, the user said:
The user wants to clarify these questions.
    This means they may have additional information, context or questions for you.
    Take their response into account and then reformulate the questions if appropriate.
    Start by asking them what they would like to clarify.

    Questions asked:
- `;

export function toolDisplayState(tool: ToolBlock) {
  if (tool.isError) {
    if (tool.name === 'AskUserQuestion') {
      if (tool.result === askCancelled) return 'cancelled';
      if (tool.result?.startsWith(askClarified)) return 'discussion';
    }
    return 'error';
  }
  return tool.result !== undefined ? 'completed' : tool.unfinished ?? 'pending';
}

/** Claude Code shows at least one second ("Thought for 1s"). */
export function thoughtDuration(durationMs: number | undefined) {
  if (durationMs === undefined) return '';
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  return seconds >= 60 ? t('chat.minutesSeconds', { m: Math.floor(seconds / 60), s: seconds % 60 }) : t('chat.seconds', { s: seconds });
}

export function toolActivity(tool: ToolBlock): ToolActivity {
  if (tool.thought) return { kind: 'tool', key: `tool:${tool.id}`, tool, category: 'thought', verb: t('chat.verbThink'),
    subject: thoughtDuration(tool.thought.durationMs) || undefined };
  let [category, verb] = Object.hasOwn(tools, tool.name) ? [tools[tool.name][0], t(tools[tool.name][1])] : ['other' as const, tool.name];
  let input: Record<string, unknown> = {};
  try { input = JSON.parse(tool.input) ?? {}; } catch { /* Partial/legacy input stays available verbatim. */ }
  // An in-place sed is an edit: shown with its file and reconstructed changes.
  const sed = tool.name === 'Bash' && typeof input.command === 'string' ? sedEdit(input.command) : undefined;
  if (sed) [category, verb] = ['write', t('chat.verbEdit')];
  const value = (...keys: string[]) => {
    for (const key of keys) if (typeof input[key] === 'string' && input[key]) return input[key] as string;
  };
  const path = sed ? sed.files[0] : category === 'read' || category === 'write' || ['Grep', 'Glob', 'LS', 'LSP'].includes(tool.name)
    ? value('file_path', 'filePath', 'notebook_path', 'path') : undefined;
  const subject = sed ? (sed.files.length > 1 ? t('chat.sedFiles', { count: sed.files.length }) : 'sed') : category === 'command' ? value('command', 'description') : category === 'sent' ? value('to', 'recipient', 'session_id', 'summary') :
    category === 'agent' ? value('description', 'name', 'subagent_type') : undefined;
  return { kind: 'tool', key: `tool:${tool.id}`, tool, category, verb, file: path && artifactPath(path), subject,
    changes: category === 'write' ? appliedChanges(tool) : undefined };
}

/** Interleave using both recorded cursors: a delivery may sit between calls at the very same text offset. */
export function replyParts(message: Pick<ChatMessage, 'text' | 'tools' | 'peerMessages' | 'attachments'>, compact: boolean): ReplyPart[] {
  const parts: ReplyPart[] = [];
  let cursor = 0, nextTool = 0, textKey = 'start';
  function textUntil(end: number) {
    if (end <= cursor) return;
    parts.push({ kind: 'text', key: textKey, text: message.text.slice(cursor, end) });
    cursor = end;
  }
  function add(row: Activity, offset: number | null | undefined, fallback: number) {
    // Unknown historical positions must not imply adjacency. Orphan results
    // precede the loaded text; older recordings without offsets follow it.
    textUntil(Math.min(message.text.length, offset ?? fallback));
    const last = parts.at(-1);
    if (compact && offset != null && last?.kind === 'activities' && last.offset === offset) last.rows.push(row);
    else parts.push({ kind: 'activities', key: row.key, offset: offset ?? null, rows: [row] });
    textKey = `after:${row.key}`;
  }
  function toolsUntil(end: number, fallback: number) {
    while (nextTool < end && nextTool < message.tools.length) {
      const tool = message.tools[nextTool++];
      add(toolActivity(tool), tool.textOffset, tool.textOffset === null ? 0 : fallback);
    }
  }
  const peers = message.peerMessages ?? [];
  let nextPeer = 0;
  function peersUntil(end: number) {
    while (nextPeer < end && nextPeer < peers.length) {
      const peer = peers[nextPeer++];
      toolsUntil(peer.toolsBefore, peer.textOffset);
      add({ kind: 'peer', key: `peer:${JSON.stringify([peer.sender, peer.id])}`, category: 'received', peer }, peer.textOffset, peer.textOffset);
    }
  }
  for (const attachment of message.attachments ?? []) {
    if (!attachment.image) continue;
    const offset = Math.min(attachment.textOffset ?? message.text.length, message.text.length);
    peersUntil(attachment.peersBefore ?? peers.length);
    toolsUntil(attachment.toolsBefore ?? message.tools.length, offset);
    textUntil(offset);
    const key = `image:${attachment.id}`;
    parts.push({ kind: 'image', key, attachment });
    textKey = `after:${key}`;
  }
  peersUntil(peers.length);
  toolsUntil(message.tools.length, message.text.length);
  textUntil(message.text.length);
  return parts;
}

/** Category order follows first appearance; repeated paths count once, never by basename alone. */
export function summarizeActivities(rows: Activity[]) {
  const categories = new Map<Category, Activity[]>();
  let failed = 0, pending = 0, interrupted = 0, incomplete = 0, missingChanges = false;
  let changes: LineChanges | undefined;
  for (const row of rows) {
    const list = categories.get(row.category);
    if (list) list.push(row); else categories.set(row.category, [row]);
    if (row.kind !== 'tool') continue;
    const state = toolDisplayState(row.tool);
    if (state === 'error') failed++;
    else if (state === 'pending') pending++;
    else if (state === 'interrupted') interrupted++;
    else if (state === 'incomplete') incomplete++;
    else if (row.category === 'write') {
      if (!row.changes) missingChanges = true;
      else {
        changes ??= { added: 0, removed: 0 };
        changes.added += row.changes.added;
        changes.removed += row.changes.removed;
      }
    }
  }
  const labels = Array.from(categories, ([category, items]) => {
    const n = items.length;
    switch (category) {
      case 'thought': {
        const known = items.flatMap(item => item.kind === 'tool' && item.tool.thought?.durationMs !== undefined ? [item.tool.thought.durationMs] : []);
        return known.length ? t('chat.thoughtFor', { duration: thoughtDuration(known.reduce((a, b) => a + b, 0)) }) : t('chat.verbThink');
      }
      case 'command': return t('chat.ranCommands', { count: n });
      case 'read': case 'write': {
        const paths = new Set<string>();
        for (const item of items) {
          // Without a known path or a successful result, count requests, not files affected.
          if (item.kind !== 'tool' || !item.file || item.tool.isError || item.tool.result === undefined) return t(category === 'read' ? 'chat.readTimes' : 'chat.editTimes', { count: n });
          paths.add(item.file);
        }
        return t(category === 'read' ? 'chat.readFiles' : 'chat.editFiles', { count: paths.size });
      }
      case 'agent': return t('chat.agentTimes', { count: n });
      case 'listAgents': return t('chat.listAgentTimes', { count: n });
      case 'sent': return t('chat.sentTimes', { count: n });
      case 'received': return t('chat.received', { count: n });
      case 'other': return t('chat.otherActions', { count: n });
    }
  });
  return { labels, failed, pending, interrupted, incomplete, changes, partialChanges: !!changes && missingChanges };
}
