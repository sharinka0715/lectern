import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ArtifactResolution, Workspace } from '../shared/types';
import { relativeToFile } from './artifact-paths';

/** Batch candidates from the entire mounted transcript (not one SSH command per word).
 * Keep results scoped to this pane and workspace; never reuse another host's answers. */
function makeLookup(workspaceId: string) {
  const cache = new Map<string, { value: Promise<ArtifactResolution>; expires: number }>();
  const pending = new Map<string, (match: ArtifactResolution) => void>();
  let running = false;
  async function drain() {
    while (pending.size) {
      const batch: typeof pending = new Map();
      let bytes = 0;
      for (const [path, deliver] of pending) {
        const length = new TextEncoder().encode(path).length;
        if (batch.size >= 32 || bytes + length > 16384) break;
        batch.set(path, deliver); pending.delete(path); bytes += length;
      }
      let result: ArtifactResolution[] = [];
      try { result = await window.desktop.resolveArtifactReferences(workspaceId, [...batch.keys()]); }
      catch { /* Unavailable host or incomplete search: leave the source as text. */ }
      let i = 0;
      for (const [path, deliver] of batch) {
        const match = result[i++] ?? null;
        const entry = cache.get(path);
        if (entry) entry.expires = Date.now() + (match && match !== 'missing' ? 30_000 : 2000);
        deliver(match);
      }
    }
    running = false;
  }
  function lookup(path: string) {
    if (!path || path.length > 4096 || new TextEncoder().encode(path).length > 4096) return Promise.resolve(null);
    const cached = cache.get(path);
    if (cached && cached.expires > Date.now()) return cached.value;
    if (cache.size >= 2048) {
      // Reclaim expired lookups; cap work even for very large tool output.
      for (const [key, item] of cache) if (item.expires <= Date.now()) cache.delete(key);
      if (cache.size >= 2048) return Promise.resolve(null);
    }
    const value = new Promise<ArtifactResolution>(resolve => pending.set(path, resolve));
    cache.set(path, { value, expires: Infinity });
    if (!running) { running = true; queueMicrotask(() => void drain()); }
    return value;
  }
  return Object.assign(lookup, { clear() {
    for (const deliver of pending.values()) deliver(null);
    pending.clear(); cache.clear();
  } });
}

const Scope = createContext<{ lookup: ReturnType<typeof makeLookup>; workspaceId: string; sessionId?: string; file?: string } | undefined>(undefined);
export const useArtifactScope = () => useContext(Scope);

export function ArtifactReferenceScope({ workspace, sessionId, file, children }: { workspace?: Workspace; sessionId?: string; file?: string; children: ReactNode }) {
  const identity = JSON.stringify(workspace), id = workspace?.id;
  const lookup = useMemo(() => id ? makeLookup(id) : undefined, [id, identity]);
  useEffect(() => () => lookup?.clear(), [lookup]);
  const scope = useMemo(() => id && lookup ? { workspaceId: id, sessionId, lookup, file } : undefined, [id, sessionId, lookup, file]);
  return <Scope.Provider value={scope}>{children}</Scope.Provider>;
}

export function useArtifactResolution(path: string) {
  const scope = useContext(Scope);
  const ref = scope?.file ? relativeToFile(scope.file, path) : path;
  const [answer, setAnswer] = useState<{ scope: typeof scope; ref: string; match: ArtifactResolution }>();
  useEffect(() => {
    let active = true;
    if (scope) void scope.lookup(ref).then(match => { if (active) setAnswer({ scope, ref, match }); });
    return () => { active = false; };
  }, [scope, ref]);
  return { ref, match: answer && answer.scope === scope && answer.ref === ref ? answer.match : null };
}
