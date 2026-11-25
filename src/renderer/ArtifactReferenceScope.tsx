import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ArtifactResolution, Workspace } from '../shared/types';
import { isRelativePath, pathFromCwd, relativeToFile } from './artifact-paths';
import { artifactReferences } from './artifact-reference-cache';

type Lookup = ReturnType<typeof artifactReferences.forWorkspace>;
const Scope = createContext<{ lookup: Lookup; workspaceId: string; sessionId?: string; file?: string } | undefined>(undefined);
export const useArtifactScope = () => useContext(Scope);

export function ArtifactReferenceScope({ workspace, sessionId, file, children }: { workspace?: Workspace; sessionId?: string; file?: string; children: ReactNode }) {
  const id = workspace?.id, lookup = id ? artifactReferences.forWorkspace(id, JSON.stringify(workspace)) : undefined;
  const scope = useMemo(() => id && lookup ? { workspaceId: id, sessionId, lookup, file } : undefined, [id, lookup, sessionId, file]);
  return <Scope.Provider value={scope}>{children}</Scope.Provider>;
}

/** The directory Claude Code was in when it wrote this part of a reply (its record's `cwd`). */
const Cwd = createContext<string | undefined>(undefined);
export function ReplyCwd({ cwd, children }: { cwd?: string; children: ReactNode }) {
  return <Cwd.Provider value={cwd?.startsWith('/') ? cwd : undefined}>{children}</Cwd.Provider>;
}

/** `ref`: what to open when the match is 'outside' (not checked): the path as written, from its directory. */
export function useArtifactResolution(path: string) {
  const scope = useContext(Scope), written = useContext(Cwd), lookup = scope?.lookup;
  const ref = scope?.file ? relativeToFile(scope.file, path) : path;
  const cwd = !scope?.file && written && isRelativePath(path) ? written : undefined;
  const [answer, setAnswer] = useState<{ lookup: Lookup; ref: string; cwd?: string; match: ArtifactResolution }>();
  useEffect(() => lookup?.watch(ref, cwd, match => setAnswer({ lookup, ref, cwd, match })), [lookup, ref, cwd]);
  const match = answer && answer.lookup === lookup && answer.ref === ref && answer.cwd === cwd ? answer.match : lookup?.peek(ref, cwd) ?? null;
  return { ref: cwd ? pathFromCwd(cwd, ref) : ref, match };
}

/** Several references checked at once (one batch with the rest of the transcript); undefined until all are answered. */
export function useArtifactResolutions(paths: readonly string[]) {
  const lookup = useContext(Scope)?.lookup;
  const key = JSON.stringify(paths);
  const refs = useMemo(() => new Set<string>(JSON.parse(key)), [key]);
  const [answer, setAnswer] = useState<{ lookup: Lookup; refs: typeof refs; matches: Map<string, ArtifactResolution> }>();
  useEffect(() => {
    if (!lookup || !refs.size) return;
    const matches = new Map<string, ArtifactResolution>();
    const stops = Array.from(refs, ref => lookup.watch(ref, undefined, match => {
      matches.set(ref, match);
      if (matches.size === refs.size) setAnswer({ lookup, refs, matches: new Map(matches) });
    }));
    return () => { for (const stop of stops) stop?.(); };
  }, [lookup, refs]);
  if (!lookup || !refs.size) return undefined;
  if (answer?.lookup === lookup && answer.refs === refs) return answer.matches;
  const cached = new Map<string, ArtifactResolution>();
  for (const ref of refs) {
    const match = lookup.peek(ref);
    if (match === undefined) return undefined;
    cached.set(ref, match);
  }
  return cached;
}
