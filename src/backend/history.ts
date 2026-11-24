import { joinList, t, type MessageKey } from '../shared/i18n';
import path from 'node:path';
import type { HistoryScan, HistoryTarget, Workspace } from '../shared/types';
import { diagnostic } from '../diagnostics';
import { quoteShell as q, Transport, validateWorkspace } from './transport';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface MetadataFrame { path: string; head: string; tail: string }
export interface HistoryScanLimits { maxFiles?: number; maxProjects?: number; expansionBytes?: number }
const DEFAULT_EXPANSION_BYTES = 16 * 1024 * 1024;

const missingCwdLabels = {
  empty: 'backend.reasonEmpty', queue: 'backend.reasonQueue', snapshot: 'backend.reasonSnapshot', title: 'backend.reasonTitle',
  name: 'backend.reasonName', cost: 'backend.reasonCost', metadata: 'backend.reasonMetadata', conversation: 'backend.reasonConversation',
  unrecognized: 'backend.reasonUnrecognized', partial: 'backend.reasonPartial',
} as const satisfies Record<string, MessageKey>;
export type MissingCwdReason = keyof typeof missingCwdLabels;
export function isMissingCwdReason(value: unknown): value is MissingCwdReason {
  return typeof value === 'string' && Object.hasOwn(missingCwdLabels, value);
}

const navigationRecords = new Set(['queue-operation', 'file-history-snapshot', 'custom-title', 'ai-title', 'summary',
  'last-prompt', 'permission-mode', 'mode', 'tag', 'agent-name', 'agent-color', 'agent-setting', 'session-owner']);

// 只给已经完整读取的文件定性。窗口截断的大文件可能在中间包含有效对话。
export function missingCwdReason(frame: MetadataFrame, bytes: number): MissingCwdReason {
  if (bytes === 0) return 'empty';
  const text = [frame.head, frame.tail].find(section => Buffer.byteLength(section) === bytes && !section.includes('�'));
  if (text === undefined) return 'partial';
  const types = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { types.add(JSON.parse(line)?.type); } catch { return 'unrecognized'; }
  }
  if (!types.size) return 'unrecognized';
  if (types.has('user') || types.has('assistant')) return 'conversation';
  if (types.size === 1 && types.has('queue-operation')) return 'queue';
  if (types.size === 1 && types.has('file-history-snapshot')) return 'snapshot';
  if (types.size === 1 && types.has('cost-state')) return 'cost';
  if ([...types].every(t => ['ai-title', 'custom-title', 'agent-name', 'agent-color'].includes(t))) return 'name';
  if ([...types].every(t => ['ai-title', 'custom-title', 'summary'].includes(t))) return 'title';
  return [...types].every(t => navigationRecords.has(t)) ? 'metadata' : 'unrecognized';
}

// Files that hold no conversation are not worth a notice: they cannot belong
// to any folder's history in a way that matters, and nothing is lost.
const conversationless = new Set<MissingCwdReason>(['empty', 'queue', 'snapshot', 'title', 'name', 'cost', 'metadata']);
export function missingCwdNotice(files: { id: string; metadata: { cwd?: string; missingCwd?: MissingCwdReason; contentless?: boolean } }[]): string | undefined {
  const unknown = files.filter(file => !file.metadata.cwd && !file.metadata.contentless && !conversationless.has(file.metadata.missingCwd ?? 'partial'));
  if (!unknown.length) return;
  const examples = unknown.slice(0, 8).map(file => t('backend.example', { id: file.id.slice(0, 8), reason: t(missingCwdLabels[file.metadata.missingCwd ?? 'partial']) }));
  return t('backend.noJsonlCwd', { count: unknown.length, examples: joinList(examples), more: unknown.length > examples.length ? t('backend.examplesMore') : '' });
}

function validCwd(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value) && !value.includes('|~lectern~|');
}

// Read a completed top-level string property from a truncated JSON object prefix.
// Quoted/nested content is skipped, so tool inputs cannot masquerade as root cwd.
function prefixString(text: string, wanted: string): string | undefined {
  let at = 0;
  const ws = () => { while (/\s/.test(text[at] ?? '') && at < text.length) at++; };
  const string = (): string | undefined => {
    if (text[at] !== '"') return undefined;
    const start = at++;
    while (at < text.length) {
      if (text[at] === '\\') { at += 2; continue; }
      if (text[at++] === '"') { try { return JSON.parse(text.slice(start, at)); } catch { return undefined; } }
    }
    return undefined;
  };
  ws(); if (text[at++] !== '{') return undefined;
  while (at < text.length) {
    ws(); const key = string(); if (key === undefined) return undefined;
    ws(); if (text[at++] !== ':') return undefined; ws();
    if (key === wanted) return string();
    let depth = 0;
    const valueStart = at;
    while (at < text.length) {
      const char = text[at];
      if (char === '"') { if (string() === undefined) return undefined; continue; }
      if (char === '{' || char === '[') depth++;
      if (char === '}' || char === ']') { if (!depth) return undefined; depth--; }
      if (char === ',' && !depth) {
        try { JSON.parse(text.slice(valueStart, at)); } catch { return undefined; }
        at++; break;
      }
      at++;
    }
  }
  return undefined;
}

export function metadataFromPrefix(text: string): { cwd?: string; latestAt?: string } {
  let cwd: string | undefined, latestAt: string | undefined;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    let record: any;
    try { record = JSON.parse(line); } catch {
      if (index === lines.length - 1 && !text.endsWith('\n')) {
        const candidate = prefixString(line, 'cwd');
        if (!cwd && validCwd(candidate)) cwd = candidate;
      }
      continue;
    }
    if (!cwd && validCwd(record?.cwd)) cwd = record.cwd;
    if (typeof record?.timestamp === 'string' && Number.isFinite(Date.parse(record.timestamp))) {
      const timestamp = new Date(record.timestamp).toISOString();
      if (!latestAt || timestamp > latestAt) latestAt = timestamp;
    }
  }
  return { cwd, latestAt };
}

/** Claude Code's project folder name for a working directory (where it keeps that directory's conversations). */
export function projectSlug(cwd: string): string {
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
  if (slug.length <= 200) return slug;
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) hash = (Math.imul(hash, 31) + cwd.charCodeAt(i)) | 0;
  return slug.slice(0, 200) + '-' + Math.abs(hash).toString(36);
}

/** The directory a conversation started in, from a later working directory (a subdirectory after a
 * `cd`): the nearest one up the tree the file's project folder is named after. */
export function launchDirectory(file: string, cwd: string): string | undefined {
  const project = path.posix.basename(path.posix.dirname(file));
  for (let dir = cwd; ; dir = path.posix.dirname(dir)) {
    if (projectSlug(dir) === project || dir.replace(/[/.]/g, '-') === project) return dir;
    if (dir === '/') return undefined;
  }
}

export function historyMetadata(frame: MetadataFrame): { cwd?: string; latestAt?: string; cwdSource?: 'head' | 'tail' } {
  const head = metadataFromPrefix(frame.head), tail = metadataFromPrefix(frame.tail);
  // The end of a file is where Claude Code is now, maybe below where the conversation started.
  const tailCwd = tail.cwd && (launchDirectory(frame.path, tail.cwd) ?? tail.cwd);
  return { cwd: head.cwd ?? tailCwd, cwdSource: head.cwd ? 'head' : tailCwd ? 'tail' : undefined, latestAt: [head.latestAt, tail.latestAt].filter(Boolean).sort().at(-1) };
}

/** Larger snapshot/queue records can precede the first cwd. Expand only those
 * prefixes, with a shared byte budget, before considering a later tail cwd. */
export async function expandHistoryHeads(transport: Transport, workspace: Workspace, frames: MetadataFrame[], budget = DEFAULT_EXPANSION_BYTES): Promise<{ limited: boolean; expandedFiles: number }> {
  let remaining = Math.max(0, budget), expandedFiles = 0, limited = false;
  const complete = new Set(frames.filter(frame => Buffer.byteLength(frame.head) < 8192));
  for (const bytes of [256 * 1024, 1024 * 1024]) {
    const missing = frames.filter(frame => !complete.has(frame) && !metadataFromPrefix(frame.head).cwd);
    const allowed = Math.min(missing.length, Math.floor(remaining / bytes));
    if (allowed < missing.length) limited = true;
    for (let index = 0; index < allowed; index++) {
      const frame = missing[index];
      remaining -= bytes;
      const script = `if [ -f ${q(frame.path)} ] && [ ! -L ${q(frame.path)} ]; then head -c ${bytes} ${q(frame.path)}; fi`;
      const result = await transport.run(workspace, script, { tag: 'history.metadata_prefix', maxBytes: bytes + 1, timeoutMs: 15_000 });
      if (result.stdout.length) frame.head = result.stdout.toString('utf8');
      if (result.stdout.length < bytes) complete.add(frame);
      expandedFiles++;
    }
    if (!allowed || !remaining) break;
  }
  return { limited, expandedFiles };
}

export async function scanHistoryProjects(target: HistoryTarget, transport: Transport, limits: HistoryScanLimits = {}): Promise<HistoryScan> {
  if (!target || typeof target !== 'object') throw new Error('Invalid history target');
  const { kind, host, port } = target;
  const workspace = validateWorkspace({ id: 'history-discovery', name: 'History discovery', cwd: '~', kind, host, port });
  const maxFiles = Math.max(1, Math.min(2000, Math.floor(Number.isFinite(limits.maxFiles) ? limits.maxFiles! : 2000)));
  const maxProjects = Math.max(1, Math.min(1000, Math.floor(Number.isFinite(limits.maxProjects) ? limits.maxProjects! : 1000)));
  const configExpression = '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}"';
  const script = `config=${configExpression}
printf '%s\\0' "$config"
files=0; dirs=0; skipped=0; skipped_dirs=0; truncated=0
if [ -L "$config/projects" ]; then skipped_dirs=1
else
 for d in "$config/projects"/*; do
  if [ -L "$d" ]; then skipped_dirs=$((skipped_dirs + 1)); continue; fi
  [ -d "$d" ] || continue
  dirs=$((dirs + 1)); if [ "$dirs" -gt ${maxProjects} ]; then truncated=1; break; fi
  for f in "$d"/*.jsonl; do
   [ -e "$f" ] || [ -L "$f" ] || continue
   if [ "$files" -ge ${maxFiles} ]; then truncated=1; break 2; fi
   files=$((files + 1))
   if [ -L "$f" ] || [ ! -f "$f" ]; then skipped=$((skipped + 1)); continue; fi
   id=\${f##*/}; id=\${id%.jsonl}
   case "$id" in (????????-????-????-????-????????????) case "$id" in (*[!0123456789abcdefABCDEF-]*) skipped=$((skipped + 1)); continue;; esac;; (*) skipped=$((skipped + 1)); continue;; esac
   printf '%s\\0' "$f"; head -c 8192 "$f" | base64; printf '\\0'; tail -c 16384 "$f" | base64; printf '\\0'
  done
 done
fi
printf 'END\\0%s %s %s %s\\0' "$files" "$skipped" "$truncated" "$skipped_dirs"`;
  const scan = await transport.run(workspace, script, { tag: 'history.projects_scan', maxBytes: maxFiles * (Math.ceil((8192 + 16384) * 1.4) + 4096 + 3) + 16384, timeoutMs: 30_000 });
  const sections = scan.stdout.toString('utf8').split('\0'), resolvedConfig = sections.shift()!;
  if (!validCwd(resolvedConfig)) throw new Error('History configuration directory must resolve to an absolute POSIX path');
  const frames: MetadataFrame[] = [];
  let footer: string[] | undefined;
  for (let index = 0; index < sections.length; index += 3) {
    if (sections[index] === 'END') { footer = sections[index + 1]?.split(' '); break; }
    const file = sections[index];
    if (!file || sections[index + 1] === undefined || sections[index + 2] === undefined) throw new Error('Incomplete history discovery response');
    frames.push({ path: file, head: Buffer.from(sections[index + 1], 'base64').toString('utf8'), tail: Buffer.from(sections[index + 2], 'base64').toString('utf8') });
  }
  if (!footer || footer.length !== 4 || footer.some(value => !/^\d+$/.test(value))) throw new Error('Invalid history discovery response');
  const [scannedFiles, initiallySkipped, limited, skippedDirs] = footer.map(Number);
  const expansion = await expandHistoryHeads(transport, workspace, frames, limits.expansionBytes);
  let skippedFiles = initiallySkipped, tailOnly = 0;
  const grouped = new Map<string, { cwd: string; sessionCount: number; latestAt?: string; exists: boolean }>();
  for (const frame of frames) {
    if (!UUID.test(path.posix.basename(frame.path, '.jsonl'))) { skippedFiles++; continue; }
    const metadata = historyMetadata(frame);
    if (!metadata.cwd) { skippedFiles++; continue; }
    if (metadata.cwdSource === 'tail') tailOnly++;
    const project = grouped.get(metadata.cwd) ?? { cwd: metadata.cwd, sessionCount: 0, exists: false };
    project.sessionCount++;
    if (metadata.latestAt && (!project.latestAt || metadata.latestAt > project.latestAt)) project.latestAt = metadata.latestAt;
    grouped.set(project.cwd, project);
  }
  // Bound command argv size even when candidate paths contain many quote escapes.
  const projects = [...grouped.values()];
  for (let index = 0; index < projects.length;) {
    const batch: typeof projects = [];
    let check = '';
    do {
      const project = projects[index], command = `if [ -d ${q(project.cwd)} ]; then printf '1\\0'; else printf '0\\0'; fi\n`;
      if (batch.length && Buffer.byteLength(check + command) > 32768) break;
      check += command; batch.push(project); index++;
    } while (index < projects.length);
    const existence = (await transport.run(workspace, check, { tag: 'history.project_exists', maxBytes: batch.length * 2 + 1 })).stdout.toString().split('\0');
    if (batch.some((_, at) => !['0', '1'].includes(existence[at]))) throw new Error('Invalid project existence response');
    batch.forEach((project, at) => { project.exists = existence[at] === '1'; });
  }
  projects.sort((a, b) => (b.latestAt ?? '').localeCompare(a.latestAt ?? '') || a.cwd.localeCompare(b.cwd));
  const notices: string[] = [];
  if (limited || expansion.limited) notices.push(t('backend.scanLimited', { files: maxFiles, projects: maxProjects }));
  if (skippedFiles) notices.push(t('backend.skippedFiles', { count: skippedFiles }));
  if (skippedDirs) notices.push(t('backend.skippedDirs', { count: skippedDirs }));
  if (tailOnly) notices.push(t('backend.tailOnly', { count: tailOnly }));
  const result: HistoryScan = { projects, scannedFiles, skippedFiles, truncated: !!limited || expansion.limited, claudeDir: resolvedConfig, diagnostic: notices.join(' ') || undefined };
  diagnostic.event('backend.history_projects.result', { kind, host, claudeDir: resolvedConfig, scannedFiles, skippedFiles, projectCount: projects.length, missingDirectories: projects.filter(p => !p.exists).length, expandedPrefixes: expansion.expandedFiles, truncated: result.truncated });
  return result;
}
