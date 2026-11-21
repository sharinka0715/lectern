import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ConversationTask, PeerMessage, ToolBlock } from '../shared/types';
import { readTaskList } from './conversation-tasks';
import { editPatch } from '../shared/edit-patch';
import type { JsonRecord } from './jsonl';
import { transcriptAttachments, type TranscriptAttachment } from './transcript-attachments';
import { requestUsage, type ContextUsageObservation } from './request-usage';
import { isFoldedThought, isNarration } from './thinking';

type Kind = 'user' | 'assistant' | 'command' | 'companion' | 'result' | 'duration' | 'compact' | 'attachment' | 'notification' | 'interruption' | 'hidden';
interface Preservation { anchor?: string; ids?: string[]; head?: string; tail?: string; all: string[] }

export interface TranscriptRow {
  key: string;
  parent: string | null;
  order: number;
  kind: Kind;
  timestamp?: string;
  text?: string;
  attachments?: TranscriptAttachment[];
  responseId?: string;
  responseComplete?: boolean;
  realRequest?: boolean;
  usage?: ContextUsageObservation;
  tools?: ToolBlock[];
  results?: (Pick<ToolBlock, 'id' | 'editPatch' | 'cellEdit'> & { result: string; isError: boolean })[];
  preservation?: Preservation;
  taskList?: ConversationTask[];
  peers?: PeerMessage[];
  backgroundAgents?: number;
  backgroundWorkflows?: number;
}

export interface TranscriptChange {
  /** Revisions, rewinds and repaired links replace the projected sequence. */
  replace: boolean;
  rewind: boolean;
  rows: TranscriptRow[];
  preserved: ReadonlySet<string>;
}

function object(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}
function string(value: unknown) { return typeof value === 'string' ? value : undefined; }
function count(value: unknown) { return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 0; }

/** Thinking a reply shows in its own place, folded like Claude Code's
 * "Thought for Ns" row. Narration (progress notes to the user) is reply text. */
function foldedThought(block: JsonRecord, record: JsonRecord, key: string, index: number, textOffset: number, bodies: boolean, first: boolean): ToolBlock | undefined {
  if (!isFoldedThought(block)) return;
  const duration = record.thinkingDurationMs;
  return { id: `${key}:thought:${index}`, name: 'Thinking', input: '', result: bodies ? string(block.thinking)!.trim() : '', textOffset,
    thought: first && typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? { durationMs: duration } : {} };
}

function blockText(block: JsonRecord, linked: boolean, assistant = false): string | undefined {
  if (block.type === 'text') return string(block.text);
  if (assistant && isNarration(block)) return string(block.thinking)?.trim() || undefined;
  if (block.type === 'tool_reference') return string(block.tool_name);
  if (linked && (block.type === 'image' || block.type === 'document' || block.type === 'file') &&
      transcriptAttachments('', [block]).length) return;
  if (block.type === 'image') return '[Image]';
  if (block.type === 'document' || block.type === 'file') return '[Document]';
}

function contentText(content: unknown, linked = false): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(value => blockText(object(value), linked)).filter(Boolean).join('\n\n');
}

function preservation(metadata: unknown): Preservation | undefined {
  const compact = object(metadata);
  if (!compact.preservedMessages && !compact.preservedSegment) return;
  const list = object(compact.preservedMessages);
  const segment = object(compact.preservedSegment);
  const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : undefined;
  return { anchor: string(list.anchorUuid ?? segment.anchorUuid), head: string(segment.headUuid), tail: string(segment.tailUuid),
    ids: strings(list.uuids), all: strings(list.allUuids) ?? [] };
}

// A command wrapper is ambiguous until a skill companion or model response follows.
// Local stdout, stderr and the expanded prompt remain topology-only rows.
function commandText(text: string): string | undefined {
  const wrapper = text.trim();
  if (!/^<(?:command-name|command-message)>/.test(wrapper)) return;
  const tags = [...wrapper.matchAll(/<(command-name|command-message|command-args)>([\s\S]*?)<\/\1>\s*/g)];
  if (tags.map(match => match[0]).join('') !== wrapper) return;
  const fields = new Map(tags.map(match => [match[1], match[2]]));
  const name = fields.get('command-name');
  if (fields.size !== tags.length || !fields.has('command-message') || !name || !/^\/[^\s<>]+$/.test(name)) return;
  const args = fields.get('command-args');
  return args ? `${name} ${args}` : name;
}

function normalize(record: JsonRecord, key: string, order: number, parent: string | null, bodies: boolean): TranscriptRow {
  const row: TranscriptRow = { key, order, parent, kind: 'hidden', timestamp: string(record.timestamp) };
  if (record.type === 'system') {
    if (record.subtype === 'compact_boundary') {
      row.kind = 'compact';
      row.parent = string(record.logicalParentUuid) ?? parent;
      row.preservation = preservation(record.compactMetadata);
      if (bodies) {
        const carry = object(object(record.compactMetadata).preCompactTaskList);
        row.taskList = readTaskList(carry.tasks) ?? (carry.tasks === undefined && Number.isSafeInteger(carry.highestId) ? [] : undefined);
      }
    } else if (record.subtype === 'turn_duration') {
      row.kind = 'duration';
      row.backgroundAgents = count(record.pendingBackgroundAgentCount);
      row.backgroundWorkflows = count(record.pendingWorkflowCount);
    }
    return row;
  }
  if (record.isCompactSummary) return row;
  // 原生记录的来源决定发件人。用户自己粘贴的同名标签仍然是普通聊天文字。
  const attachment = object(record.attachment);
  if (record.type === 'attachment' && (attachment.type === 'task_reminder' || attachment.type === 'todo_reminder')) {
    if (bodies) row.taskList = readTaskList(attachment.content);
    return row;
  }
  if (record.type === 'attachment' && attachment.type === 'teammate_mailbox') {
    row.kind = 'notification';
    if (bodies && Array.isArray(attachment.messages)) row.peers = attachment.messages.flatMap((entry, index) => {
      const item = object(entry);
      return typeof item.text === 'string' && item.text.trim() ? [{ id: `${key}:${index}`, source: 'agent' as const,
        sender: string(item.from), ...(item.provenance === 'forged' && { unverified: true }), text: item.text }] : [];
    });
    return row;
  }
  const queued = record.type === 'attachment' && attachment.type === 'queued_command';
  if (queued || record.type === 'user') {
    const origin = object(queued ? attachment.origin : record.origin);
    if (origin.kind === 'peer' || origin.kind === 'coordinator' || origin.kind === 'observer') {
      row.kind = 'notification';
      if (bodies) {
        const raw = contentText(queued ? attachment.prompt : object(record.message).content);
        const wrapper = /^<(agent-message|cross-session-message|teammate-message)\b[^>]*>\s*([\s\S]*?)\s*<\/\1>$/.exec(raw.trim());
        const text = string(origin.body)?.trim() || wrapper?.[2] || raw;
        const source = origin.handback === true ? 'handback' : origin.kind === 'coordinator' ? 'coordinator' :
          origin.senderTaskId || origin.kind === 'observer' || wrapper && wrapper[1] !== 'cross-session-message' ? 'agent' : 'session';
        if (text.trim()) row.peers = [{ id: string(origin.msg_id) || key, sender: string(origin.name) || string(origin.from), source, text }];
      }
      return row;
    }
  }
  if (record.isVisibleInTranscriptOnly) return row;
  if (record.type === 'attachment') {
    const queued = object(record.attachment);
    if (queued.type === 'queued_command' && queued.humanTurn === true && object(queued.origin).kind === 'human' && queued.commandMode === 'prompt') {
      const text = contentText(queued.prompt);
      if (text.trim()) {
        row.kind = 'user';
        row.text = bodies ? text : undefined;
        row.timestamp = string(queued.timestamp) ?? row.timestamp;
        return row;
      }
    }
  }
  if (record.isMeta) {
    if (record.type === 'user' && (record.turnCompanion === true || record.invokedSkill || record.mcpSkill)) row.kind = 'companion';
    return row;
  }
  const message = object(record.message);
  const content = message.content;
  const blocks = Array.isArray(content) ? content.map(object) : [];
  if (bodies) {
    const sourceBlocks = record.type === 'attachment' ? [object(record.attachment)] : blocks;
    const attachments = transcriptAttachments(key, sourceBlocks);
    if (attachments.length) {
      row.attachments = attachments;
      if (record.type === 'attachment') row.kind = 'attachment';
      if (attachments.some(item => item.ref.image)) {
        let textOffset = 0, toolsBefore = 0, next = 0;
        for (const [index, block] of sourceBlocks.entries()) {
          while (attachments[next]?.blockIndex === index) {
            const { ref } = attachments[next++];
            if (ref.image) { ref.textOffset = textOffset; ref.toolsBefore = toolsBefore; }
          }
          const text = blockText(block, true, record.type === 'assistant');
          if (text) textOffset += (textOffset ? 2 : 0) + text.length;
          if (block.type === 'tool_use' || record.type === 'assistant' && isFoldedThought(block)) toolsBefore++;
        }
      }
    }
  }
  if (record.type === 'assistant') {
    row.kind = 'assistant';
    row.responseId = string(message.id);
    row.realRequest = !record.isApiErrorMessage && record.isUnmetered !== true && message.model !== '<synthetic>';
    row.responseComplete = ['end_turn', 'stop_sequence', 'max_tokens'].includes(string(message.stop_reason) ?? '');
    row.usage = requestUsage(record);
    let text = string(content) ?? '';
    row.tools = [];
    let thoughts = 0;
    for (const [index, block] of blocks.entries()) {
      const thought = foldedThought(block, record, key, index, text.length, bodies, !thoughts);
      if (thought) {
        thoughts++;
        row.tools.push(thought);
      } else if (block.type === 'tool_use') {
        row.tools.push({ id: string(block.id) ?? `${key}:tool:${index}`, name: string(block.name) ?? 'Tool',
          input: bodies ? string(block.input) ?? JSON.stringify(block.input ?? {}, null, 2) : '', textOffset: text.length });
      } else if (bodies) {
        const paragraph = blockText(block, !!row.attachments, true);
        if (paragraph) text += (text ? '\n\n' : '') + paragraph;
      }
    }
    if (bodies) row.text = text;
  } else if (record.type === 'user') {
    const results = blocks.filter(block => block.type === 'tool_result');
    if (results.length) {
      row.kind = 'result';
      row.parent = string(record.sourceToolAssistantUUID) ?? parent;
      // A record-level structured patch is attributable only to a single successful tool result.
      const detail = object(bodies && results.length === 1 && results[0].is_error !== true ? record.toolUseResult : undefined);
      const patch = editPatch(detail.structuredPatch);
      const cell = typeof detail.notebook_path === 'string' && typeof detail.old_source === 'string' && typeof detail.new_source === 'string'
        ? { before: detail.old_source, after: detail.new_source } : undefined;
      row.results = results.flatMap(block => typeof block.tool_use_id === 'string'
        ? [{ id: block.tool_use_id, result: bodies ? contentText(block.content, !!row.attachments) : '', isError: block.is_error === true, ...(patch && { editPatch: patch }), ...(cell && { cellEdit: cell }) }] : []);
    } else {
      const text = contentText(content, !!row.attachments);
      const command = commandText(text);
      if (object(record.origin).kind === 'task-notification') {
        row.kind = 'notification';
        // The native producer is authoritative. Identical XML typed by a human
        // remains a regular user message.
        const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim();
        const result = /<result>([\s\S]*?)<\/result>/.exec(text)?.[1]?.trim();
        row.text = bodies ? [summary, result].filter(Boolean).join('\n\n') || text : undefined;
      } else if (/^\[Request interrupted by user(?: for tool use)?\]$/u.test(text.trim()) && !row.attachments?.length
          && record.origin === undefined && record.promptSource === undefined) {
        // Claude Code's own marker after Esc or a refused tool; its TUI shows
        // "Interrupted", not a prompt. A typed prompt carries its origin.
        row.kind = 'interruption';
      } else if (command) {
        row.kind = 'command';
        row.text = bodies ? command : undefined;
      } else if (/^\/compact(?:\s[\s\S]*)?$/.test(text.trim()) && !row.attachments?.length && record.origin === undefined && record.promptSource === undefined) {
        // Claude Code 2.1.316 writes the bare command when /compact starts (a typed
        // prompt carries its origin) and the wrapped echo after the boundary.
        row.kind = 'command';
        row.text = bodies ? text.trim() : undefined;
      } else if ((text.trim() || row.attachments?.length) && !/^\s*(?:<local-command-(?:caveat|stdout|stderr)>|<command-(?:name|message)>|<system-reminder>|Caveat: The messages below)/.test(text)) {
        row.kind = 'user';
        row.text = bodies ? text : undefined;
      }
    }
  }
  return row;
}

/** Candidate human turn boundaries for the file reader. A slash command can
 * still be hidden by the projection if it has no model continuation. */
export function isTranscriptTurnStart(record: JsonRecord, sessionId?: string): boolean {
  if (record.type !== 'user' && record.type !== 'attachment' || record.isSidechain ||
      sessionId !== undefined && typeof record.sessionId === 'string' && sessionId !== record.sessionId) return false;
  // Most rows in a tool-heavy session are results. Avoid normalizing their
  // (potentially multi-megabyte) bodies just to count human turns.
  const content = object(record.message).content;
  if (Array.isArray(content) && content.some(block => object(block).type === 'tool_result')) return false;
  const { kind } = normalize(record, '', 0, null, true);
  return kind === 'user' || kind === 'command';
}

/**
 * Index the native parent chain before filtering hidden rows. Older JSONL without
 * parentUuid uses the previous leaf. The usual append returns only the new rows.
 * A branch change replays one projection per chunk, never once per input row.
 */
export class TranscriptStore {
  private nodes = new Map<string, TranscriptRow>();
  private responseIds = new Set<string>();
  private boundaries: TranscriptRow[] = [];
  private boundary?: TranscriptRow;
  private compactionKeys = new Set<string>();
  incomplete = false;
  private checkpointOrders = new Map<string, number>();
  private followingCheckpoint?: number;
  private cut?: string;
  private leaf: string | null = null;
  private preserved = new Set<string>();
  private missingParents = new Set<string>();
  private anchor?: string;
  // A compaction drops context from the model but leaves its source conversation
  // on disk. Keep only the pre-boundary selected branch, never every older fork.
  private archives = new Map<string, { previous?: string; keys: string[] }>();
  partialStart = false;
  constructor(private readonly sessionId?: string, private readonly bodies = true, public showCompacted = false) {}

  get leafUuid() { return this.leaf; }

  archivedBefore(rows: TranscriptRow[]): TranscriptRow[] {
    if (!this.archives.size) return [];
    let boundary = rows.slice().reverse().find(row => row.kind === 'compact')?.key;
    const segments: string[][] = [];
    const visited = new Set<string>();
    while (boundary && !visited.has(boundary)) {
      visited.add(boundary);
      const segment = this.archives.get(boundary);
      if (!segment) break;
      segments.push(segment.keys);
      boundary = segment.previous;
    }
    const seen = new Set<string>();
    const result: TranscriptRow[] = [];
    for (const keys of segments.reverse()) for (const key of keys) {
      const row = this.nodes.get(key);
      if (row && !seen.has(key)) { seen.add(key); result.push(row); }
    }
    return result;
  }

  /** 交接原稿可保留多条分歧路径。按落盘顺序返回已加载但不属于所选路径的记录。 */
  otherHistoryRows(): TranscriptRow[] {
    const active = this.branch();
    const shown = new Set([...active, ...this.archivedBefore(active)].map(row => row.key));
    return [...this.nodes.values()].filter(row => !shown.has(row.key));
  }

  /** A native restore can redraw immediately and persist its new branch on the next send. */
  rewindBefore(key: string): TranscriptChange | undefined {
    const row = this.nodes.get(key);
    if (!row || !this.branch().some(item => item.key === key)) return;
    this.leaf = row.parent;
    this.cut = key;
    this.rememberCompaction(this.latestBoundary(this.leaf ? this.nodes.get(this.leaf) : undefined));
    return { replace: true, rewind: true, rows: this.branch(), preserved: this.preserved };
  }

  append(records: JsonRecord[], replace = false): TranscriptChange {
    let rewind = false;
    const added: TranscriptRow[] = [];
    for (const record of records) {
      if (record.isSidechain || (this.sessionId !== undefined && typeof record.sessionId === 'string' && record.sessionId !== this.sessionId)) continue;
      if (record.type === 'last-prompt') {
        const target = record.leafUuid;
        const signature = JSON.stringify([target, record.explicit, record.rewound, record.cutUuid, record.timestamp]);
        const knownCheckpoint = this.checkpointOrders.get(signature);
        this.followingCheckpoint = knownCheckpoint;
        this.checkpointOrders.set(signature, knownCheckpoint ?? this.nodes.size);
        // An implicit checkpoint can lag a newly persisted descendant.
        // In a tail-first view an explicit restore can point beyond the loaded
        // page. Hide the abandoned tip until the target is supplied by a page.
        const unseenRestore = this.showCompacted && record.rewound === true && record.explicit === true &&
          typeof target === 'string' && !this.nodes.has(target);
        const usable = unseenRestore || target === null && record.explicit === true
          || typeof target === 'string' && this.nodes.has(target)
            && (record.explicit === true || !this.isAncestor(target, this.leaf));
        if (usable && record.explicit === true) this.cut = record.rewound === true ? string(record.cutUuid) : undefined;
        if (usable && this.leaf !== target) {
          this.leaf = target as string | null;
          replace = true;
          rewind ||= record.explicit === true;
          this.rememberCompaction(this.latestBoundary(this.leaf ? this.nodes.get(this.leaf) : undefined));
        }
        continue;
      }
      if (!['user', 'assistant', 'system', 'attachment', 'progress'].includes(string(record.type) ?? '')) continue;
      if ((record.type === 'progress' || record.type === 'attachment') && typeof record.uuid !== 'string') continue;
      // Legacy timing rows often have no UUID, timestamp or parent and can
      // repeat identical timing values in two different foreground turns.
      let fallback: string | undefined;
      if (typeof record.uuid !== 'string') {
        const leaf = this.leaf && this.nodes.get(this.leaf);
        const origin = record.subtype === 'turn_duration' && !('parentUuid' in record)
          ? leaf && (leaf.kind === 'duration' ? leaf.parent : leaf.key) : null;
        fallback = createHash('sha256').update(JSON.stringify([record, origin])).digest('hex');
      }
      const key = string(record.uuid) ?? fallback!;
      const old = this.nodes.get(key);
      const parent = record.parentUuid === null ? null : string(record.parentUuid) ?? (old ? old.parent : this.leaf);
      const row = normalize(record, key, old?.order ?? this.nodes.size, parent, this.bodies);
      if (old && isDeepStrictEqual(old, row)) {
        // Re-reading a log containing an old checkpoint followed by its own
        // continuation must converge to the same tip, including across chunks.
        if (this.followingCheckpoint !== undefined && old.order >= this.followingCheckpoint && row.parent === this.leaf) {
          this.leaf = key;
          if (row.kind === 'compact') this.rememberCompaction(row);
          replace = true;
        }
        continue;
      }
      this.followingCheckpoint = undefined;
      const sibling = row.responseId !== undefined && this.responseIds.has(row.responseId);
      if (row.responseId) this.responseIds.add(row.responseId);
      if (this.showCompacted && row.kind === 'compact' && !old) {
        const tip = row.parent ?? this.leaf;
        const prior = this.branch(tip, this.latestBoundary(tip ? this.nodes.get(tip) : undefined));
        const previous = prior.slice().reverse().find(item => item.kind === 'compact');
        this.archives.set(key, { previous: previous?.key,
          keys: prior.filter(item => !previous || item.order >= previous.order || this.preserved.has(item.key)).map(item => item.key) });
      }
      this.nodes.set(key, row);
      if (row.parent && !this.nodes.has(row.parent)) this.missingParents.add(row.parent);
      const fillsGap = this.missingParents.delete(key);
      if (row.kind === 'compact' || old?.kind === 'compact') {
        this.boundaries = [...this.boundaries.filter(item => item.key !== key), ...(row.kind === 'compact' ? [row] : [])]
          .sort((a, b) => a.order - b.order);
        replace = true;
      }
      const direct = row.parent === this.leaf;
      // A detached duration/result or additional block of an earlier response
      // cannot choose a new foreground turn. The projection attaches it by ID.
      const retained = this.compactionKeys.has(key) && key !== this.boundary?.preservation?.anchor;
      const foreground = row.kind === 'user' || row.kind === 'command' || row.kind === 'assistant' || row.kind === 'compact';
      const repairsLeaf = fillsGap && this.isAncestor(key, this.leaf);
      const partialTurn = this.partialStart && (row.kind === 'result' || row.kind === 'notification') &&
        this.leaf === null && !this.cut && !this.checkpointOrders.size;
      if (!old && !repairsLeaf && !retained && (direct || partialTurn || foreground && !sibling && !this.isDiscarded(key))) {
        this.leaf = key;
        if (row.kind === 'compact') this.rememberCompaction(row);
        else if (!direct && row.parent === null) this.rememberCompaction(undefined);
      }
      if (old && this.boundary?.key === key) this.rememberCompaction(row.kind === 'compact' ? row : undefined);
      if (old || fillsGap || !direct || this.compactionKeys.has(key) || this.preserved.has(key) || this.anchor && row.parent === this.anchor) replace = true;
      added.push(row);
    }
    return { replace, rewind, rows: replace ? this.branch() : added, preserved: this.preserved };
  }

  private rememberCompaction(boundary?: TranscriptRow): void {
    this.boundary = boundary;
    const data = boundary?.preservation;
    this.compactionKeys = new Set([...data?.all ?? [], ...data?.ids ?? []]);
    for (const key of [data?.head, data?.tail, data?.anchor]) if (key) this.compactionKeys.add(key);
  }

  private latestBoundary(leaf?: TranscriptRow): TranscriptRow | undefined {
    if (!leaf) return;
    for (let i = this.boundaries.length - 1; i >= 0; i--) {
      if (this.boundaries[i].order <= leaf.order) return this.boundaries[i];
    }
  }

  private isDiscarded(key: string): boolean {
    return !!this.cut && this.isAncestor(this.cut, key);
  }

  private isAncestor(target: string, leaf: string | null): boolean {
    for (const row of this.walk(leaf)) if (row.key === target) return true;
    return false;
  }

  private *walk(leaf: string | null, parent = (row: TranscriptRow) => row.parent): Generator<TranscriptRow> {
    const seen = new Set<string>();
    let row = leaf ? this.nodes.get(leaf) : undefined;
    while (row && !seen.has(row.key)) {
      seen.add(row.key);
      yield row;
      const next = parent(row);
      row = next ? this.nodes.get(next) : undefined;
    }
  }

  private branch(tip = this.leaf, boundary = this.boundary): TranscriptRow[] {
    const leaf = tip && this.nodes.get(tip);
    this.preserved = new Set();
    this.anchor = undefined;
    this.incomplete = false;
    if (!leaf) return [];
    const data = boundary?.preservation;
    let ids = data?.ids;
    if (!ids && data?.tail && data.head) {
      const backwards: string[] = [];
      for (const row of this.walk(data.tail)) {
        backwards.push(row.key);
        if (row.key === data.head) { ids = backwards.reverse(); break; }
      }
    }
    this.preserved = new Set([...(data?.all ?? []), ...(ids ?? [])]);
    const parents = new Map<string, string>();
    // A valid empty preservation list explicitly drops all earlier rows.
    const anchor = data?.anchor;
    const validList = ids !== undefined && new Set(ids).size === ids.length && ids.every(id => id !== anchor && this.nodes.has(id));
    const prune = !!boundary && validList && (!ids!.length || !!anchor && this.nodes.has(anchor));
    this.incomplete = !!(data?.head || data?.ids?.length) && !prune;
    const tail = prune ? ids!.at(-1) : undefined;
    if (anchor && tail) {
      this.anchor = anchor;
      let parent = anchor;
      for (const id of ids!) { parents.set(id, parent); parent = id; }
    }
    const allowed = (row: TranscriptRow) => !prune || row.order >= boundary!.order || parents.has(row.key);
    const parent = (row: TranscriptRow): string | null => {
      if (!prune) return row.parent;
      const retainedParent = parents.get(row.key);
      if (retainedParent) return retainedParent;
      if (row === boundary) return null;
      const original = row.parent && this.nodes.get(row.parent);
      if (tail && row.parent === anchor) return tail;
      if (original && !allowed(original)) return tail ?? boundary!.key;
      return row.parent;
    };
    const path = [...this.walk(tail && leaf.key === anchor ? tail : leaf.key, parent)].filter(allowed).reverse();
    // If the oldest reachable row still names a parent, the chain was broken
    // or cyclic. Its verified suffix can still be projected without guessing.
    this.incomplete ||= !!path[0] && parent(path[0]) !== null;
    return this.withSiblings(path, allowed);
  }

  /** Recover response blocks, parallel tool results and timing rows which branched off the selected chain. */
  private withSiblings(path: TranscriptRow[], allowed: (row: TranscriptRow) => boolean): TranscriptRow[] {
    const active = new Set(path.map(row => row.key));
    const responses = new Map<string, TranscriptRow[]>();
    for (const row of path) {
      if (!row.responseId) continue;
      const group = responses.get(row.responseId) ?? [];
      group.push(row);
      responses.set(row.responseId, group);
    }
    const before = new Map<string, TranscriptRow[]>();
    const after = new Map<string, TranscriptRow[]>();
    const attach = (map: Map<string, TranscriptRow[]>, key: string, row: TranscriptRow) => {
      const list = map.get(key) ?? [];
      list.push(row);
      map.set(key, list);
    };
    const tools = new Map<string, string>();
    const missingToolOwners = new Map<string, string>();
    for (const row of this.nodes.values()) {
      if (!allowed(row)) continue;
      if (!active.has(row.key) && row.responseId) {
        const group = responses.get(row.responseId);
        if (group && !this.isDiscarded(row.key)) {
          const later = group.find(block => block.order > row.order);
          attach(later ? before : after, (later ?? group.at(-1)!).key, row);
          active.add(row.key);
        }
      }
      if (active.has(row.key)) for (const tool of row.tools ?? []) tools.set(tool.id, row.key);
      if (this.partialStart && active.has(row.key) && row.kind === 'result' && row.parent && !this.nodes.has(row.parent)) {
        missingToolOwners.set(row.parent, row.key);
      }
    }
    for (const row of this.nodes.values()) {
      if (active.has(row.key) || !allowed(row)) continue;
      if ((row.kind !== 'duration' && row.kind !== 'result' && row.kind !== 'notification') || row.key === this.cut) continue;
      const owner = row.parent && this.nodes.has(row.parent) ? active.has(row.parent) && row.parent
        : row.results?.map(result => tools.get(result.id)).find(Boolean) ?? (row.parent && missingToolOwners.get(row.parent));
      if (owner) { attach(after, owner, row); active.add(row.key); }
    }
    // Avoid recursion even with very long chains of detached timing records.
    const pending = path.slice().reverse();
    const emitted = new Set<string>();
    const result: TranscriptRow[] = [];
    while (pending.length) {
      const row = pending.pop()!;
      const leading = before.get(row.key);
      if (leading) {
        before.delete(row.key);
        pending.push(row);
        for (let i = leading.length - 1; i >= 0; i--) pending.push(leading[i]);
        continue;
      }
      if (emitted.has(row.key)) continue;
      emitted.add(row.key);
      result.push(row);
      const following = after.get(row.key);
      if (following) for (let i = following.length - 1; i >= 0; i--) pending.push(following[i]);
    }
    return result;
  }
}
