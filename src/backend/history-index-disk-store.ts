import { createHash, randomUUID } from 'node:crypto';
import { t } from '../shared/i18n';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { diagnostic, redactText } from '../diagnostics';
import type { Workspace } from '../shared/types';
import type { IndexedFile } from './history-index';
import { isMissingCwdReason } from './history';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const validUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
function fingerprint(value: unknown): value is { key: string; order?: unknown; before?: unknown } {
  return !!value && typeof value === 'object' && 'key' in value && typeof value.key === 'string' && /^[0-9a-f]{64}$/.test(value.key);
}
function boundedOffset(v: unknown, max: number): v is number { return typeof v === 'number' && Number.isSafeInteger(v) && v >= -1 && v <= max; }
function groupProof(v: unknown) { if (fingerprint(v) && boundedOffset(v.order, 31)) return { key: v.key, order: v.order }; }
function continuationProof(v: unknown, size: number) { if (fingerprint(v) && boundedOffset(v.before, size)) return { key: v.key, before: v.before }; }
// Only UUIDs and offsets: a predecessor's cut point is bounded by its own size,
// which the successor row does not know, so accept any safe offset here.
function linkProofs(v: unknown) {
  if (!Array.isArray(v) || v.length > 16) return;
  const proofs = v.flatMap(p => fingerprint(p) && (p.before === -2 || boundedOffset(p.before, Number.MAX_SAFE_INTEGER)) && 'depth' in p
    && Number.isSafeInteger(p.depth) && (p.depth as number) >= 0 ? [{ key: p.key, before: p.before, depth: p.depth as number }] : []);
  return proofs.length ? proofs as { key: string; before: number; depth: number }[] : undefined;
}
function anchors(v: unknown) {
  if (!v || typeof v !== 'object') return;
  const { head, headKind, lastBoundary } = v as Record<string, unknown>;
  return { ...(validUuid(head) && (headKind === 'root' || headKind === 'boundary' || headKind === 'other') && { head, headKind }),
    ...(validUuid(lastBoundary) && { lastBoundary }) } as IndexedFile['anchors'];
}
const statStamp = /^\d+\|\d+\|[\d .:+-]+\|[\d .:+-]+$/;
const maxBytes = 16 * 1024 * 1024;
const validStamp = (v: unknown): v is string => typeof v === 'string' && v.length <= 200 && statStamp.test(v);
const validPath = (v: unknown): v is string => typeof v === 'string' && v.startsWith('/') && v.length <= 4096 && !/[\x00-\x1f\x7f]/.test(v) && !v.includes('|~lectern~|');
const privateMode = (s: Stats) => process.platform === 'win32' || (!(s.mode & 0o077) && s.uid === process.getuid!());

interface Location { cwd: string; cwdAliases: string[]; claudeDir: string; projectDirs: string[] }
export interface HistoryIndexPersistence {
  read(): Promise<Map<string, IndexedFile>>;
  write(rows: Iterable<IndexedFile>): Promise<boolean>;
  /** Reuse only the content proofs of unchanged files: titles and other
   * metadata are read again (cheap on this computer; the snapshot
   * keeps no prompt text, so reusing it would show placeholder titles). */
  proofsOnly?: boolean;
}

// Never serialize an IndexedFile or its metadata wholesale: even `title` can
// be verbatim user text or a conversation summary. Only native names qualify.
function nativeName(source: unknown, title: unknown) {
  if ((source === 'custom' || source === 'ai') && typeof title === 'string' && title.length <= 512 && title.trim()
    && !/[\x00-\x1f\x7f-\x9f\p{Zl}\p{Zp}]/u.test(title) && redactText(title) === title) return { titleSource: source, title } as const;
}
function timestamp(value: unknown) {
  if (typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
}
function report(operation: string, error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== 'ENOENT') diagnostic.event('history.index.disk_unavailable', { operation, code }, 'warn');
}

/** One expendable, private snapshot per added folder (local or SSH), outside
 * workspaces.json.
 * The single-owner Electron profile orders replacements/removals, even across
 * different incarnations of the in-memory index for an edited workspace. */
export class HistoryIndexDiskStore {
  private readonly directory: string;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(userDataDirectory: string) { this.directory = join(userDataDirectory, 'history-index'); }

  private file(id: string) { return join(this.directory, digest(id) + '.json'); }
  private async checkDirectory() {
    const info = await lstat(this.directory);
    if (!info.isDirectory() || !privateMode(info)) throw new Error('Unsafe history index directory');
  }
  private enqueue<T>(operation: () => Promise<T>) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }
  async flush() { await this.pending; }
  remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      try { await this.checkDirectory(); await unlink(this.file(id)); } catch (error) { report('remove', error); }
    });
  }

  forWorkspace(workspace: Workspace, location: Location): HistoryIndexPersistence | undefined {
    // Every kind of folder: re-proving resumed copies in a large local project
    // costs minutes of CPU on each launch, the same as reading it over SSH.
    const { projectDirs, cwdAliases } = location, file = this.file(workspace.id);
    // An omitted port honors OpenSSH config; it is not necessarily port 22.
    // Include the physical cwd: distinct cwd values can have the same project slug.
    const scope = digest(JSON.stringify([workspace.kind, workspace.host, workspace.port, workspace.cwd, workspace.claudeDir,
      location.cwd, cwdAliases, location.claudeDir, projectDirs]));
    return {
      proofsOnly: workspace.kind !== 'ssh',
      read: async () => {
        const rows = new Map<string, IndexedFile>();
        try {
          await this.pending;
          await this.checkDirectory();
          if (!(await lstat(file)).isFile()) return rows;
          const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
          let data;
          try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.nlink !== 1 || !privateMode(stat) || stat.size > maxBytes) return rows;
            data = JSON.parse(await handle.readFile('utf8'));
          } finally { await handle.close(); }
          if (data?.version !== 1 || data.scope !== scope || !Array.isArray(data.files) || data.files.length > 1000) return rows;
          for (const entry of data.files) {
            if (!entry || !Number.isInteger(entry.dir) || entry.dir < 0 || entry.dir >= projectDirs.length || !validUuid(entry.id)
              || !validStamp(entry.stamp) || (entry.sidecarStamp !== undefined && !validStamp(entry.sidecarStamp))) continue;
            const cwd = validPath(entry.cwd) ? entry.cwd : undefined;
            const missingCwd = !cwd && isMissingCwdReason(entry.missingCwd) ? entry.missingCwd : undefined;
            if (!cwd && (!missingCwd || missingCwd === 'partial')) continue;
            const mine = !!cwd && cwdAliases.includes(cwd), includeNavigation = !cwd || mine;
            const forkParentId = includeNavigation && validUuid(entry.forkParentId) ? entry.forkParentId : undefined;
            const continuedInSessionId = includeNavigation && validUuid(entry.continuedInSessionId) ? entry.continuedInSessionId : undefined;
            const nativeHint = mine && validUuid(entry.nativeHint) ? entry.nativeHint : undefined;
            const [inode, rawSize] = entry.stamp.split('|'), size = Number(rawSize);
            if (!Number.isSafeInteger(size)) continue;
            const path = `${projectDirs[entry.dir]}/${entry.id}.jsonl`;
            const name = includeNavigation ? nativeName(entry.titleSource, entry.title) : undefined;
            rows.set(path, { path, id: entry.id, inode, size, stamp: entry.stamp, sidecarStamp: entry.sidecarStamp, titles: {},
              nativeHint, groupProof: mine ? groupProof(entry.groupProof) : undefined,
              continuationProof: mine ? continuationProof(entry.continuationProof, size) : undefined,
              anchors: anchors(entry.anchors), linkProofs: mine ? linkProofs(entry.linkProofs) : undefined,
              metadata: { cwd, missingCwd, forkParentId, continuedInSessionId, updatedAt: includeNavigation ? timestamp(entry.updatedAt) : undefined,
                ...(typeof entry.contentless === 'boolean' && { contentless: entry.contentless }),
                ...(name ?? { title: t('backend.pastConversation', { id: entry.id.slice(0, 8) }) }) } });
          }
        } catch (error) { report('read', error); }
        return rows;
      },
      write: rows => this.enqueue(async () => {
        const staging = `${file}.${randomUUID()}.tmp`;
        try {
          const files = [];
          for (const row of rows) {
            const dir = projectDirs.indexOf(posix.dirname(row.path));
            if (dir < 0 || !validUuid(row.id) || !validStamp(row.stamp) || (row.sidecarStamp !== undefined && !validStamp(row.sidecarStamp))) continue;
            const { cwd, missingCwd, forkParentId, continuedInSessionId, updatedAt, titleSource, title, contentless } = row.metadata;
            if (!validPath(cwd) && (cwd !== undefined || !isMissingCwdReason(missingCwd) || missingCwd === 'partial')) continue;
            // An explicit custom name can precede the first turn with a cwd. The
            // live pane (not the disk cache) must still prove project membership.
            const mine = !!cwd && cwdAliases.includes(cwd), includeNavigation = cwd === undefined || mine;
            files.push({ dir, id: row.id, stamp: row.stamp, sidecarStamp: row.sidecarStamp, cwd, missingCwd: cwd ? undefined : missingCwd,
              nativeHint: mine && validUuid(row.nativeHint) ? row.nativeHint : undefined, groupProof: mine ? groupProof(row.groupProof) : undefined,
              continuationProof: mine ? continuationProof(row.continuationProof, row.size) : undefined,
              anchors: anchors(row.anchors), linkProofs: mine ? linkProofs(row.linkProofs) : undefined,
              forkParentId: includeNavigation && validUuid(forkParentId) ? forkParentId : undefined,
              continuedInSessionId: includeNavigation && validUuid(continuedInSessionId) ? continuedInSessionId : undefined,
              updatedAt: includeNavigation ? timestamp(updatedAt) : undefined, ...(includeNavigation ? nativeName(titleSource, title) : {}),
              ...(typeof contentless === 'boolean' && { contentless }) });
          }
          const content = JSON.stringify({ version: 1, scope, files });
          if (Buffer.byteLength(content) > maxBytes) return false;
          await mkdir(this.directory, { recursive: true, mode: 0o700 });
          await this.checkDirectory();
          const handle = await open(staging, 'wx', 0o600);
          try {
            try { await handle.writeFile(content); } finally { await handle.close(); }
            await rename(staging, file);
          } finally { await unlink(staging).catch(() => {}); }
          return true;
        } catch (error) { report('write', error); return false; }
      }),
    };
  }
}
