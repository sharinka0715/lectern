import { randomUUID } from 'node:crypto';
import type { Backend, HistoryCursor, LiveCursor } from '../backend';
import { MessageDisplay } from '../core/message-display';
import type { TranscriptAttachment } from '../core/transcript-attachments';
import type { ActivityState } from '../shared/activity';
import type { ChatMessage, SubagentTranscript, Workspace } from '../shared/types';
import { t } from '../shared/i18n';

export type SubagentBackend = Pick<Backend, 'readSubagent' | 'readSubagentOlder'>;
export interface SubagentRequest { revision?: number; older?: string; sizeMiB?: number; toolUseId?: string }

// Pages read to show the launch prompt above the first page, before the user
// asks for more: most subagent transcripts fit, a long one starts mid-run.
const FIRST_TURN_PAGES_MIB = [0.5, 2];

/**
 * One subagent's conversation for one pane: its own JSONL, read like the open
 * conversation (newest page first, then appended bytes; older pages on request)
 * and projected by the same MessageDisplay. Raw cursors stay in this process.
 */
export class SubagentReader {
  readonly scope: string;
  private readonly display: MessageDisplay;
  private live?: LiveCursor;
  private older?: { cursor: HistoryCursor; ticket: string };
  private revision = 0;
  private missing = false;
  private shownStatus?: ActivityState;
  private queue: Promise<unknown> = Promise.resolve();
  private attachments = new Map<string, TranscriptAttachment>();
  usedAt = 0;

  constructor(readonly sessionId: string, readonly agentId: string) {
    this.scope = `subagent:${agentId}:${randomUUID()}:`;
    this.display = new MessageDisplay(sessionId, agentId);
  }

  attachment(id: string) { return this.attachments.get(id); }

  /** Reads new records (or, with `older`, the previous page). Calls run one at a time. */
  read(backend: SubagentBackend, workspace: Workspace, request: SubagentRequest, status: ActivityState | undefined, isCurrent: () => boolean): Promise<SubagentTranscript> {
    const run = this.queue.then(async () => {
      if (request.older !== undefined) await this.loadOlder(backend, workspace, request.older, request.sizeMiB, isCurrent);
      else await this.loadLive(backend, workspace, isCurrent);
      return this.snapshot(request.revision, status);
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private async loadLive(backend: SubagentBackend, workspace: Workspace, isCurrent: () => boolean) {
    // A burst of appended records (more than one read window) is read at once.
    for (let round = 0; round < 8; round++) {
      const read = await backend.readSubagent(workspace, this.sessionId, this.agentId, this.live);
      if (!isCurrent()) throw new Error(t('main.subagentSwitched'));
      this.live = read.cursor;
      this.missing = read.missing;
      if (read.reset) {
        this.older = read.olderCursor && { cursor: read.olderCursor, ticket: randomUUID() };
        this.display.ingestJsonl(read.jsonl, true, !!read.olderCursor);
        if (read.skippedHistoryRecords) this.display.noteSkippedHistoryRecords(read.skippedHistoryRecords);
        this.revision++;
        for (const size of FIRST_TURN_PAGES_MIB) {
          if (!this.older || this.display.answeredHistoryHead) break;
          await this.prepend(backend, workspace, this.older, size, isCurrent);
        }
      } else if (read.jsonl.length) {
        this.display.ingestJsonl(read.jsonl);
        this.revision++;
      }
      if (!read.hasMore) break;
    }
  }

  private async loadOlder(backend: SubagentBackend, workspace: Workspace, ticket: string, sizeMiB: number | undefined, isCurrent: () => boolean) {
    // An expired ticket (a reset since) shows the current state.
    if (this.older && this.older.ticket === ticket) await this.prepend(backend, workspace, this.older, sizeMiB, isCurrent);
  }

  /** One older page, shown at once: a subagent's run is usually one long turn,
   * so its pages are not held back until a prompt appears. */
  private async prepend(backend: SubagentBackend, workspace: Workspace, older: NonNullable<SubagentReader['older']>, sizeMiB: number | undefined, isCurrent: () => boolean) {
    const page = await backend.readSubagentOlder(workspace, this.sessionId, this.agentId, older.cursor, sizeMiB);
    if (!isCurrent()) throw new Error(t('main.subagentSwitched'));
    if (this.older !== older) return;
    const next = page.olderCursor;
    if (next && (next.before <= 0 || next.before >= older.cursor.before)) throw new Error(t('controller.historyCursorStuck'));
    this.display.prependJsonl(page.jsonl, !!next);
    if (page.skippedHistoryRecords) this.display.noteSkippedHistoryRecords(page.skippedHistoryRecords);
    this.older = next && { cursor: next, ticket: randomUUID() };
    this.revision++;
  }

  private snapshot(known: number | undefined, status: ActivityState | undefined): SubagentTranscript {
    // Running or not decides whether the last reply is still being written.
    if (status !== this.shownStatus) { this.shownStatus = status; this.revision++; }
    const result: SubagentTranscript = { agentId: this.agentId, revision: this.revision, notice: this.display.notice,
      historyPage: { hasOlder: !!this.older, cursor: this.older?.ticket ?? '' }, ...(this.missing && { missing: true }) };
    if (known === this.revision) return result;
    const running = status === 'running';
    const all = this.display.getMessages(), last = all.at(-1);
    this.attachments.clear();
    result.messages = all.filter(message => message.role !== 'assistant' || message.text || message.tools.length || message.peerMessages?.length ||
      message.taskNotifications?.length || message.attachments?.length || running && message === last).map((message): ChatMessage => ({
      ...message, rewindUuid: undefined, status: running && message === last && message.role === 'assistant' ? 'streaming' : 'complete',
      attachments: message.attachments?.map(ref => {
        if (ref.path) return ref;
        const id = this.scope + ref.id;
        this.attachments.set(id, this.display.getAttachment(ref.id));
        return { ...ref, id };
      }),
    }));
    return result;
  }
}
