import { posix } from 'node:path';
import type { CompletionItem, Workspace } from '../shared/types';
import { quoteShell as q, validateWorkspace, type Transport } from './transport';
import { diagnostic } from '../diagnostics';

/** What the endpoint's artifact policy lets `@` completion list. */
export interface FileScope {
  locate(reference: string): { absolute: string; base: string; external: boolean; documents?: string; protectedRoots: string[]; privacyRoots?: string[] };
  /** Never listed or entered (credentials, keys, VCS metadata): `find -iname` globs. */
  secrets: string[];
  /** Listed but entered only when the user `@`s into them (dependency and build trees): literal names. */
  heavy: string[];
}

export interface FileIndexLimits {
  /** An older index is served once more while a rescan runs. */
  ttlMs: number;
  /** A query with no match rescans an index at least this old (files Claude just wrote). */
  missMs: number;
  /** Per scan: entries, path bytes and levels below the scanned folder. */
  maxEntries: number; maxBytes: number; maxDepth: number;
  /** A folder below the scanned one holding more entries is listed but not entered. */
  fanout: number;
  /** The endpoint walks for at least this long, at most a second more (its clock counts whole
   * seconds; 0: not at all); the transport gives up after timeoutMs. */
  scanSeconds: number; timeoutMs: number;
  /** Memory: indexes kept (LRU over workspace + folder) and their entries in total. */
  maxIndexes: number; maxCachedEntries: number;
  /** Scans running at once; the folder a user is waiting for goes first. */
  concurrency: number;
  now(): number;
}
const ttlOverride = Number(process.env.LECTERN_FILE_INDEX_TTL_MS);
export const fileIndexLimits: FileIndexLimits = {
  ttlMs: Number.isFinite(ttlOverride) && ttlOverride >= 100 ? ttlOverride : 5 * 60_000,
  missMs: 15_000, maxEntries: 40_000, maxBytes: 3 * 1024 * 1024, maxDepth: 12, fanout: 2_000,
  scanSeconds: 3, timeoutMs: 15_000, maxIndexes: 48, maxCachedEntries: 200_000, concurrency: 2, now: () => Date.now(),
};

interface DirIndex {
  key: string;
  /** Workspace-relative folder that was walked ('' is the working directory). */
  dir: string;
  /** Only direct children whose name contains this (a folder too large for one listing). */
  filter?: string;
  /** Entries relative to `dir`, their folded basenames, and which are folders. */
  paths: string[]; leaves: string[]; dirs: Set<string>;
  /** Folders (relative to `dir`, '' itself) whose every child is in `paths`. */
  listed: Set<string>;
  truncated: boolean;
  scannedAt: number;
  retryAt?: number;
}
const fold = (s: string) => s.normalize().toLowerCase();
const up = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

// A breadth-first walk, one `find` per batch of folders per level, so a huge folder
// costs one directory read and never starves the rest of the tree. Lines: f/d/D +
// "./path" (D: a folder that is entered), P + folder (more than `fanout` entries:
// its children are dropped), then E (finished) or T<n> (stopped by a limit; the
// first n queued folders, root first and then the D lines in order, were finished).
// A folder is printed twice by find; a file once. `srand()` returns the clock in seconds, so the
// deadline is one more whole second away: with `now() + limit`, a walk that started late in a
// second had little over limit - 1 seconds (about 2 of 3; a slow Mac took 1.4-1.9 s for the
// 120,000-file e2e tree and was cut now and then, its deeper folders never listed).
const walker = String.raw`function q(s) { gsub(/'/, "'\\''", s); return "'" s "'" }
function now() { srand(); return srand() }
function stop() { cut = 1; exit }
function tick() { if (++ticks % 256 == 0 && now() >= deadline) stop() }
function put(tag, p) {
  if (n >= maxn || bytes >= maxb) stop()
  tick(); print tag p; n++; bytes += length(p) + 2
  if (tag == "D") nextq[++nn] = p
}
function flush(   i) {
  if (bn > fan) print "P" parent
  else for (i = 1; i <= bn; i++) put(btag[i], bpath[i])
  bn = 0
}
function entry(p, isdir,   lp, leaf, above, tag) {
  lp = tolower(p)
  if (lp in hide) return
  if (want != "") { leaf = lp; sub(/.*\//, "", leaf); if (!index(leaf, want)) return }
  tag = "f"
  if (isdir) { leaf = lp; sub(/.*\//, "", leaf); tag = (depth < maxd && !(leaf in heavy) && !(lp in keep)) ? "D" : "d" }
  if (depth == 1) { put(tag, p); return }
  above = p; sub(/\/[^\/]*$/, "", above)
  if (above != parent) { flush(); parent = above }
  if (++bn <= fan) { btag[bn] = tag; bpath[bn] = p }
}
function load(name, set,   a, k) { split(ENVIRON[name], a, "\n"); for (k in a) if (a[k] != "") set[a[k]] = 1 }
BEGIN {
  split(ENVIRON["LECTERN_LIMITS"], v, " "); maxn = v[1] + 0; maxb = v[2] + 0; maxd = v[3] + 0; fan = v[4] + 0
  deadline = now() + v[5] + (v[5] + 0 > 0); prune = ENVIRON["LECTERN_PRUNE"]; want = ENVIRON["LECTERN_NAME"]
  load("LECTERN_HEAVY", heavy); load("LECTERN_KEEP", keep); load("LECTERN_HIDE", hide)
  nq = 1; queue[1] = "."
  for (depth = 1; nq > 0; depth++) {
    nn = 0
    for (i = 1; i <= nq; ) {
      if (now() >= deadline) stop()
      start = i; cmd = "find -P"; len = 0
      while (i <= nq && (i == start || len < 30000)) { cmd = cmd " " q(queue[i]); len += length(queue[i]) + 4; i++ }
      cmd = cmd " -mindepth 1 -maxdepth 1 " prune " -o -type d -print -print -o -type f -print 2>/dev/null"
      held = ""; bn = 0; parent = ""
      while ((cmd | getline line) > 0) {
        tick()
        if (held != "" && line == held) { entry(held, 1); held = "" }
        else { if (held != "") entry(held, 0); held = line }
      }
      close(cmd)
      if (held != "") entry(held, 0)
      flush(); done += i - start
    }
    split("", queue); for (j = 1; j <= nn; j++) queue[j] = nextq[j]
    split("", nextq); nq = nn
  }
}
END { print cut ? "T" done : "E" }`;

/** One self-bounded round trip that walks `parts` below the physical working directory. */
function scanScript(base: string, parts: string[], target: ReturnType<FileScope['locate']>, scope: FileScope, limits: FileIndexLimits, filter = '') {
  const below = (roots: string[]) => roots.map(root => posix.relative(target.absolute, root))
    .filter(path => path && path !== '..' && !path.startsWith('../') && !/[\x00-\x1f\x7f]/.test(path)).map(path => ('./' + path).toLowerCase());
  // Credentials and unmentionable names (Claude's quoted mention has no escape for ") are never listed.
  const prune = `\\( ${[...scope.secrets.map(glob => '-iname ' + q(glob)), "-name '*[[:cntrl:]]*'", `-name '*"*'`].join(' -o ')} \\) -prune`;
  const env = {
    LECTERN_LIMITS: [limits.maxEntries, limits.maxBytes, limits.maxDepth, limits.fanout, limits.scanSeconds].join(' '),
    LECTERN_PRUNE: prune, LECTERN_NAME: filter, LECTERN_HEAVY: scope.heavy.map(name => name.toLowerCase()).join('\n'),
    // Protected roots (Claude configuration) are hidden; macOS privacy folders are listed, never read.
    LECTERN_HIDE: below(target.protectedRoots).join('\n'), LECTERN_KEEP: below(target.privacyRoots ?? []).join('\n'),
  };
  const enter = (part: string, i: number) => `[ ! -L ${q('./' + part)} ] && cd -P ${q('./' + part)} && [ "$(pwd -P)" = ${q(posix.join(base, ...parts.slice(0, i + 1)))} ] || { echo E; exit 0; }\n`;
  return `set -f\nPATH=/usr/bin:/bin; export PATH; unset CDPATH; LC_ALL=C; export LC_ALL\n`
    + `cd -P ${q(base)} && [ "$(pwd -P)" = ${q(base)} ] || { echo E; exit 0; }\n` + parts.map(enter).join('')
    + Object.entries(env).map(([name, value]) => `${name}=${q(value)}`).join(' ') + ` awk ${q(walker)} </dev/null\n`;
}

/** Entries the endpoint printed, and which folders were listed in full. */
export function parseScan(text: string) {
  const paths: string[] = [], leaves: string[] = [], dirs = new Set<string>(), queued = [''], fat = new Set<string>();
  let finished = -1;
  for (const line of text.split('\n')) {
    if (line === 'E') { finished = Infinity; continue; }
    if (/^T\d{1,9}$/.test(line)) { finished = Number(line.slice(1)); continue; }
    if (!line.startsWith('./', 1) || line.length < 4) continue;
    const tag = line[0], path = line.slice(3);
    if (tag === 'P') { fat.add(path); continue; }
    if (tag !== 'f' && tag !== 'd' && tag !== 'D') continue;
    // Queue order must match the endpoint's even for names that cannot be offered.
    if (tag === 'D') queued.push(path);
    if (/[\x00-\x1f\x7f"�]/.test(path) || /(?:^|\/)\.{0,2}(?:\/|$)/.test(path)) continue;
    if (tag !== 'f') dirs.add(path);
    paths.push(path);
    leaves.push(fold(path.slice(path.lastIndexOf('/') + 1)));
  }
  const listed = new Set(queued.slice(0, Math.max(0, finished)).filter(path => !fat.has(path)));
  return { paths, leaves, dirs, listed, truncated: finished !== Infinity };
}

/** Stop waiting when the request is superseded; the shared scan itself keeps going. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason ?? new Error('Aborted'));
    signal.addEventListener('abort', stop, { once: true });
    promise.then(value => { signal.removeEventListener('abort', stop); resolve(value); },
      error => { signal.removeEventListener('abort', stop); reject(error); });
  });
}
interface Candidate { value: string; dir: boolean; score: number }
const collator = new Intl.Collator();
const order = (a: Candidate, b: Candidate) => a.score - b.score || Number(b.dir) - Number(a.dir) || collator.compare(a.value, b.value);
/** Keeps the best `limit` candidates in order without sorting every match. */
function keep(top: Candidate[], candidate: Candidate, limit: number) {
  if (top.length >= limit && order(candidate, top[limit - 1]) >= 0) return;
  let low = 0, high = top.length;
  while (low < high) { const mid = (low + high) >> 1; if (order(candidate, top[mid]) < 0) high = mid; else low = mid + 1; }
  top.splice(low, 0, candidate);
  if (top.length > limit) top.pop();
}
// Preserve the empty directory override slot used by existing indexes.
export const fileIndexWorkspaceKey = (ws: Workspace) => ws.id + '\n' + JSON.stringify([ws.kind, ws.host ?? '', ws.port ?? 0, ws.cwd, '']);
const failed = (ws: Workspace, error: unknown) => {
  const text = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  // Superseded by a newer name, or ended with the window: not a failure.
  if (text !== 'Superseded' && (error as Error | undefined)?.name !== 'AbortError') diagnostic.event('completion.index.failed', { workspaceId: ws.id, error: text }, 'warn');
};

/**
 * `@` completion from an in-memory index per workspace folder. Opening a conversation
 * indexes its working directory in the background; a folder that walk did not enter
 * (dependency trees, folders with too many entries, the depth or size limit) is
 * indexed on its own when the user `@`s into it. Expired indexes are still answered
 * from while one deduplicated rescan runs; listeners hear when a scan lands.
 */
export class FileIndex {
  readonly limits: FileIndexLimits;
  private readonly cache = new Map<string, DirIndex>();
  private readonly scans = new Map<string, Promise<DirIndex>>();
  private readonly scopes = new Map<string, { at: number; scope: Promise<FileScope> }>();
  private readonly listeners = new Set<(workspaceId: string) => void>();
  private readonly epochs = new Map<string, number>();
  private readonly waiting: { key: string; urgent: boolean; start(): void; drop(): void }[] = [];
  private running = 0;
  private entries = 0;
  private generation = 0;
  private abort = new AbortController();
  constructor(private readonly transport: Transport, private readonly scopeOf: (ws: Workspace) => Promise<FileScope>, limits: Partial<FileIndexLimits> = {}) {
    this.limits = { ...fileIndexLimits, ...limits };
  }
  subscribe(listener: (workspaceId: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  /** Forget a workspace (edited or removed), or everything; scans already running are not stored. */
  reset(workspaceId?: string) {
    const prefix = workspaceId === undefined ? '' : workspaceId + '\n';
    for (const map of [this.cache, this.scans, this.scopes] as Map<string, unknown>[])
      for (const key of [...map.keys()]) if (key.startsWith(prefix)) { if (map === this.cache) this.entries -= this.cache.get(key)!.paths.length; map.delete(key); }
    if (workspaceId !== undefined) { this.epochs.set(workspaceId, (this.epochs.get(workspaceId) ?? 0) + 1); return; }
    this.generation++;
    this.abort.abort();
    this.abort = new AbortController();
  }
  /** Index the working directory in the background, or refresh it once it has expired. */
  prefetch(ws: Workspace): void {
    validateWorkspace(ws);
    const wsKey = fileIndexWorkspaceKey(ws), index = this.cache.get(wsKey + '\0');
    if (index) { this.use(ws, wsKey, index); return; }
    this.scan(ws, wsKey, '', false).catch(error => failed(ws, error));
  }
  /** Only names leave the endpoint. Never dereference a candidate or let the renderer choose a scan root. */
  async query(ws: Workspace, prefix: string, signal: AbortSignal): Promise<CompletionItem[]> {
    validateWorkspace(ws);
    if (typeof prefix !== 'string' || prefix.length > 1024 || /[\x00-\x1f\x7f]/.test(prefix) || /^(?:\/|~(?:\/|$)|[a-z][\w+.-]*:)/i.test(prefix)) return [];
    const parts = prefix.replace(/^\.\//, '').split('/'), name = parts.pop()!;
    if (parts.some(p => !p || p === '.' || p === '..') || name === '..') return [];
    const wsKey = fileIndexWorkspaceKey(ws), scope = await abortable(this.scope(ws, wsKey), signal);
    let root, dir;
    try { root = scope.locate('.'); dir = scope.locate(parts.join('/') || '.'); } catch { return []; }
    if (root.external || dir.external || root.documents || dir.documents) return [];
    const found = await this.source(ws, wsKey, parts.join('/'), signal);
    if (!found) return [];
    const top: Candidate[] = [];
    this.collect(found.index, found.rel, name, top);
    // A folder with more entries than one scan lists: the endpoint also looks for this name,
    // unless the partial listing already fills the list with names that start with it.
    if (name && !found.index.listed.has(found.rel) && !(top.length >= 40 && top[39].score === 0)) {
      const narrow = this.narrowed(ws, wsKey, parts.join('/'), fold(name))
        ?? (top.length ? undefined : await abortable(this.scan(ws, wsKey, parts.join('/'), true, fold(name)), signal));
      if (narrow) this.collect(narrow, '', name, top);
    }
    const items = this.finish(top, scope);
    if (!items.length) this.missed(ws, wsKey, found.index);
    return items;
  }
  /** A cached name-filtered listing of `dir` (this name, or a complete one for a shorter prefix); else start one. */
  private narrowed(ws: Workspace, wsKey: string, dir: string, name: string): DirIndex | undefined {
    for (let length = name.length; length > 0; length--) {
      const hit = this.cache.get(`${wsKey}\0${dir}\0${name.slice(0, length)}`);
      if (hit && (length === name.length || !hit.truncated)) { this.use(ws, wsKey, hit); return hit; }
    }
    // Answer from the partial listing now; the open list asks again when this lands.
    this.scan(ws, wsKey, dir, true, name).catch(error => failed(ws, error));
  }
  /** The nearest cached index that lists `dir` in full, else a scan of `dir` itself. */
  private async source(ws: Workspace, wsKey: string, dir: string, signal: AbortSignal) {
    for (let at = dir; ; at = up(at)) {
      const index = this.cache.get(wsKey + '\0' + at);
      if (index) {
        const rel = at ? dir.slice(at.length + 1) : dir;
        if (!rel || index.listed.has(rel)) { this.use(ws, wsKey, index); return { index, rel }; }
        // Its parent was read in full and has no such folder: nothing to scan.
        if (index.listed.has(up(rel)) && !index.dirs.has(rel)) { this.use(ws, wsKey, index); this.missed(ws, wsKey, index); return; }
      }
      if (!at) break;
    }
    return { index: await abortable(this.scan(ws, wsKey, dir, true), signal), rel: '' };
  }
  private collect(index: DirIndex, rel: string, name: string, top: Candidate[]) {
    const base = rel ? rel + '/' : '', wanted = fold(name), prefix = index.dir ? index.dir + '/' : '';
    const { paths, leaves, dirs } = index;
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      if (base && !path.startsWith(base)) continue;
      // Direct children come first; deeper entries only match by name.
      const direct = path.indexOf('/', base.length) < 0, leaf = leaves[i];
      if (!direct && !wanted || wanted && !leaf.includes(wanted)) continue;
      keep(top, { value: prefix + path, dir: dirs.has(path), score: (leaf.startsWith(wanted) ? 0 : 2) + (direct ? 0 : 1) }, 64);
    }
  }
  private finish(top: Candidate[], scope: FileScope): CompletionItem[] {
    const items: CompletionItem[] = [], seen = new Set<string>();
    for (const { value, dir } of top) {
      if (value.length > 1024 || seen.has(value)) continue;
      seen.add(value);
      try { if (scope.locate(value).external) continue; } catch { continue; }
      items.push({ value, kind: dir ? 'directory' : 'file', source: 'workspace' });
      if (items.length >= 40) break;
    }
    return items;
  }
  /** Most recently used last; an expired index is rescanned in the background. */
  private use(ws: Workspace, wsKey: string, index: DirIndex) {
    if (this.cache.get(index.key) === index) { this.cache.delete(index.key); this.cache.set(index.key, index); }
    if (this.limits.now() - index.scannedAt >= this.limits.ttlMs) this.refresh(ws, wsKey, index);
  }
  /** Nothing matched: files may have appeared since an index that is not brand new. */
  private missed(ws: Workspace, wsKey: string, index: DirIndex) {
    if (this.limits.now() - index.scannedAt >= this.limits.missMs) this.refresh(ws, wsKey, index);
  }
  private refresh(ws: Workspace, wsKey: string, index: DirIndex) {
    if ((index.retryAt ?? 0) > this.limits.now()) return;
    this.scan(ws, wsKey, index.dir, false, index.filter).catch(error => {
      index.retryAt = this.limits.now() + Math.min(this.limits.ttlMs, 30_000);
      failed(ws, error);
    });
  }
  /** The endpoint's policy (physical folder, protected roots), cached like an index. */
  private scope(ws: Workspace, wsKey: string): Promise<FileScope> {
    const now = this.limits.now(), hit = this.scopes.get(wsKey);
    if (hit && now - hit.at < this.limits.ttlMs) return hit.scope;
    const scope = this.scopeOf(ws);
    this.scopes.set(wsKey, { at: now, scope });
    scope.catch(() => { if (this.scopes.get(wsKey)?.scope === scope) this.scopes.delete(wsKey); });
    while (this.scopes.size > 32) this.scopes.delete(this.scopes.keys().next().value!);
    return scope;
  }
  /** One scan per workspace folder at a time; concurrent callers share it. */
  private scan(ws: Workspace, wsKey: string, dir: string, urgent: boolean, filter?: string): Promise<DirIndex> {
    const key = wsKey + '\0' + dir + (filter ? '\0' + filter : ''), running = this.scans.get(key);
    if (running) {
      // A user is waiting: a queued background scan moves to the front and may use the reserve.
      const at = urgent ? this.waiting.findIndex(slot => slot.key === key) : -1;
      if (at >= 0) { const [slot] = this.waiting.splice(at, 1); slot.urgent = true; this.waiting.unshift(slot); this.next(); }
      return running;
    }
    // A newer name for the same crowded folder replaces one still waiting for a slot.
    if (filter) for (const slot of this.waiting.filter(slot => slot.key.startsWith(wsKey + '\0' + dir + '\0'))) slot.drop();
    const epoch = `${this.generation}:${this.epochs.get(ws.id) ?? 0}`;
    const task = this.slot(key, urgent).then(async release => {
      try { return await this.walk(ws, wsKey, key, dir, filter); } finally { release(); }
    }).then(index => {
      if (epoch === `${this.generation}:${this.epochs.get(ws.id) ?? 0}`) { this.store(key, index); this.emit(ws.id); }
      return index;
    });
    this.scans.set(key, task);
    const settle = () => { if (this.scans.get(key) === task) this.scans.delete(key); };
    task.then(settle, settle);
    return task;
  }
  private slot(key: string, urgent: boolean): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const start = () => {
        this.running++;
        let released = false;
        resolve(() => { if (released) return; released = true; this.running--; this.next(); });
      };
      const slot = { key, urgent, start, drop: () => { this.waiting.splice(this.waiting.indexOf(slot), 1); reject(new Error('Superseded')); } };
      if (this.running < this.capacity(urgent)) start();
      else if (urgent) this.waiting.unshift(slot);
      else this.waiting.push(slot);
    });
  }
  /** Two extra slots are kept for folders a user is waiting for. */
  private capacity(urgent: boolean) { return this.limits.concurrency + (urgent ? 2 : 0); }
  private next() {
    const slot = this.waiting[0];
    if (slot && this.running < this.capacity(slot.urgent)) { this.waiting.shift(); slot.start(); }
  }
  private async walk(ws: Workspace, wsKey: string, key: string, dir: string, filter?: string): Promise<DirIndex> {
    const scope = await this.scope(ws, wsKey), started = performance.now(), scannedAt = this.limits.now();
    const parts = dir ? dir.split('/') : [], root = scope.locate('.'), target = scope.locate(dir || '.');
    if (root.external || target.external || root.documents || target.documents)
      return { key, dir, filter, paths: [], leaves: [], dirs: new Set(), listed: new Set(['']), truncated: false, scannedAt };
    // A name-filtered listing reads one folder; the endpoint matches the longest ASCII run
    // byte for byte (folding differs there), the full name is matched here.
    const limits = filter ? { ...this.limits, maxDepth: 1, maxEntries: 2000 } : this.limits;
    const ascii = filter?.split(/[^\x20-\x7e]+/).reduce((a, b) => b.length > a.length ? b : a, '') ?? '';
    const { stdout } = await this.transport.run(ws, scanScript(root.base, parts, target, scope, limits, ascii), {
      tag: 'completion.index', timeoutMs: this.limits.timeoutMs, maxBytes: 2 * this.limits.maxBytes + 65536,
      // A local walk runs in its own process group, so a timeout or reset ends find too.
      // SSH keeps the warm command channel; the walk bounds itself on the target.
      signal: ws.kind === 'local' ? this.abort.signal : undefined,
    });
    const index: DirIndex = { key, dir, filter, ...parseScan(stdout.toString('utf8')), scannedAt };
    diagnostic.event('completion.index.scanned', { workspaceId: ws.id, depth: parts.length, entries: index.paths.length, listed: index.listed.size,
      truncated: index.truncated, bytes: stdout.length, durationMs: Math.round(performance.now() - started) }, 'debug');
    return index;
  }
  private store(key: string, index: DirIndex) {
    const old = this.cache.get(key);
    if (old) { this.entries -= old.paths.length; this.cache.delete(key); }
    this.cache.set(key, index);
    this.entries += index.paths.length;
    for (const [other, value] of this.cache) {
      if (this.cache.size <= this.limits.maxIndexes && this.entries <= this.limits.maxCachedEntries) break;
      if (other === key) continue;
      this.cache.delete(other);
      this.entries -= value.paths.length;
    }
  }
  private emit(workspaceId: string) {
    for (const listener of this.listeners) { try { listener(workspaceId); } catch { /* A closed window must not break the index. */ } }
  }
}
