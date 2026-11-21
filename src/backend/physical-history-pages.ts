import { createHash } from 'node:crypto';
import { t } from '../shared/i18n';
import type { Workspace } from '../shared/types';
import { physicalStamp, type PhysicalSession } from './physical-history';
import { historyRevisionGuard, TranscriptPages, type HistoryCursor } from './transcript-pages';
import type { Transport } from './transport';

const stale = () => t('backend.physicalHistoryChanged');

/** Only the backwards cursor uses logical coordinates. Its inode/size/guard
 * still refer to the open tip. A change to ANY frozen prefix invalidates the
 * layout; simple forward appends at the tip do not move earlier offsets. */
export class PhysicalHistoryPages {
  readonly key: string;
  readonly prefixBytes: number;
  constructor(readonly source: PhysicalSession) {
    this.key = createHash('sha256').update(JSON.stringify([source.file.path,source.file.inode,
      ...source.previous.map(({file,end}) => [file.path,file.stamp,end])])).digest('hex');
    this.prefixBytes = source.previous.reduce((n,part) => n+part.end,0);
  }

  matchesTip(window: {inode:string; size:number; stamp?:string}) {
    const tip = this.source.file;
    return window.inode === tip.inode && window.size === tip.size && window.stamp === physicalStamp(tip);
  }
  cursor(physical: HistoryCursor | undefined, window: { inode: string; size: number; stamp?:string; guard?:string }) {
    if (!this.matchesTip(window)) throw new Error(stale());
    const before = this.prefixBytes + (physical?.before ?? 0);
    if (!before) return;
    return {layout:this.key, before, inode:window.inode, size:window.size, guard:window.guard};
  }

  async older(t:Transport,w:Workspace,cursor:HistoryCursor,sizeMiB?:number) {
    if (cursor.layout !== this.key || !Number.isSafeInteger(cursor.before) || cursor.before <= 0 ||
      !Number.isSafeInteger(cursor.size) || cursor.before > this.prefixBytes+cursor.size || cursor.inode !== this.source.file.inode) throw new Error(stale());
    let base = 0;
    // Check ALL sealed members on the target on the same request. In
    // particular a predecessor resumed after discovery no longer owns this
    // edge. Never switch to its new bytes using a stale cut or logical cursor.
    const guards = this.source.previous.map(({file}) => historyRevisionGuard(file.path,
      {inode:file.inode,size:file.size,before:file.size,frozenStamp:physicalStamp(file)})).join('');
    for (const {file,end} of [...this.source.previous,{file:this.source.file,end:cursor.size}]) {
      if (cursor.before > base + end) { base += end; continue; }
      const tip = file === this.source.file;
      const local: HistoryCursor = {before:cursor.before-base, inode:file.inode, size:tip ? cursor.size : file.size,
        ...(tip ? {guard:cursor.guard} : {frozenStamp:physicalStamp(file)})};
      const moreGuards = tip ? '' : historyRevisionGuard(this.source.file.path,cursor);
      const page = await new TranscriptPages(t,w,file.id,[file.path],guards+moreGuards).older(local,sizeMiB);
      const before = base+(page.olderCursor?.before??0);
      return {...page, sourceSessionId: tip ? undefined : file.id, olderCursor: before ? {...cursor,before} : undefined};
    }
    throw new Error(stale());
  }
}
