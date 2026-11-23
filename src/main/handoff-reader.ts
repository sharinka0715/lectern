import { randomUUID } from 'node:crypto';
import type { Backend, HistoryCursor } from '../backend';
import { repairSlices } from '../backend/transcript-pages';
import { MessageDisplay } from '../core/message-display';
import type { TranscriptAttachment } from '../core/transcript-attachments';
import type { ChatMessage, HandoffHistorySnapshot, Workspace } from '../shared/types';
import { t } from '../shared/i18n';

/** 一份只读源段的对话投影。原始字节游标只在主进程使用。 */
export class HandoffReader {
  readonly scope = `handoff:${randomUUID()}:`;
  readonly display: MessageDisplay;
  private cursor?: HistoryCursor;
  private ticket?: string;
  private started = false;
  private extending = false;
  private pending?: Promise<HandoffHistorySnapshot>;
  private attachments = new Map<string, TranscriptAttachment>();

  constructor(readonly sourceId: string) { this.display = new MessageDisplay(sourceId); }

  attachment(id: string) { return this.attachments.get(id); }

  private scopedAttachment(attachment: TranscriptAttachment) {
    const ref = attachment.ref;
    if (ref.path) return ref;
    const id = this.scope + ref.id;
    this.attachments.set(id, attachment);
    return { ...ref, id };
  }

  private otherRecords(): ChatMessage[] {
    const messages: ChatMessage[] = [];
    for (const row of this.display.otherHistoryRows()) {
      const tools = row.tools ?? row.results?.map(result => ({ ...result, name: t('main.toolResult'), input: '' })) ?? [];
      if (!row.text && !tools.length && !row.attachments?.length && !row.peers?.length) continue;
      messages.push({ id: `${this.scope}record:${row.key}`, role: ['user', 'command'].includes(row.kind) ? 'user' : 'assistant',
        source: 'jsonl', status: 'complete', timestamp: row.timestamp, text: row.text ?? '', tools, ...(row.kind === 'assistant' && row.cwd && { cwds: [{ textOffset: 0, cwd: row.cwd }] }),
        attachments: row.attachments?.map(item => this.scopedAttachment(item)),
        peerMessages: row.peers?.map(peer => ({ ...peer, textOffset: 0, toolsBefore: 0 })) });
    }
    return messages;
  }

  read(backend: Pick<Backend, 'readHandoffHistory'>, workspace: Workspace, tipId: string, ticket: string | undefined, sizeMiB: number | undefined, isCurrent: () => boolean) {
    if (ticket !== this.ticket) throw new Error(t('main.handoffPageExpired'));
    if (this.pending) return this.pending;
    const promise = this.load(backend, workspace, tipId, !!ticket, sizeMiB, isCurrent);
    this.pending = promise;
    const clear = () => { this.pending = undefined; };
    promise.then(clear, clear);
    return promise;
  }

  private async load(backend: Pick<Backend, 'readHandoffHistory'>, workspace: Workspace, tipId: string, previous: boolean, sizeMiB: number | undefined, isCurrent: () => boolean) {
    let ready = false;
    do {
      const before = this.cursor;
      const page = await backend.readHandoffHistory(workspace, tipId, this.sourceId, before, this.started ? sizeMiB ?? 3 : 0.125);
      if (!isCurrent()) throw new Error(t('main.handoffSwitched'));
      const slices = before && this.extending ? repairSlices(page, before, this.sourceId) : [page];
      for (const part of slices) {
        const next = part.olderCursor;
        if (next && this.cursor && next.before >= this.cursor.before) throw new Error(t('main.handoffCursorStuck'));
        if (!this.started) {
          this.display.ingestJsonl(part.jsonl, true, !!next);
          this.started = true;
          ready = !!this.display.answeredHistoryHead;
        } else {
          ready = !!this.display.prependJsonl(part.jsonl, !!next, true, previous);
        }
        this.cursor = next;
        if (part.skippedHistoryRecords) this.display.noteSkippedHistoryRecords(part.skippedHistoryRecords);
        if (ready || !next) break;
        this.extending = true;
      }
    } while (!ready && this.cursor);
    this.extending = false;
    this.ticket = this.cursor && randomUUID();
    this.attachments.clear();
    const messages = this.display.getMessages().filter(m => m.role !== 'assistant' || m.text || m.tools.length ||
      m.peerMessages?.length || m.taskNotifications?.length || m.attachments?.length).map((message): ChatMessage => ({
        ...message, rewindUuid: undefined, status: 'complete',
        attachments: message.attachments?.map(ref => {
          if (ref.path) return ref;
          const id = this.scope + ref.id;
          this.attachments.set(id, this.display.getAttachment(ref.id));
          return { ...ref, id };
        }),
      }));
    const otherRecords = this.otherRecords();
    return { messages, ...(otherRecords.length && { otherRecords }), cursor: this.ticket, notice: this.display.notice };
  }
}
