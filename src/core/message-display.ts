import { SessionActivityStore } from './session-activity';
import { GoalTracker } from './goal-status';
import { goalStatusOf } from './goal-records';
import { adoptSidechain } from './subagent-records';
import { ConversationTasks } from './conversation-tasks';
import type { RewindMenu } from '../shared/turn-controls';
import type { ChatMessage, GoalObservation, MessageAttachment, SessionStatus, ToolBlock } from '../shared/types';
import type { TranscriptAttachment } from './transcript-attachments';
import { JsonlDecoder, type JsonRecord } from './jsonl';
import { isTranscriptTurnStart, recordRow, TranscriptStore, type TranscriptChange, type TranscriptRow } from './transcript-store';
import { TranscriptUsage } from './session-telemetry';
import { alignPreview, extractPreview, matchText } from './screen';
import { diagnostic, getDiagnosticsInfo, summarize } from '../diagnostics';
import { joinList, t } from '../shared/i18n';
import { samePrompt } from '../shared/native-prompt';

interface Part { text: string; tools: ToolBlock[]; cwd?: string }
interface Turn {
  index: number;
  user?: ChatMessage;
  userUuid?: string;
  archivedUser?: boolean;
  attachments?: MessageAttachment[];
  taskNotifications?: ChatMessage['taskNotifications'];
  peerMessages?: ChatMessage['peerMessages'];
  optimistic: boolean;
  parts: Map<string, Part>;
  results: Map<string, Pick<ToolBlock, 'result' | 'isError' | 'editPatch' | 'cellEdit' | 'resultCwd'>>;
  preview: string;
  finished: boolean;
  responseId?: string;
  responseComplete?: boolean;
  durationComplete?: boolean;
  durationAt?: string;
  backgroundAgents?: number;
  backgroundWorkflows?: number;
  interrupted: boolean;
  /** Claude Code recorded that the user interrupted this turn (Esc, or a refused tool). */
  stopped?: boolean;
  timestamp?: string;
}

function digestMessage(message: ChatMessage) {
  return { id: message.id, role: message.role, source: message.source, status: message.status,
    text: summarize(message.text), tools: summarize(JSON.stringify(message.tools)) };
}

/**
 * One stable assistant bubble per human turn. JSONL is the authoritative store;
 * screen captures are provisional and are never written back to its transcript.
 */
export class MessageDisplay {
  private transcript: TranscriptStore;
  activity: SessionActivityStore;
  /** Claude Code's native /goal from the records read (goal-status.ts), rebuilt with the activity. */
  goals: GoalTracker;
  /** An active goal in the last goal record before the first page (seedGoal), going on with the records read. */
  private probe?: { record: JsonRecord; tracker: GoalTracker };
  tasks = new ConversationTasks();
  private attachments = new Map<string, TranscriptAttachment>();
  private usage = new TranscriptUsage();
  private command?: TranscriptRow;
  /** A goal's set record, written before its `/goal <condition>` command: it belongs to that
   * command's turn (`command` is the command row's key once it came). A compaction restates an
   * active goal with the same record and no command: `compacted` drops it. */
  private goalSet?: { row: TranscriptRow; command?: string; restated: boolean };
  private compacted = false;
  // After compaction Claude Code re-attaches recently read files (`file`
  // attachment records) before the next prompt. They are model context, not
  // files the user attached to the prompt before the compaction.
  private restoring = false;
  private decoder = new JsonlDecoder();
  // Until we reach byte zero, keep decoded records for chronological replay on
  // an explicit page request. Live polls still append only their new records.
  private pages?: JsonRecord[][];
  // Only needed after the first page from another native UUID. A predecessor
  // can supply archived prompts, never entries in the current CLI rewind menu.
  private tipUsers?: Set<string>;
  private rememberTipUsers(rows: JsonRecord[]) {
    if (!this.tipUsers) return;
    for (const r of rows) if (r.type === 'user' && typeof r.uuid === 'string' && (!r.sessionId || r.sessionId === this.sessionId)) this.tipUsers.add(r.uuid);
  }
  private rewindable(turn: Turn) {
    return !!turn.userUuid && !turn.archivedUser && (!this.tipUsers || this.tipUsers.has(turn.userUuid));
  }
  private olderInvalid = 0;
  private turns: Turn[] = [];
  private settledMessages = new WeakMap<Turn, ChatMessage[]>();
  private messageDigests = new WeakMap<ChatMessage, ReturnType<typeof digestMessage>>();
  private current?: Turn;
  private pendingCount = 0;
  private seenPeerMessages = new Set<string>();
  private queuedInputs: string[] = [];
  private terminalStatus?: SessionStatus;
  private nextTurnIndex = 0;
  private usedTurnIndices = new Set<number>();
  private lastMessageSummaryHash?: string;

  /** Message IDs: the session's, or one subagent's within it. */
  private readonly idBase: string;

  /** With `agentId`, the display shows that subagent's own transcript (see subagent-records.ts). */
  constructor(private readonly sessionId: string, private readonly agentId?: string) {
    this.idBase = agentId ? `${sessionId}:agent:${agentId}` : sessionId;
    this.transcript = new TranscriptStore(sessionId);
    this.activity = new SessionActivityStore(sessionId);
    this.goals = new GoalTracker();
    diagnostic.event('display.created', { sessionId });
  }

  private adopt(records: JsonRecord[]): JsonRecord[] {
    const agent = this.agentId;
    return agent ? records.flatMap((record): JsonRecord[] => { const row = adoptSidechain(record, agent); return row ? [row] : []; }) : records;
  }

  getAttachment(id: string) {
    const attachment = this.attachments.get(id);
    if (!attachment || attachment.ref.path) throw new Error(t('core.attachmentMissing'));
    return attachment;
  }

  /** 此入口仅供只读源段查看器使用；正常会话始终遵循原生分支选择。 */
  otherHistoryRows() { return this.transcript.otherHistoryRows(); }

  get contextUsage() { return this.usage.context; }
  /** The Claude Code version that wrote this session's latest record. */
  get cliVersion() { return this.version; }
  private version?: string;
  /** The newest model reply of this conversation in the records read (ms, its `timestamp`):
   * any branch, not synthetic or API error records (main/quota-as-of.ts). */
  get lastReplyAt() { return this.lastReply; }
  private lastReply?: number;
  /** Claude Code's working directory as of the newest record read (it changes after a `cd`). */
  get workingDirectory() { return this.cwd; }
  private cwd?: string;

  private get foreground() { return this.pendingCount ? this.turns.at(-1) : this.current; }

  get diagnosticState() { return this.describeTurns(this.turns); }

  private describeTurns(turns: Turn[]) {
    return { sessionId: this.sessionId, turnCount: this.turns.length, currentTurn: this.current?.index,
      status: this.status, terminalStatus: this.terminalStatus, decoder: this.decoder.stats,
      turns: turns.map(turn => ({ index: turn.index, userUuid: turn.userUuid, optimistic: turn.optimistic,
        finished: turn.finished, responseComplete: turn.responseComplete, durationComplete: turn.durationComplete,
        backgroundAgents: turn.backgroundAgents, backgroundWorkflows: turn.backgroundWorkflows, interrupted: turn.interrupted, partCount: turn.parts.size,
        canonical: summarize(this.canonicalText(turn)), preview: summarize(turn.preview) })) };
  }

  get status(): SessionStatus {
    if (this.terminalStatus === 'error') return 'error';
    if (this.terminalStatus === 'waiting') return 'waiting';
    const turn = this.foreground;
    if (!turn) return this.terminalStatus ?? 'idle';
    if (turn.interrupted) return 'idle';
    // Claude Code recorded that the user stopped it (Esc, a refused call): over, even with a live
    // preview left that the transcript never matched (a reply stopped at a dialog before its call was written).
    if (turn.finished || turn.stopped) return this.terminalStatus === 'working' ? 'working' : 'idle';
    if (turn.optimistic || turn.preview || this.terminalStatus === 'working') return 'working';
    return this.terminalStatus ?? 'idle';
  }

  /** Records were skipped, or parents are missing or cyclic: the branch shown may be incomplete. */
  get historyIncomplete(): boolean {
    return this.olderInvalid + this.decoder.invalidLines + this.decoder.oversizedLines > 0 || (!this.pages && this.transcript.incomplete);
  }

  get notice(): string | undefined {
    const invalid = this.olderInvalid + this.decoder.invalidLines + this.decoder.oversizedLines;
    const skipped = invalid ? t('core.skippedRecords', { count: invalid }) : undefined;
    return [skipped, this.projectionNotice].filter(Boolean).join(' ') || undefined;
  }

  noteSkippedHistoryRecords(count: number) {
    if (Number.isSafeInteger(count) && count > 0) this.olderInvalid += count;
  }

  private get projectionNotice(): string | undefined {
    if (!this.pages && this.transcript.incomplete) return t('core.incompleteHistory');
    const turn = this.foreground;
    if (turn?.interrupted && turn.preview) return t('core.interruptedPreview');
    const background = this.pendingBackground;
    if (background) {
      const pending = [background.agents && t('core.backgroundAgents', { count: background.agents }), background.workflows && t('core.workflows', { count: background.workflows })]
        .filter((part): part is string => !!part);
      return t('core.turnEndedRunning', { what: joinList(pending), count: (background.agents || 0) + (background.workflows || 0) });
    }
  }

  /** Background agents and workflows the latest finished turn left running, from
   * its turn_duration record (agents that have since ended are not counted). */
  get pendingBackground(): { agents: number; workflows: number; at?: string } | undefined {
    const turn = this.foreground;
    if (!turn?.durationComplete || !(turn.backgroundAgents || turn.backgroundWorkflows)) return;
    const agents = Math.max(0, (turn.backgroundAgents ?? 0) - this.activity.endedAgentsSince(turn.durationAt));
    const workflows = turn.backgroundWorkflows ?? 0;
    return agents || workflows ? { agents, workflows, at: turn.durationAt } : undefined;
  }

  reset(): void {
    diagnostic.event('display.reset', { sessionId: this.sessionId, turns: this.turns.length });
    this.queuedInputs = [];
    this.transcript = new TranscriptStore(this.sessionId);
    this.activity = new SessionActivityStore(this.sessionId);
    this.goals = new GoalTracker();
    this.probe = undefined;
    this.attachments.clear();
    this.tasks = new ConversationTasks();
    this.seenPeerMessages.clear();
    this.usage.reset();
    this.decoder.reset();
    this.lastReply = undefined;
    this.cwd = undefined;
    this.command = undefined;
    this.goalSet = undefined;
    this.compacted = false;
    this.restoring = false;
    this.turns = [];
    this.settledMessages = new WeakMap();
    this.current = undefined;
    this.pendingCount = 0;
    this.terminalStatus = undefined;
    this.pages = undefined;
    this.tipUsers = undefined;
    this.olderInvalid = 0;
    this.nextTurnIndex = 0;
    this.usedTurnIndices.clear();
    this.lastMessageSummaryHash = undefined;
  }

  ingestJsonl(chunk: Buffer | string, reset = false, hasOlder?: boolean): void {
    // A truncate/replace rebuilds from the source, including removal of old turns.
    if (reset) {
      // The first poll can observe no file at all; the first user record then
      // creates a new inode. Preserve pending UI identity across that reset.
      // Pending turns stay after canonical replay, including multi-chunk reads.
      const pending = this.turns.filter(turn => turn.optimistic);
      this.reset();
      this.turns = pending;
      this.pendingCount = pending.length;
      this.usedTurnIndices = new Set(pending.map(turn => turn.index));
      diagnostic.event('display.reset.pending_preserved', { pendingTurns: pending.map(turn => turn.index) });
    }
    if (hasOlder !== undefined) {
      this.transcript.showCompacted = true;
      this.transcript.partialStart = hasOlder;
      if (hasOlder) this.pages ??= [];
      else this.pages = undefined;
    }
    if (!chunk.length) return;
    const records = this.adopt(this.decoder.push(chunk));
    for (const record of records) {
      if (!record.isSidechain && (!record.sessionId || record.sessionId === this.sessionId) && typeof record.cwd === 'string' && record.cwd.startsWith('/')) this.cwd = record.cwd;
    }
    this.rememberTipUsers(records);
    if (records.length) this.pages?.push(records);
    this.ingestActivity(records);
    this.applyChange(this.transcript.append(records));
    if (getDiagnosticsInfo().enabled) diagnostic.event('display.jsonl.applied', { incoming: summarize(chunk), reset,
      invalid: this.decoder.invalidLines + this.decoder.oversizedLines, state: this.describeTurns(this.turns.slice(-3)) });
  }

  /** Pages start and end at record boundaries. The forward decoder may already
   * hold part of a newly appended UTF-8 line and belongs exclusively to live IO. */
  prependJsonl(chunk: Buffer | string, hasOlder: boolean, deferUntilPrompt = false, requireNewTurn?: boolean, sourceSessionId?: string): boolean | undefined {
    if (!this.pages) return;
    const older = this.recordOlderPage(chunk, sourceSessionId);
    // 一轮可能有数十页工具输出。先保留各页，遇到候选提问或文件开头再一起重建分支。
    if (hasOlder && deferUntilPrompt && !older.some(row => isTranscriptTurnStart(row, this.sessionId))) return;
    return this.rebuildHistory(hasOlder, requireNewTurn);
  }

  /** Rewind needs the entire history before it can select a native ordinal.
   * Pages are newest first, with the last one reaching the start of the history. */
  prependCompleteHistory(pages: readonly { jsonl: Buffer; sourceSessionId?: string; skippedHistoryRecords?: number }[]) {
    if (!this.pages) return;
    for (const page of pages) {
      this.recordOlderPage(page.jsonl, page.sourceSessionId);
      if (page.skippedHistoryRecords) this.noteSkippedHistoryRecords(page.skippedHistoryRecords);
    }
    this.rebuildHistory(false);
  }

  private recordOlderPage(chunk: Buffer | string, sourceSessionId?: string) {
    const pages = this.pages!;
    const decoder = new JsonlDecoder();
    const recordsOnDisk = this.adopt(decoder.push(chunk));
    if (sourceSessionId && !this.tipUsers) {
      this.tipUsers = new Set();
      for (const page of pages) this.rememberTipUsers(page);
    }
    if (!sourceSessionId) this.rememberTipUsers(recordsOnDisk);
    // Only the verified predecessor owns this page. Re-home the top-level
    // session field at the projection boundary, never text, tool IDs or UUIDs.
    const older = sourceSessionId ? recordsOnDisk.filter(r => r.sessionId === sourceSessionId).map(r => ({ ...r, sessionId: this.sessionId })) : recordsOnDisk;
    this.olderInvalid += decoder.invalidLines + decoder.oversizedLines;
    if (older.length) pages.unshift(older);
    return older;
  }

  private rebuildHistory(hasOlder: boolean, requireNewTurn?: boolean) {
    const records = this.pages!.flat();
    const transcript = new TranscriptStore(this.sessionId, true, true);
    transcript.partialStart = hasOlder;
    const change = transcript.append(records, true);
    if (hasOlder && requireNewTurn !== undefined) {
      // A raw candidate can belong to a discarded fork, or follow the orphan
      // at the start of this page. Test the actual projection before changing
      // live state: a poll during the next read must not publish a half-turn.
      const probe = new MessageDisplay(this.sessionId, this.agentId);
      probe.transcript = transcript;
      const archive = transcript.archivedBefore(change.rows);
      const rows = archive.length ? probe.applyArchive(archive, change.rows) : change.rows;
      for (const row of rows) {
        probe.applyRow(row);
        if (!archive.length && probe.turns.length > 1) break;
      }
      const first = probe.answeredHistoryHead;
      if (!first || requireNewTurn && this.turns.some(turn => turn.userUuid === first)) return false;
    }
    const previousActivity = this.activity;
    this.activity = new SessionActivityStore(this.sessionId);
    this.queuedInputs = [];
    this.ingestActivity(records);
    this.activity.retainSamples(previousActivity);
    this.transcript = transcript;
    this.applyChange(change, true);
    if (!hasOlder) this.pages = undefined;
    return true;
  }

  private seeded(record: JsonRecord) {
    const tracker = new GoalTracker();
    tracker.ingest([recordRow(record)]);
    return { record, tracker };
  }
  /** The rows applied since the last rebuild, in the order applyChange applied them: the archive, then the branch. */
  private projectedRows(): TranscriptRow[] {
    const active = this.transcript.activeRows(), archive = this.transcript.archivedBefore(active);
    const shown = new Set(archive.map(row => row.key));
    return [...archive, ...active.filter(row => !shown.has(row.key))];
  }
  /**
   * The last goal record before the first page read (Backend.readGoalBefore). An active goal there is
   * the session's goal as long as no goal record was read: the records read after it (Claude Code's
   * pause and retry notices, check-ins) go on from it, as they would in a complete read.
   */
  seedGoal(record: JsonRecord | undefined) {
    const status = record && goalStatusOf(record);
    if (!record || !status || status.met || status.failed || record.sessionId !== this.sessionId) { this.probe = undefined; return; }
    this.probe = this.seeded(record);
    this.probe.tracker.ingest(this.projectedRows());
  }
  /** The session's goal: from the records read, else from the record before them (seedGoal). */
  get goal(): { current?: Omit<GoalObservation, 'source'>; source: 'transcript' | 'probe' } | undefined {
    if (this.goals.seen) return { current: this.goals.current, source: 'transcript' };
    if (this.probe) return { current: this.probe.tracker.current, source: 'probe' };
  }

  // A pending bubble or thinking-only record isn't a recovered reply. An
  // image, tool call, or native task/peer activity can be the whole reply.
  get answeredHistoryHead(): string | undefined {
    const turn = this.turns[0];
    if (!turn?.userUuid || turn.optimistic) return;
    if (turn.attachments?.length || turn.taskNotifications?.length || turn.peerMessages?.length) return turn.userUuid;
    for (const part of turn.parts.values()) if (part.text || part.tools.length) return turn.userUuid;
  }

  private ingestActivity(records: JsonRecord[]) {
    this.activity.ingest(records);
    for (const record of records) {
      if (!record.isSidechain && record.sessionId === this.sessionId && typeof record.version === 'string' && /^\d+\.\d+\.\d+[\w.+-]{0,24}$/.test(record.version)) this.version = record.version;
      if (record.type === 'assistant' && !record.isSidechain && record.sessionId === this.sessionId && !record.isApiErrorMessage && record.isUnmetered !== true
        && (record.message as JsonRecord | undefined)?.model !== '<synthetic>' && typeof record.timestamp === 'string') {
        const at = Date.parse(record.timestamp);
        if (Number.isFinite(at) && at > (this.lastReply ?? 0)) this.lastReply = at;
      }
      if (record.type !== 'queue-operation' || record.isSidechain || record.sessionId !== this.sessionId) continue;
      if (record.operation === 'enqueue' && typeof record.content === 'string') {
        this.queuedInputs.push(record.content);
        if (this.queuedInputs.length > 256) this.queuedInputs.shift();
      } else if (record.operation === 'dequeue') this.queuedInputs.shift();
      else if (record.operation === 'remove' && typeof record.content === 'string') {
        const index = this.queuedInputs.indexOf(record.content);
        if (index >= 0) this.queuedInputs.splice(index,1);
      }
    }
  }

  private applyChange(change: TranscriptChange, prepend = false): void {
    this.usage.apply(change);
    this.tasks.apply(change);
    const rewind = change.rewind && !prepend;
    const previous = change.replace && !rewind ? this.current : undefined;
    const previousTurns = this.transcript.showCompacted && change.replace ? this.turns : undefined;
    // Identical text in a replayed *existing* turn cannot acknowledge a pending send.
    const existingUsers = change.replace && this.pendingCount ? new Set(this.turns.map(turn => turn.userUuid)) : undefined;
    if (change.replace) {
      this.attachments.clear();
      this.seenPeerMessages.clear();
      // Preserve unsaved input on a topology repair. A native rewind explicitly
      // abandons the old tip, including any preview still attached to it.
      this.turns = rewind ? [] : this.turns.filter(turn => turn.optimistic);
      this.current = undefined;
      this.command = undefined;
      this.goalSet = undefined;
      // The goal is rebuilt from the same rows as its events (goal-status.ts), seeded by the probe's record.
      this.goals = new GoalTracker();
      if (this.probe) this.probe = this.seeded(this.probe.record);
      this.compacted = false;
      this.restoring = false;
      this.pendingCount = this.turns.length;
      this.nextTurnIndex = 0;
      this.usedTurnIndices = new Set(this.turns.map(turn => turn.index));
      if (rewind) this.terminalStatus = undefined;
    }
    const archive = change.replace ? this.transcript.archivedBefore(change.rows) : [];
    const rows = archive.length ? this.applyArchive(archive, change.rows) : change.rows;
    // Older pages cannot acknowledge a pending send, except the newest prompt of the
    // whole transcript: a new chat whose opening records (system prompt snapshot,
    // tool lists, …) outgrow the first page reaches its only prompt by paging back.
    const newestUser = prepend && this.pendingCount ? [...rows].reverse().find(row => row.kind === 'user')?.key : undefined;
    for (const row of rows) this.applyRow(row, existingUsers, !prepend || (!!newestUser && row.key === newestUser));
    if (previousTurns?.length) this.restoreIndices(previousTurns);
    // A late timing record for an older turn must not erase the live suffix of
    // the current turn. Never transplant a preview to a different user/branch.
    if (previous && this.current && (previous.userUuid ? previous.userUuid === this.current.userUuid : previous.parts.size > 0) && !this.current.durationComplete &&
        [...previous.parts.keys()].every(key => this.current!.parts.has(key))) {
      const canonical = matchText(this.canonicalText(this.current));
      const preview = matchText(previous.preview);
      if (!this.current.finished || (canonical && preview.startsWith(canonical) && preview.length > canonical.length)) {
        this.current.preview = previous.preview;
        this.current.interrupted = previous.interrupted;
        this.current.finished = false;
      }
    }
  }

  private applyArchive(archive: TranscriptRow[], active: TranscriptRow[]): TranscriptRow[] {
    for (const row of archive) this.applyRow(row, undefined, false);
    const activeKeys = new Set(active.map(row => row.key));
    const owners = new Map<string, Turn>();
    for (const turn of this.turns) {
      if (turn.optimistic) continue;
      turn.archivedUser = !!turn.userUuid && !activeKeys.has(turn.userUuid);
      const retained = [...turn.parts.keys(), turn.userUuid].filter((key): key is string => !!key && activeKeys.has(key));
      if (!retained.length) turn.finished = true;
      for (const key of retained) owners.set(key, turn);
    }
    // The last retained turn in native context can receive more model blocks.
    // Fully archived turns own neither the live screen nor new tool results.
    this.current = undefined;
    this.command = undefined;
    this.goalSet = undefined;
    this.restoring = false;
    for (const row of active) if (owners.has(row.key)) this.current = owners.get(row.key);
    const shown = new Set(archive.map(row => row.key));
    return active.filter(row => !shown.has(row.key));
  }

  private restoreIndices(previous: Turn[]) {
    // The leading half-turn may gain its user and earlier assistant blocks when
    // the next page arrives. Its already rendered bubble still owns the same ID.
    const users = new Map<string, number>();
    const parts = new Map<string, number>();
    const results = new Map<string, number>();
    const pending = new Map<Turn, number>();
    let next = 0;
    for (const turn of previous) {
      next = Math.max(next, turn.index + 1);
      if (turn.userUuid) users.set(turn.userUuid, turn.index);
      else {
        pending.set(turn, turn.index);
        for (const key of turn.parts.keys()) parts.set(key, turn.index);
        for (const item of turn.taskNotifications ?? []) parts.set(item.id, turn.index);
        for (const id of turn.results.keys()) results.set(id, turn.index);
      }
    }
    this.usedTurnIndices.clear();
    this.settledMessages = new WeakMap();
    for (const turn of this.turns) {
      const key = [...turn.parts.keys(), ...(turn.taskNotifications ?? []).map(item => item.id)].find(key => parts.has(key));
      const result = [...turn.results.keys()].find(id => results.has(id));
      const known = pending.get(turn) ?? (turn.userUuid && users.get(turn.userUuid)) ?? (key && parts.get(key)) ?? (result && results.get(result));
      const index = typeof known === 'number' && !this.usedTurnIndices.has(known) ? known : next++;
      this.usedTurnIndices.add(index);
      turn.index = index;
      if (turn.user) turn.user.id = `${this.idBase}:turn:${index}:user`;
    }
    this.nextTurnIndex = next;
  }

  nativeQueue(visible: string[]) {
    if (!visible.length) return [];
    // The native TUI labels only the final queued row. Earlier ordinary user
    // prompts may be adjacent. Match only entries observed in its enqueue log.
    const known = [...this.queuedInputs];
    const confirmed = visible.filter(text => {
      const i = known.indexOf(text);
      if (i < 0) return false;
      known.splice(i,1);
      return true;
    });
    return confirmed.length ? confirmed : visible.slice(-1);
  }

  /**
   * Claude Code's /rewind list for the current branch, oldest first: every prompt Lectern
   * offers to rewind to, and between them the local commands it lists too, for which Lectern
   * shows no message. A one-step `/model sonnet` or `/effort low` (how Lectern switches) and an
   * `/effort` slider closed with Esc write a `<command-name>` user record that no reply follows;
   * Claude Code lists it as "/model sonnet", "/effort low", "/effort" (2.1.300–2.1.330), while
   * /rename, /context and a /model picker closed with Esc write system records it does not list.
   * Their texts are the labels the native list shows. Undefined when a rewindable prompt is not
   * on the branch read, so the list cannot be vouched for.
   */
  rewindPoints(): { uuid: string; text: string }[] | undefined {
    const prompts = new Map(this.turns.filter(turn => turn.user && this.rewindable(turn)).map(turn => [turn.userUuid!, turn.user!.text]));
    const turnUsers = new Set(this.turns.map(turn => turn.userUuid));
    const points: { uuid: string; text: string }[] = [];
    for (const row of this.transcript.activeRows()) {
      const prompt = prompts.get(row.key);
      if (prompt !== undefined) {
        points.push({ uuid: row.key, text: prompt });
        prompts.delete(row.key);
      } else if (row.kind === 'command' && !turnUsers.has(row.key) && (!this.tipUsers || this.tipUsers.has(row.key))) {
        points.push({ uuid: row.key, text: row.text ?? '' });
      }
    }
    return prompts.size ? undefined : points;
  }
  checkpointUuid(menu: RewindMenu, index: number) {
    const users = this.turns.filter(turn => turn.user && this.rewindable(turn));
    const rows = menu.rows.filter(row => row.label !== '(current)');
    const candidates = users.flatMap((turn, i) => turn.user!.text === rows[index]?.label ? [i] : []);
    if (candidates.length === 1) return users[candidates[0]].userUuid;
    // With duplicate prompts, require a unique alignment of the entire visible
    // native page against the canonical branch, including its end if shown.
    const matches = candidates.filter(i => {
      const start = i - index;
      return start >= 0 && (!menu.rows.some(row => row.label === '(current)') || start + rows.length === users.length)
        && rows.every((row, pos) => users[start + pos]?.user?.text === row.label);
    });
    return matches.length === 1 ? users[matches[0]].userUuid : undefined;
  }
  confirmNativeRewind(draft: string, checkpointUuid?: string) {
    const matches = this.turns.filter(turn => turn.user?.text === draft && this.rewindable(turn));
    const uuid = checkpointUuid ?? (matches.length === 1 ? matches[0].userUuid : undefined);
    if (!uuid) {
      const last = this.turns.at(-1);
      if (last?.optimistic && last.user?.text === draft) {
        this.turns.pop();
        this.pendingCount--;
      }
      return;
    }
    const change = this.transcript.rewindBefore(uuid);
    if (!change) return;
    this.pages?.push([{ type: 'last-prompt', explicit: true, rewound: true, cutUuid: uuid, leafUuid: this.transcript.leafUuid }]);
    this.applyChange(change);
    this.terminalStatus = 'idle';
    return uuid;
  }

  optimisticUser(text: string): void {
    const turn = this.newTurn(text, true);
    this.terminalStatus = 'working';
    // Keep current pointing to the last canonical turn until the user's JSONL
    // arrives, so a delayed previous answer cannot populate this new bubble.
    turn.finished = false;
    diagnostic.event('display.optimistic_user', { turn: turn.index, text: summarize(text), currentCanonicalTurn: this.current?.index });
  }

  /** Explicit interrupt or loss of a previously active pane; never inferred from a pause. */
  markInterrupted(): void {
    const turn = this.foreground;
    if (turn && !turn.finished) turn.interrupted = true;
    this.terminalStatus = 'idle';
    diagnostic.event('display.interrupted', { turn: turn?.index, finished: turn?.finished, preview: summarize(turn?.preview ?? '') });
  }

  ingestScreen(screen: string, viewport?: string): void {
    const turn = this.foreground;
    const canonical = turn ? this.canonicalText(turn) : '';
    const preview = extractPreview(screen, turn?.user?.text ?? '', turn?.preview || canonical, viewport);
    this.terminalStatus = preview.status;
    if (turn?.finished && !turn.durationComplete && preview.status === 'working' && canonical && preview.anchored) {
      // A stop hook or continuation can produce a new response in the same
      // human turn. Admit only a fresh suffix aligned to the durable answer.
      const durable = matchText(canonical);
      const candidate = matchText(preview.text);
      if (candidate.length > durable.length && candidate.startsWith(durable)) turn.finished = false;
    }
    if (!turn || turn.finished || turn.interrupted) {
      diagnostic.event('display.preview.skipped', { reason: !turn ? 'no-turn' : turn.finished ? 'canonical-finished' : 'interrupted', turn: turn?.index, status: preview.status, extraction: preview.reason });
      return;
    }
    if (preview.text) {
      // Repaints can expose a shorter prefix for one capture. Keep the already
      // observed suffix until disk supplies the canonical correction.
      const older = matchText(turn.preview);
      const newer = matchText(preview.text);
      if (!(older.length > newer.length && older.startsWith(newer))) {
        turn.preview = preview.anchored ? preview.text : alignPreview(turn.preview || canonical, preview.text);
        diagnostic.event('display.preview.updated', { turn: turn.index, anchored: preview.anchored, extraction: preview.reason, canonical: summarize(canonical), previousNormalizedLength: older.length, candidate: summarize(preview.text), preview: summarize(turn.preview) });
      } else {
        diagnostic.event('display.preview.retained', { turn: turn.index, reason: 'transient-prefix-shrink', previousNormalizedLength: older.length, candidateNormalizedLength: newer.length });
      }
    }
    if (preview.status === 'idle' && canonical && (!turn.preview || matchText(canonical).includes(matchText(turn.preview)))) {
      // Some Claude versions persist stop_reason:null. An idle prompt plus a
      // fully reconciled answer can settle without inventing missing text.
      turn.finished = true;
      turn.preview = '';
      diagnostic.event('display.turn.settled', { turn: turn.index, reason: 'idle-canonical-covers-preview', canonical: summarize(canonical) });
    }
  }

  getMessages(): ChatMessage[] {
    const messages: ChatMessage[] = [];
    for (const turn of this.turns) {
      const isLast = turn === this.foreground;
      const cached = !isLast && this.settledMessages.get(turn);
      if (cached) { messages.push(...cached); continue; }
      const start = messages.length;
      if (turn.user) messages.push({ ...turn.user, tools: [],
        ...(this.rewindable(turn) && !turn.optimistic && { rewindUuid: turn.userUuid }),
      });
      const canonical = this.canonicalText(turn);
      // An interrupted turn keeps only what Claude Code saved.
      const text = turn.finished || turn.stopped ? canonical : alignPreview(canonical, turn.preview);
      const tools = this.toolsInOrder(turn);
      if (!text && !tools.length && !turn.attachments?.length && !turn.taskNotifications?.length && !turn.peerMessages?.length && !(isLast && turn.user && !turn.finished && !turn.stopped)) continue;
      const provisional = !turn.finished && !turn.stopped && (text !== canonical || (!canonical && !tools.length && !turn.peerMessages?.length && !turn.taskNotifications?.length));
      const cwds = this.textCwds(turn);
      messages.push({
        id: `${this.idBase}:turn:${turn.index}:assistant`,
        role: 'assistant',
        ...(turn.taskNotifications?.length ? { taskNotifications: turn.taskNotifications } : {}),
        ...(turn.peerMessages?.length ? { peerMessages: turn.peerMessages } : {}),
        ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
        ...(turn.stopped ? { interrupted: true } : {}),
        text,
        tools,
        ...(cwds && { cwds }),
        source: provisional ? 'preview' : 'jsonl',
        status: this.status !== 'error' && !turn.finished && !turn.interrupted && !turn.stopped && isLast && (provisional || this.status === 'working' || this.status === 'waiting') ? 'streaming' : 'complete',
        timestamp: turn.timestamp,
      });
      if (!isLast) this.settledMessages.set(turn, messages.slice(start));
    }
    if (!getDiagnosticsInfo().enabled) return messages;
    const state = messages.map(message => {
      const digest = this.messageDigests.get(message) ?? digestMessage(message);
      this.messageDigests.set(message, digest);
      return digest;
    });
    const stateHash = summarize(JSON.stringify(state)).sha256;
    if (this.lastMessageSummaryHash !== stateHash) {
      diagnostic.event('display.messages.changed', { messages: state, stateHash });
      this.lastMessageSummaryHash = stateHash;
    }
    return messages;
  }

  private toolsInOrder(turn: Turn): ToolBlock[] {
    const calls = new Map<string, ToolBlock>();
    let textLength = 0;
    for (const part of turn.parts.values()) {
      const separator = textLength && part.text ? '\n\n'.length : 0;
      for (const tool of part.tools) {
        const offset = tool.textOffset ?? part.text.length;
        // 段首工具位于前一段正文之后、下一段的分隔符之前。
        const textOffset = calls.get(tool.id)?.textOffset ?? textLength + (offset ? separator + offset : 0);
        calls.set(tool.id, { ...tool, ...turn.results.get(tool.id), textOffset });
      }
      textLength += separator + part.text.length;
    }
    const tools: ToolBlock[] = [];
    if (this.transcript.partialStart && !turn.userUuid) {
      // 只加载了结果时，调用来自更早的一页。补页后相同 ID 的卡片会获得原始位置。
      for (const [id, result] of turn.results) {
        if (!calls.has(id)) tools.push({ id, name: t('core.toolResult'), input: '', ...result, textOffset: null });
      }
    }
    return tools.concat([...calls.values()]);
  }

  /** Where each record's text starts in canonicalText (at the separator before it, where a call
   * between the two records sits), with the directory it was written in. The live preview's text
   * past the records continues in the last one. */
  private textCwds(turn: Turn): ChatMessage['cwds'] {
    const cwds: NonNullable<ChatMessage['cwds']> = [];
    let length = 0;
    for (const part of turn.parts.values()) {
      if (!part.text) continue;
      if (part.cwd && part.cwd !== cwds.at(-1)?.cwd) cwds.push({ textOffset: length, cwd: part.cwd });
      length += (length ? '\n\n'.length : 0) + part.text.length;
    }
    return cwds.length ? cwds : undefined;
  }

  private canonicalText(turn: Turn): string {
    return [...turn.parts.values()].map(part => part.text).filter(Boolean).join('\n\n');
  }

  private replyPosition(turn: Turn) {
    return { textOffset: this.canonicalText(turn).length, toolsBefore: this.toolsInOrder(turn).length };
  }

  private newTurn(text?: string, optimistic = false, uuid?: string, timestamp?: string): Turn {
    while (this.usedTurnIndices.has(this.nextTurnIndex)) this.nextTurnIndex++;
    const index = this.nextTurnIndex++;
    this.usedTurnIndices.add(index);
    const turn: Turn = { index, parts: new Map(), results: new Map(), preview: '', finished: false, interrupted: false, optimistic, timestamp };
    if (text !== undefined) turn.user = {
      id: `${this.idBase}:turn:${index}:user`, role: 'user', text, tools: [],
      source: optimistic ? 'pending' : 'jsonl', status: 'complete', timestamp,
    };
    turn.userUuid = uuid;
    if (!optimistic && this.pendingCount) this.turns.splice(this.turns.length - this.pendingCount, 0, turn);
    else this.turns.push(turn);
    if (optimistic) this.pendingCount++;
    diagnostic.event('display.turn.created', { turn: index, optimistic, userUuid: uuid, hasUser: text !== undefined, turnCount: this.turns.length });
    return turn;
  }

  private appendReplyAttachments(turn: Turn, refs: MessageAttachment[], partText?: string) {
    const { textOffset: prefix, toolsBefore: tools } = refs.some(ref => ref.image)
      ? this.replyPosition(turn) : { textOffset: 0, toolsBefore: 0 };
    for (const ref of refs) {
      const offset = partText === undefined ? 0 : ref.textOffset ?? 0;
      (turn.attachments ??= []).push(ref.image ? { ...ref,
        textOffset: prefix + (prefix && offset ? 2 : 0) + offset,
        toolsBefore: tools + (partText === undefined ? 0 : ref.toolsBefore ?? 0), peersBefore: turn.peerMessages?.length ?? 0,
        notificationsBefore: turn.taskNotifications?.length ?? 0,
      } : ref);
    }
  }

  private applyRow(row: TranscriptRow, existingUsers?: Set<string | undefined>, allowPending = true): void {
    if (this.current) this.settledMessages.delete(this.current);
    this.goals.ingest([row]);
    this.probe?.tracker.ingest([row]);
    if (row.goal) { this.applyGoal(row); return; }
    const set = this.goalSet;
    if (set && row.kind !== 'hidden' && row.kind !== 'attachment') {
      if (row.kind === 'command' && !set.command && /^\/goal\s+\S/u.test(row.text ?? '')) set.command = row.key;
      else if (!set.command || set.command !== this.command?.key || row.kind !== 'companion' && row.kind !== 'assistant') this.flushGoalSet();
    }
    if (row.kind === 'compact') this.compacted = true;
    else if (row.kind === 'user' || row.kind === 'assistant') this.compacted = false;
    const refs = row.attachments?.map(attachment => {
      this.attachments.set(attachment.ref.id, attachment);
      return attachment.ref;
    });
    if (row.kind === 'compact' || row.kind === 'command' && /^\/compact(?:\s|$)/.test(row.text ?? '')) this.restoring = true;
    else if (row.kind !== 'attachment' && row.kind !== 'hidden' && row.kind !== 'command' && row.kind !== 'duration') this.restoring = false;
    if (row.kind === 'attachment' && this.restoring) return;
    if (row.kind === 'attachment' && refs) {
      const turn = this.current;
      const inReply = !turn?.user || turn.parts.size > 0 || turn.results.size > 0 || !!turn.peerMessages?.length;
      const inputs = refs.filter(ref => !inReply || !ref.image);
      if (inputs.length && turn?.user) {
        const textOffset = turn.user.text.length;
        turn.user.attachments = [...turn.user.attachments ?? [], ...inputs.map(ref => ref.image ? { ...ref, textOffset } : ref)];
      }
      const images = inReply ? refs.filter(ref => ref.image) : [];
      if (images.length) this.appendReplyAttachments(this.current ??= this.newTurn(), images);
      return;
    }
    if (row.kind === 'command') {
      this.command = row;
      return;
    }
    if (row.kind === 'interruption') {
      if (this.current) this.current.stopped = true;
      return;
    }
    if (row.kind === 'compact') {
      this.command = undefined;
      return;
    }
    if (row.kind === 'user') {
      this.command = undefined;
      this.applyUser(row, existingUsers, allowPending);
      if (refs && this.current?.user) this.current.user.attachments = refs;
      return;
    }
    if (this.command && (row.kind === 'companion' || row.kind === 'assistant')) {
      this.applyUser(this.command, existingUsers, allowPending);
      // "/goal <condition>" became the turn its set record belongs to.
      if (this.goalSet?.command === this.command.key) this.flushGoalSet();
      this.command = undefined;
    }
    if (row.kind === 'notification') {
      const turn = this.current ??= this.newTurn();
      const position = this.replyPosition(turn);
      if (row.text) (turn.taskNotifications ??= []).push({ id: row.key, text: row.text, ...position });
      if (row.peers?.length) {
        for (const peer of row.peers) {
          const identity = JSON.stringify([peer.sender, peer.id]);
          if (this.seenPeerMessages.has(identity)) continue;
          this.seenPeerMessages.add(identity);
          (turn.peerMessages ??= []).push({ ...peer, ...position, notificationsBefore: turn.taskNotifications?.length ?? 0 });
        }
      }
      return;
    }
    if (row.kind === 'duration') {
      if (this.current) {
        this.current.durationComplete = true;
        this.current.durationAt = row.timestamp;
        this.current.backgroundAgents = row.backgroundAgents;
        this.current.backgroundWorkflows = row.backgroundWorkflows;
        // A timing row may be visible while the final text is still queued.
        if (this.current.parts.size || !this.current.preview) {
          this.current.finished = true;
          this.current.preview = '';
        }
      }
      return;
    }
    if (row.kind === 'result') {
      if (!this.current && this.transcript.partialStart) this.current = this.newTurn(undefined, false, undefined, row.timestamp);
      for (const item of row.results ?? []) this.current?.results.set(item.id, { result: item.result, isError: item.isError, ...(item.editPatch && { editPatch: item.editPatch }), ...(item.cellEdit && { cellEdit: item.cellEdit }), ...(item.resultCwd && { resultCwd: item.resultCwd }) });
      if (refs && this.current) this.appendReplyAttachments(this.current, refs);
      return;
    }
    if (row.kind !== 'assistant') return;
    const turn = this.current ??= this.newTurn();
    if (refs) this.appendReplyAttachments(turn, refs, row.text);
    const sameResponse = !!row.responseId && turn.responseId === row.responseId;
    turn.parts.set(row.key, { text: row.text ?? '', tools: row.tools ?? [], ...(row.cwd && { cwd: row.cwd }) });
    turn.timestamp ??= row.timestamp;
    turn.responseId = row.responseId;
    turn.responseComplete = !!row.responseComplete || (sameResponse && !!turn.responseComplete);
    turn.durationComplete = false;
    if (turn.responseComplete) {
      // A response can finish before a second response in the same turn has
      // reached disk. Keep an observed, aligned suffix across that interval.
      const canonical = matchText(this.canonicalText(turn));
      const preview = matchText(turn.preview);
      turn.finished = !(canonical && preview.length > canonical.length && preview.startsWith(canonical));
      if (turn.finished) turn.preview = '';
      turn.interrupted = false;
    } else {
      turn.finished = false;
    }
  }

  private applyGoal(row: TranscriptRow) {
    if (row.goalEcho) {
      // "Goal set: …" right after its command: the set record before the command already stands for it,
      // unless the page read began after that record. Then the echo does, in the command's turn.
      if (this.goalSet?.row.goal?.condition === row.goal!.condition) return;
      this.flushGoalSet();
      const command = this.command && /^\/goal\s+\S/u.test(this.command.text ?? '') ? this.command.key : undefined;
      this.goalSet = { row, restated: false, command };
      return;
    }
    this.flushGoalSet();
    if (row.goal!.kind === 'set') this.goalSet = { row, restated: this.compacted };
    else this.pushGoal(row);
  }
  private flushGoalSet() {
    const set = this.goalSet;
    this.goalSet = undefined;
    // A compaction's restatement of the goal already going on is no new setting.
    if (set && (set.command || !set.restated)) this.pushGoal(set.row);
  }
  /** Consecutive not-met checks of one goal are one row (with each reason); an error's notice
   * and the cleared record of one clearing are one row; a check-in delivered twice is one. */
  private pushGoal(row: TranscriptRow) {
    const turn = this.current ??= this.newTurn();
    const list = turn.taskNotifications ??= [], goal = row.goal!, last = list.at(-1), previous = last?.goal;
    if (last && previous?.kind === goal.kind && (previous.condition === goal.condition || goal.kind === 'cleared' && (!previous.condition || !goal.condition))) {
      if (goal.kind === 'not-met') {
        const reasons = [...previous.reasons ?? [previous.reason ?? ''], goal.reason ?? ''];
        list[list.length - 1] = { ...last, text: row.text ?? last.text, goal: { ...previous, ...goal, count: (previous.count ?? 1) + 1, reasons } };
        return;
      }
      if (goal.kind === 'cleared') {
        list[list.length - 1] = { ...last, goal: { ...previous, ...goal, condition: previous.condition ?? goal.condition, notice: previous.notice ?? goal.notice } };
        return;
      }
      if (goal.kind === 'checkin' && JSON.stringify(previous) === JSON.stringify(goal)) return;
    }
    list.push({ id: row.key, text: row.text ?? '', goal, ...this.replyPosition(turn) });
  }

  /**
   * Claude Code saves prompts in the order it receives them. Once a later send
   * is saved, earlier sends still unmatched were saved under a text the match
   * does not know, or never submitted. Kept, such a bubble stays below every
   * later turn, takes the live screen as its preview and can never settle.
   */
  private retireUnmatched(stale: Turn[], matchedBy: string) {
    if (!stale.length) return;
    this.turns = this.turns.filter(turn => !stale.includes(turn));
    this.pendingCount -= stale.length;
    diagnostic.event('display.pending.retired', { matchedBy, turns: stale.map(turn => ({ turn: turn.index,
      text: summarize(turn.user?.text ?? ''), preview: summarize(turn.preview), interrupted: turn.interrupted })) });
  }

  private applyUser(row: TranscriptRow, existingUsers: Set<string | undefined> | undefined, allowPending: boolean): void {
    const text = row.text ?? '';
    const sent = allowPending && this.pendingCount && !existingUsers?.has(row.key) ? this.turns.slice(-this.pendingCount) : [];
    const pending = sent.find(turn => samePrompt(turn.user?.text ?? '', text));
    const turn = pending ?? this.newTurn(text, false, row.key, row.timestamp);
    if (pending) {
      this.retireUnmatched(sent.slice(0, sent.indexOf(pending)), row.key);
      this.turns.splice(this.turns.indexOf(pending), 1);
      this.pendingCount--;
      this.turns.splice(this.turns.length - this.pendingCount, 0, pending);
    }
    turn.optimistic = false;
    turn.userUuid = row.key;
    turn.timestamp ??= row.timestamp;
    if (turn.user) {
      turn.user.source = 'jsonl'; turn.user.text = text; turn.user.timestamp = row.timestamp;
      // Claude Code reads the prompt's @-mentions from this directory.
      if (row.cwd) turn.user.cwds = [{ textOffset: 0, cwd: row.cwd }]; else delete turn.user.cwds;
    }
    this.current = turn;
  }
}

export { JsonlDecoder } from './jsonl';
export { extractPreview } from './screen';
