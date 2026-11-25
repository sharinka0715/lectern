import type { ArtifactReference, ArtifactReferenceResult, ArtifactResolution, Workspace } from '../shared/types';

const HIT_TTL = 30_000;
const RETRY_TTL = 2000;
// Share the previous per-transcript budget across the window. Paths can be long,
// and repeated transcripts should not make memory grow for the life of the app.
const CACHE_LIMIT = 2048;
const encoder = new TextEncoder();

type Resolve = (id: string, references: ArtifactReference[], identity: string) => Promise<ArtifactReferenceResult[]>;
type Listener = (match: ArtifactResolution) => void;
interface Entry {
  reference: ArtifactReference;
  bytes: number;
  match?: ArtifactResolution;
  expires: number;
  pending: boolean;
  listeners: Set<Listener>;
  release: () => void;
}

function candidate(path: string, cwd?: string) {
  if (!path || path.length > 4096) return undefined;
  const pathBytes = encoder.encode(path).length;
  if (pathBytes > 4096) return undefined;
  const cwdBytes = cwd && cwd.length <= 4096 ? encoder.encode(cwd).length : Infinity;
  return cwd && cwdBytes <= 4096
    ? { key: cwd + '\0' + path, reference: { path, cwd }, bytes: cwdBytes + pathBytes }
    : { key: path, reference: path, bytes: pathBytes };
}

export class ArtifactReferenceCache {
  private readonly lookups = new Map<string, ReturnType<ArtifactReferenceCache['makeLookup']>>();
  private readonly recent = new Set<Entry>();
  private identities?: Set<string>;

  constructor(private readonly resolve: Resolve, private readonly now = Date.now, private readonly limit = CACHE_LIMIT) {}

  forWorkspace(id: string, identity: string) {
    let lookup = this.lookups.get(identity);
    if (!lookup) {
      lookup = this.makeLookup(id, identity);
      this.lookups.set(identity, lookup);
    }
    return lookup;
  }

  syncWorkspaces(workspaces: readonly Workspace[]) {
    this.identities = new Set(workspaces.map(workspace => JSON.stringify(workspace)));
    for (const [identity, lookup] of this.lookups) {
      if (this.identities.has(identity)) continue;
      this.lookups.delete(identity);
      lookup.invalidate();
    }
  }

  private touch(entry: Entry) {
    this.recent.delete(entry);
    this.recent.add(entry);
    if (this.recent.size <= this.limit) return;
    const oldest = this.recent.values().next().value!;
    this.recent.delete(oldest);
    oldest.release();
  }

  private makeLookup(id: string, identity: string) {
    const entries = new Map<string, Entry>(), queue = new Set<Entry>();
    let invalidated = false, running = false, pending = 0;
    const allowed = () => !invalidated && (!this.identities || this.identities.has(identity));

    // Batch the visible transcript(s) and keep requests deduplicated even if
    // their last observer unmounts before the target machine answers.
    const drain = async () => {
      while (queue.size && allowed()) {
        const batch: Entry[] = [];
        let bytes = 0;
        for (const entry of queue) {
          if (batch.length >= 32 || bytes + entry.bytes > 16384) break;
          batch.push(entry);
          queue.delete(entry);
          bytes += entry.bytes;
        }
        let results: ArtifactReferenceResult[] = [];
        try { results = await this.resolve(id, batch.map(entry => entry.reference), identity); }
        catch { /* Keep the last answer when the machine is unavailable. */ }
        if (!allowed()) break;
        batch.forEach((entry, index) => {
          const result = results[index], previous = entry.match;
          const match = result === undefined ? previous ?? null : result;
          entry.pending = false;
          pending--;
          entry.expires = this.now() + (result && result !== 'missing' ? HIT_TTL : RETRY_TTL);
          this.touch(entry);
          if (previous === match || previous && match && typeof previous === 'object' && typeof match === 'object' && previous.path === match.path) return;
          entry.match = match;
          for (const listener of entry.listeners) listener(match);
        });
      }
      running = false;
    };

    return {
      peek: (path: string, cwd?: string) => {
        const ref = candidate(path, cwd);
        return ref && allowed() ? entries.get(ref.key)?.match : undefined;
      },
      watch: (path: string, cwd: string | undefined, listener: Listener) => {
        const ref = candidate(path, cwd);
        if (!ref || !allowed()) { listener(null); return; }
        const { key, reference, bytes } = ref;
        let entry = entries.get(key);
        if (!entry) {
          if (pending >= CACHE_LIMIT) { listener(null); return; }
          entry = { reference, bytes, expires: 0, pending: false, listeners: new Set(), release: () => {
            const current = entries.get(key);
            // An evicted answer can still serve its mounted links.
            if (current && !current.listeners.size && !current.pending && !this.recent.has(current)) entries.delete(key);
          } };
          entries.set(key, entry);
        }
        const subscription = (match: ArtifactResolution) => listener(match);
        entry.listeners.add(subscription);
        if (entry.match !== undefined) {
          this.touch(entry);
          listener(entry.match);
        }
        if (!entry.pending && entry.expires <= this.now() && pending < CACHE_LIMIT) {
          pending++;
          entry.pending = true;
          queue.add(entry);
          if (!running) { running = true; queueMicrotask(() => void drain()); }
        }
        return () => { entry.listeners.delete(subscription); entry.release(); };
      },
      invalidate: () => {
        invalidated = true;
        queue.clear();
        for (const entry of entries.values()) {
          this.recent.delete(entry);
          for (const listener of entry.listeners) listener(null);
          entry.listeners.clear();
        }
        entries.clear();
      },
    };
  }
}

export const artifactReferences = new ArtifactReferenceCache((id, references, identity) =>
  window.desktop.resolveArtifactReferences(id, references, identity));
