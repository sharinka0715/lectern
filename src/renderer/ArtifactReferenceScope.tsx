import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ArtifactReference, ArtifactResolution, Workspace } from '../shared/types';
import { isRelativePath, pathFromCwd, relativeToFile } from './artifact-paths';

/** Batch candidates from the entire mounted transcript (not one SSH command per word).
 * Keep results scoped to this pane and workspace; never reuse another host's answers. */
function makeLookup(workspaceId: string) {
  const cache = new Map<string, { value: Promise<ArtifactResolution>; expires: number }>();
  const pending = new Map<string, { reference: ArtifactReference; deliver: (match: ArtifactResolution) => void }>();
  let running = false;
  async function drain() {
    while (pending.size) {
      const batch: typeof pending = new Map();
      let bytes = 0;
      for (const [key, item] of pending) {
        const length = new TextEncoder().encode(key).length;
        if (batch.size >= 32 || bytes + length > 16384) break;
        batch.set(key, item); pending.delete(key); bytes += length;
      }
      let result: ArtifactResolution[] = [];
      try { result = await window.desktop.resolveArtifactReferences(workspaceId, [...batch.values()].map(item => item.reference)); }
      catch { /* Unavailable host or incomplete search: leave the source as text. */ }
      let i = 0;
      for (const [key, { deliver }] of batch) {
        const match = result[i++] ?? null;
        const entry = cache.get(key);
        if (entry) entry.expires = Date.now() + (match && match !== 'missing' ? 30_000 : 2000);
        deliver(match);
      }
    }
    running = false;
  }
  /** `cwd`: the directory a reply was written in, where its relative `path` is looked for first. */
  function lookup(path: string, cwd?: string) {
    const size = (value: string) => new TextEncoder().encode(value).length;
    if (!path || path.length > 4096 || size(path) > 4096) return Promise.resolve(null);
    if (cwd && size(cwd) > 4096) cwd = undefined;
    const key = cwd ? cwd + '\0' + path : path;
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    if (cache.size >= 2048) {
      // Reclaim expired lookups; cap work even for very large tool output.
      for (const [key, item] of cache) if (item.expires <= Date.now()) cache.delete(key);
      if (cache.size >= 2048) return Promise.resolve(null);
    }
    const value = new Promise<ArtifactResolution>(resolve => pending.set(key, { reference: cwd ? { path, cwd } : path, deliver: resolve }));
    cache.set(key, { value, expires: Infinity });
    if (!running) { running = true; queueMicrotask(() => void drain()); }
    return value;
  }
  return Object.assign(lookup, { clear() {
    for (const { deliver } of pending.values()) deliver(null);
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

/** The directory Claude Code was in when it wrote this part of a reply (its record's `cwd`). */
const Cwd = createContext<string | undefined>(undefined);
export function ReplyCwd({ cwd, children }: { cwd?: string; children: ReactNode }) {
  return <Cwd.Provider value={cwd?.startsWith('/') ? cwd : undefined}>{children}</Cwd.Provider>;
}

/** `ref`: what to open when the match is 'outside' (not checked): the path as written, from its directory. */
export function useArtifactResolution(path: string) {
  const scope = useContext(Scope), written = useContext(Cwd);
  const ref = scope?.file ? relativeToFile(scope.file, path) : path;
  const cwd = !scope?.file && written && isRelativePath(path) ? written : undefined;
  const [answer, setAnswer] = useState<{ scope: typeof scope; ref: string; cwd?: string; match: ArtifactResolution }>();
  useEffect(() => {
    let active = true;
    if (scope) void scope.lookup(ref, cwd).then(match => { if (active) setAnswer({ scope, ref, cwd, match }); });
    return () => { active = false; };
  }, [scope, ref, cwd]);
  return { ref: cwd ? pathFromCwd(cwd, ref) : ref, match: answer && answer.scope === scope && answer.ref === ref && answer.cwd === cwd ? answer.match : null };
}

/** Several references checked at once (one batch with the rest of the transcript); undefined until all are answered. */
export function useArtifactResolutions(paths: readonly string[]) {
  const scope = useContext(Scope);
  const key = JSON.stringify(paths);
  const [answer, setAnswer] = useState<{ scope: typeof scope; key: string; matches: Map<string, ArtifactResolution> }>();
  useEffect(() => {
    let active = true;
    const refs: string[] = JSON.parse(key);
    if (scope && refs.length) void Promise.all(refs.map(ref => scope.lookup(ref))).then(results => {
      if (active) setAnswer({ scope, key, matches: new Map(refs.map((ref, i) => [ref, results[i]])) });
    });
    return () => { active = false; };
  }, [scope, key]);
  return answer && answer.scope === scope && answer.key === key ? answer.matches : undefined;
}
