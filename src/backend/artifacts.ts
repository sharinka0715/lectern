import { randomUUID } from 'node:crypto';
import { open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { finished } from 'node:stream/promises';
import type { ArtifactDirectory, ArtifactEntry, ArtifactPreview, ArtifactReference, ArtifactReferenceResult, ArtifactResolution, Workspace } from '../shared/types';
import { quoteShell as q, Transport, validateWorkspace } from './transport';
import { extractOfficeText } from './office-preview';
import { THUMB_BYTES, THUMB_INPUT_BYTES, ThumbnailCache, thumbnailPreview, thumbnailShell } from './image-thumbnail';
import { FileIndex, type FileIndexLimits, type FileScope } from './file-index';
import { artifactMediaType, AV_BYTES, avExtensions, avMediaType, isStaticSvg, LARGE_TEXT_BYTES, MEDIA_BYTES, mediaExtensions, officeExtensions, SNIFF_BYTES, TEXT_BYTES, TEXT_OPEN_BYTES } from './artifact-media';
import { localeTag, t } from '../shared/i18n';

const PAGE_SIZE = 250;
const MAX_WIRE_HEADER = 512;
const MAX_LIST_BYTES = 1024 * 1024;
const codeExtensions = new Set('.c .cc .cpp .cs .css .go .h .hpp .html .htm .java .js .jsx .json .jsonl .kt .lua .m .mjs .cjs .php .pl .ps1 .py .rb .rs .sh .bash .zsh .sql .swift .toml .ts .tsx .vue .xml .yaml .yml .svg .diff .patch .ini .conf .proto .scala .svelte .ipynb .cu .cuh .r .tex .less .scss .graphql .cmake .gradle .dart .ex .exs .hs .jl .nim .zig'.split(' '));
const asciiControl = /[\x00-\x1f\x7f]/;
// Match individual components. Name searches and `@` completion never walk into these (credentials,
// keys, VCS metadata, Claude configuration); an explicit path into one opens like any other.
const protectedNames = [
  '.claude', '.claude.json*', '.credentials*', '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.config', '.git',
  '.env', '.env.*', '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.password-store', 'keychains',
  'credentials', 'credentials.json', 'credentials.yml', 'credentials.yaml', 'application_default_credentials.json',
  'authorized_keys', 'known_hosts', 'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*', 'ssh_host_*_key*',
  '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keychain*',
];
const secretName = new RegExp('^(?:' + protectedNames.map(name => name.replaceAll('.', '\\.').replaceAll('*', '.*')).join('|') + ')$', 'i');

function homePath(path: string) {
  return path === '~' ? '"$HOME"' : path.startsWith('~/') ? '"$HOME"/' + q(path.slice(2)) : q(path);
}
function within(path: string, root: string) { return path === root || path.startsWith(root.replace(/\/$/, '') + '/'); }
function assertReference(path: string) {
  if (typeof path !== 'string' || !path || Buffer.byteLength(path) > 4096 || asciiControl.test(path)
    || /^[a-z][\w+.-]*:/i.test(path) || path.startsWith('//') || /^~[^/]/.test(path)) {
    throw new Error(t('artifacts.enterPath'));
  }
}
interface Target {
  base: string;
  absolute: string;
  path: string;
  /** Claude configuration and system trees: name searches and `@` completion skip them. */
  hiddenRoots: string[];
  /** In a hidden tree or under a protected name: opens on request, never searched or completed. */
  hidden: boolean;
  /** macOS privacy folders (Desktop, Documents, …) below the workspace. Explicit paths may
   * open them, but automatic name searches never walk in: each walk raises a system prompt. */
  privacyRoots: string[];
}
export type AuthorizeArtifact = (absolutePath: string) => Promise<void>;
type Request = 'preview' | 'thumbnail' | 'list' | 'metadata' | 'download' | 'range';
/** A byte window of a file: the `limit` bytes before `before`, the new bytes from `from`
 * (at most `appendLimit`, else the tail), or the tail. */
export interface FileWindowRequest { known?: string; from?: number; before?: number; limit: number; appendLimit?: number }
export type FileWindow = { path: string; stamp: string; identity: string; size: number } & (
  { unchanged: true } | { unchanged?: false; start: number; mode: 'tail' | 'from' | 'before'; bytes: Buffer });
/** A file in a macOS privacy folder, not read without the user's click (it raises a system prompt). */
export class PrivacyFolderError extends Error {}
const windowInt = (value: number | undefined) => value !== undefined && Number.isSafeInteger(value) && value >= 0 ? String(value) : '';

/** How a preview reads: the first `byteLimit` bytes (head), all of a file up to `byteLimit` else its
 * first SNIFF_BYTES (sniff), or all of it up to `byteLimit` else nothing (whole). */
type PreviewRead = 'head' | 'sniff' | 'whole';
function readScript(target: Target, request: Request, byteLimit: number, offset = 0, expectedStamp?: string, cachedStamp?: string, range?: FileWindowRequest,
  previewRead: PreviewRead = byteLimit <= TEXT_BYTES ? 'head' : 'whole') {
  const components = posix.relative(target.base, target.absolute).split('/').filter(Boolean);
  const directorySteps = components.slice(0, -1).map(part => 'enter ' + q(part)).join('\n');
  const leaf = components.at(-1) ?? '.';
  const previewBody = previewRead === 'head' ? `head -c ${byteLimit} <&3`
    : `if [ "$size" -le ${byteLimit} ]; then head -c ${byteLimit} <&3; ${previewRead === 'sniff' ? `else head -c ${SNIFF_BYTES} <&3; ` : ''}fi`;
  // The caller already holds the thumbnail for this stamp: send the header alone and decode nothing.
  const changed = cachedStamp ? `[ "$fd_stamp" != ${q(cachedStamp)} ] && ` : '';
  const thumbnailBody = `if ${changed}[ "$size" -gt 0 ] && [ "$size" -le ${THUMB_INPUT_BYTES} ]; then ${thumbnailShell} <&3; fi`;
  // A window of a file that may still be growing (a log a command writes to).
  const rangeBody = `if [ "$fd_stamp" = ${q(cachedStamp ?? '')} ]; then printf 'same\\0'; else
  lectern_from=${q(windowInt(range?.from))}; lectern_before=${q(windowInt(range?.before))}; lectern_limit=${byteLimit}; lectern_append=${windowInt(range?.appendLimit) || byteLimit}
  if [ -n "$lectern_before" ]; then mode=before; end=$lectern_before; [ "$end" -le "$size" ] || end=$size; start=$((end > lectern_limit ? end - lectern_limit : 0))
  elif [ -n "$lectern_from" ] && [ "$lectern_from" -le "$size" ] && [ $((size - lectern_from)) -le "$lectern_append" ]; then mode=from; start=$lectern_from; end=$size
  else mode=tail; end=$size; start=$((size > lectern_limit ? size - lectern_limit : 0)); fi
  printf '%s\\0%s\\0' "$start" "$mode"
  if [ "$end" -gt "$start" ]; then tail -c +$((start + 1)) <&3 | head -c $((end - start)); fi
fi`;
  const transfer = request === 'download' ? 'head -c "$size" <&3'
    : `printf 'file\\0%s\\0' "$fd_stamp"\n${request === 'preview' ? previewBody : request === 'thumbnail' ? thumbnailBody : request === 'range' ? rangeBody : ''}`;
  // cd pins each directory (links followed) and records where it landed. stat(path) is compared
  // with fstat(fd) before and after consuming the descriptor, so a file swapped mid-read is refused.
  const directoryBody = request === 'thumbnail' ? `die ${q(t('artifacts.notImage'))}` : request === 'range' ? `die ${q(t('artifacts.fileUnreadable'))}`
    : request === 'download' || request === 'metadata' ? `die ${q(t('artifacts.chooseFileToDownload'))}` : `
[ -r . ] && [ -x . ] || die ${q(t('artifacts.noFolderPermission'))}
printf 'directory\\0'
count=0
for item in ./.[!.]* ./..?* ./*; do
  if [ -d "$item" ]; then type=directory; elif [ -f "$item" ]; then type=file; else continue; fi
  name=\${item#./}
  case "$name" in (*[[:cntrl:]]*) continue;; esac
  count=$((count+1))
  [ "$count" -gt ${offset} ] || continue
  if [ "$count" -gt ${offset + PAGE_SIZE} ]; then printf 'more\\0'; break; fi
  printf '%s\\0%s\\0' "$type" "$name"
done
exit 0`;
  const fileBody = request === 'list' ? `die ${q(t('artifacts.notFolder'))}` : `
[ -f "$item" ] || die ${q(t('artifacts.fileUnreadable'))}
exec 3<"$item" || die ${q(t('artifacts.noFilePermission'))}
if fd_stamp=$(stat -f '%z:%d:%i:%p:%.9Fm,%.9Fc' <&3 2>/dev/null); then
  path_stamp() { stat -L -f '%z:%d:%i:%p:%.9Fm,%.9Fc' "$item"; }
  file_stamp() { stat -f '%z:%d:%i:%p:%.9Fm,%.9Fc' <&3; }
else
  path_stamp() { stat -Lc '%s:%d:%i:%f:%y,%z' "$item"; }
  file_stamp() { stat -Lc '%s:%d:%i:%f:%y,%z' /proc/self/fd/0 <&3; }
  fd_stamp=$(file_stamp) || die ${q(t('artifacts.cannotVerifyFile'))}
fi
check_file() {
  [ "$(pwd -P)" = "$expected_dir" ] && [ -f "$item" ] && [ "$(path_stamp)" = "$fd_stamp" ] && [ "$(file_stamp)" = "$fd_stamp" ] || die ${q(t('artifacts.fileChangedRetry'))}
}
${request === 'range' ? `# A growing file changes size and time while read: only its identity (device, inode) must hold.
identity() { cut -d: -f2,3; }
check_file() {
  [ "$(pwd -P)" = "$expected_dir" ] && [ -f "$item" ] && [ "$(path_stamp | identity)" = "$(printf '%s' "$fd_stamp" | identity)" ] && [ "$(file_stamp | identity)" = "$(printf '%s' "$fd_stamp" | identity)" ] || die ${q(t('artifacts.fileChangedRetry'))}
}` : ''}
check_file
${expectedStamp ? `[ "$fd_stamp" = ${q(expectedStamp)} ] || die ${q(t('artifacts.fileChangedReopen'))}` : ''}
size=\${fd_stamp%%:*}
case "$size" in (''|*[!0-9]*) die ${q(t('artifacts.cannotReadSize'))};; esac
${transfer}
check_file`;

  return `set -ef
export LC_ALL=C
die() { printf '%s\\n' "$1" >&2; exit 1; }
expected_dir=${q(target.base)}
cd -P "$expected_dir" && [ "$(pwd -P)" = "$expected_dir" ] || die ${q(t('artifacts.folderMoved'))}
enter() {
  [ -d "./$1" ] || die ${q(t('artifacts.pathMissing'))}
  cd -P "./$1" && expected_dir=$(pwd -P) || die ${q(t('artifacts.cannotOpenFolder'))}
}
${directorySteps}
item=${q('./' + leaf)}
if [ -d "$item" ]; then
  ${leaf === '.' ? '' : 'enter ' + q(leaf)}
  set +f
  ${directoryBody}
fi
${fileBody}`;
}

function decodeFile(bytes: Buffer) {
  const end = bytes.indexOf(0, 5);
  if (bytes.toString('ascii', 0, 5) !== 'file\0' || end < 6 || end > MAX_WIRE_HEADER) throw new Error(t('artifacts.fileResponseIncomplete'));
  const stamp = bytes.toString('ascii', 5, end);
  if (!/^\d+:\d+:\d+:[\da-f]+:[\d.: +\-]+,[\d.: +\-]+$/.test(stamp)) throw new Error(t('artifacts.invalidFileInfo'));
  const size = Number(stamp.split(':', 1)[0]);
  if (!Number.isSafeInteger(size)) throw new Error(t('artifacts.sizeOutOfRange'));
  return { stamp, size, content: bytes.subarray(end + 1) };
}
function readDirectory(path: string, bytes: Buffer, offset: number): ArtifactDirectory {
  const fields = bytes.toString('utf8').split('\0');
  if (fields.shift() !== 'directory' || fields.pop() !== '') throw new Error(t('artifacts.folderResponseIncomplete'));
  const truncated = fields.length % 2 === 1 && fields.at(-1) === 'more';
  if (truncated) fields.pop();
  const entries: ArtifactEntry[] = [];
  for (let i = 0; i < fields.length; i += 2) {
    const kind = fields[i], name = fields[i + 1];
    if ((kind !== 'directory' && kind !== 'file') || !name || name === '.' || name === '..' || name.includes('/') || asciiControl.test(name)) throw new Error(t('artifacts.invalidFolderEntry'));
    if (!name.includes('\ufffd')) entries.push({ kind, name, path: posix.join(path, name) });
  }
  entries.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1) || a.name.localeCompare(b.name, localeTag(), { numeric: true }));
  return { path, entries, truncated, ...(truncated ? { nextOffset: offset + PAGE_SIZE } : {}) };
}

// Only bare-name discovery omits dependency and build trees. An explicit path into
// one of these directories is still checked normally.
// Folders macOS guards with a per-app consent prompt (TCC), relative to the home directory.
const privacyFolders = ['Desktop', 'Documents', 'Downloads', 'Library', 'Pictures', 'Movies', 'Music', 'Public'];
const generatedDirectories = ['node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.next', '.nuxt', '.cache', 'coverage'];

/** Output trees a message may name ("build/out.mp4"): searched when the batch names them. Dependency and cache trees never are. */
const outputDirectories = new Set(['dist', 'build', 'target', 'coverage']);

// A bare name is not relative to the first directory containing it, and a relative
// path Claude wrote from a subfolder ("build/out.mp4") need not start at the root.
// Search once for the whole batch, without following links or exporting a
// directory index. An incomplete traversal cannot establish uniqueness, so the
// sentinel is required. Paths outside the folder are only checked, never searched.
function referenceScript(base: string, direct: Map<number, Target>, keys: Set<string>, hiddenRoots: string[], privacyRoots: string[] = [],
  external = new Map<number, Target>(), searched = new Set<string>(), exact = new Map<number, Target & { external: boolean }>()) {
  const literalGlob = (value: string) => value.replace(/[\\*?\[\]]/g, '\\$&');
  const pruned = generatedDirectories.filter(name => !searched.has(name));
  const generated = '\\( -type d \\( ' + pruned.map(name => '-name ' + q(name)).join(' -o ') + ' \\) \\)';
  const prune = [generated, '-name ' + q('*[[:cntrl:]]*'), ...protectedNames.map(pattern => '-iname ' + q(pattern)),
    ...[...hiddenRoots, ...privacyRoots].filter(root => within(root.toLowerCase(), base.toLowerCase()) && root.toLowerCase() !== base.toLowerCase()).map(root =>
      '-ipath ' + q(literalGlob('./' + root.slice(base.replace(/\/$/, '').length + 1))))].join(' -o ');
  const wanted = [...keys].map(key => key.includes('/') ? '-path ' + q('*/' + literalGlob(key)) : '-name ' + q(literalGlob(key))).join(' -o ');
  const inside = (tag: string, target: Target) => `if probe ${q(target.path === '.' ? '.' : './' + target.path)}; then printf '${tag}\\n'; fi`;
  const outside = (tag: string, target: Target) => `if (cd / && probe ${q('.' + target.absolute)}); then printf '${tag}\\n'; fi`;
  return `set -f
export LC_ALL=C
base=${q(base)}
cd -P "$base" && [ "$(pwd -P)" = "$base" ] || exit 1
probe() (
  rest=\${1#./}
  while [ "\${rest#*/}" != "$rest" ]; do
    part=\${rest%%/*}; rest=\${rest#*/}
    cd -P "./$part" 2>/dev/null || exit 1
  done
  item=./$rest
  [ -r "$item" ] && { { [ -d "$item" ] && [ -x "$item" ]; } || [ -f "$item" ]; }
)
${[...direct].map(([i, target]) => inside(`d${i}`, target)).join('\n')}
${[...external].map(([i, target]) => outside(`e${i}`, target)).join('\n')}
${[...exact].map(([i, target]) => (target.external ? outside : inside)(`c${i}`, target)).join('\n')}
${wanted ? `{ if find -P . \\( ${prune} \\) -prune -o \\( ${wanted} \\) \\( -type f -o -type d \\) -exec sh -c '
  for p do [ -r "$p" ] && { [ ! -d "$p" ] || [ -x "$p" ]; } && printf "%s\\n" "$p"; done; :
' sh {} + 2>/dev/null; then printf 'complete\\n'; fi; } |
LECTERN_REF_KEYS=${q([...keys].join('\n'))} awk 'BEGIN { n = split(ENVIRON["LECTERN_REF_KEYS"], keys, "\\n") }
$0 == "complete" { complete=1; next }
{ path=$0; name=path; sub(/^.*\\//,"",name)
  for (i = 1; i <= n; i++) { key=keys[i]
    hit = index(key, "/") ? (length(path) > length(key) && substr(path, length(path) - length(key)) == "/" key) : (name == key)
    if (hit) { if (key in seen) seen[key]=""; else seen[key]=path } } }
END { if (complete) { print "!"; for (key in seen) { print "?" key; if (seen[key] != "") print "=" key "\\t" seen[key] } } }' |
while IFS= read -r item; do case "$item" in (=*) probe "\${item#*\t}" || continue;; esac; printf '%s\\n' "$item"; done` : ':'}`;
}

export class WorkspaceArtifacts {
  private readonly thumbnails = new ThumbnailCache();
  /** `@` completion's cached file index, under the same policy as artifact reads. */
  readonly fileIndex: FileIndex;
  constructor(private readonly transport: Transport, fileLimits: Partial<FileIndexLimits> = {}) {
    this.fileIndex = new FileIndex(transport, async (workspace): Promise<FileScope> => ({
      locate: await this.locator(workspace, []), secrets: protectedNames, heavy: [...generatedDirectories, 'vendor', '.tox', '.pnpm-store'],
    }), fileLimits);
  }

  private async locator(workspace: Workspace, references: string[], signal?: AbortSignal) {
    validateWorkspace(workspace);
    const config = '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}"';
    // macOS exposes /tmp, /var and /etc as fixed aliases. Verify them on the target host.
    const aliases = ['tmp', 'var', 'etc'].filter(alias => references.some(path => within(path, '/' + alias)));
    const script = `set -e
cd ${homePath(workspace.cwd)}
config=${config}
physical_dir() { (cd -P "$1" 2>/dev/null && pwd -P) || true; }
printf '%s\\0' "$(pwd -L)" "$(pwd -P)" "$HOME" "$config" "$(physical_dir "$config")" "$(physical_dir "$HOME/.claude")" "$(physical_dir "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}")"
${aliases.map(alias => `if [ "$(uname -s)" = Darwin ] && [ -L /${alias} ] && [ "$(physical_dir /${alias})" = /private/${alias} ]; then printf '%s\\0' /${alias}; fi`).join('\n')}`;
    const result = await this.transport.run(workspace, script, { tag: 'artifact.workspace', maxBytes: 32768, signal });
    const [logical, physical, home, configured, configReal, defaultConfig, envConfig, ...systemAliases] = result.stdout.toString('utf8').split('\0');
    if (![logical, physical, home].every(value => value?.startsWith('/') && !asciiControl.test(value))) throw new Error(t('artifacts.cannotResolveFolder'));
    const configs = [...new Set([configured, configReal, defaultConfig, envConfig, posix.join(home, '.claude'), posix.join(physical, '.claude')]
      .filter(root => root?.startsWith('/')).map(root => posix.resolve(root)))];
    const systemRoots = ['/dev', '/proc', '/sys'];
    const hiddenRoots = [...configs, ...systemRoots];
    const privacyRoots = workspace.kind === 'local' && process.platform === 'darwin'
      ? [...privacyFolders.map(name => posix.join(home, name)), '/Volumes'] : [];
    return (reference: string): Target & { external: boolean } => {
      assertReference(reference);
      const expanded = reference === '~' ? home : reference.startsWith('~/') ? posix.join(home, reference.slice(2)) : reference;
      const input = posix.resolve(logical, expanded);
      const absolute = within(input, logical) ? posix.resolve(physical, posix.relative(logical, input))
        : systemAliases.some(alias => alias && within(input, alias)) ? '/private' + input : input;
      // Any path opens when asked for by name. Hidden ones (configuration, credentials, system
      // trees) are only kept out of name searches and `@` completion.
      const hidden = absolute.split('/').some(name => secretName.test(name))
        || hiddenRoots.some(root => within(absolute.toLowerCase(), root.toLowerCase()));
      const external = !within(absolute, physical);
      return { absolute, hiddenRoots, hidden, privacyRoots, external, base: external ? '/' : physical, path: external ? absolute : posix.relative(physical, absolute) || '.' };
    };
  }

  complete(workspace: Workspace, prefix: string, signal: AbortSignal) {
    return this.fileIndex.query(workspace, prefix, signal);
  }

  private async target(workspace: Workspace, reference: string, authorize?: AuthorizeArtifact): Promise<Target> {
    assertReference(reference);
    const target = (await this.locator(workspace, [reference]))(reference);
    if (target.external) {
      if (!authorize) throw new Error(t('artifacts.outsideNeedsPermission'));
      await authorize(target.absolute);
    }
    return target;
  }

  /** A relative reference with a `cwd` (the directory Claude Code was in when it wrote it) is first
   * checked there, never searched for there. Not found there, the folder's own rules below apply when
   * that directory is in the folder and the path does not climb out of it (`../`). */
  async resolveReferences(workspace: Workspace, references: ArtifactReference[]): Promise<ArtifactReferenceResult[]> {
    const valid = (ref: ArtifactReference) => typeof ref === 'string' || typeof ref === 'object' && ref !== null && typeof ref.path === 'string' && typeof ref.cwd === 'string';
    if (!Array.isArray(references) || references.length > 32 || !references.every(valid) ||
      references.reduce((n, ref) => n + (typeof ref === 'string' ? Buffer.byteLength(ref) : Buffer.byteLength(ref.path) + Buffer.byteLength(ref.cwd)), 0) > 16384) throw new Error(t('artifacts.batchTooLarge'));
    if (!references.length) return [];
    const paths = references.map(ref => typeof ref === 'string' ? ref : ref.path);
    const anchored = references.map((ref, i) => {
      if (typeof ref === 'string' || !ref.cwd.startsWith('/') || asciiControl.test(ref.cwd) || /^[~/]/.test(paths[i])) return undefined;
      try { assertReference(paths[i]); } catch { return undefined; }
      return { cwd: ref.cwd, path: posix.join(ref.cwd, paths[i]) };
    });
    const locate = await this.locator(workspace, [...paths, ...anchored.flatMap(item => item ? [item.cwd, item.path] : [])]);
    const inFolder = (path: string) => { try { return !locate(path).external; } catch { return false; } };
    const matches: ArtifactResolution[] = references.map(() => null);
    const direct = new Map<number, Target>(), external = new Map<number, Target>(), searchKeys = new Map<number, string>();
    const exact = new Map<number, ReturnType<typeof locate>>(), exactFound = new Set<number>();
    let root: Target | undefined;
    try { root = locate('.'); } catch { /* Exact paths still resolve. */ }
    for (const [i, ref] of paths.entries()) {
      const fromCwd = anchored[i];
      if (fromCwd) {
        let target: ReturnType<typeof locate>;
        try { target = locate(fromCwd.path); } catch { continue; }
        if (target.external && target.privacyRoots.some(folder => within(target.absolute, folder))) { matches[i] = 'outside'; continue; }
        exact.set(i, target);
        if (!inFolder(fromCwd.cwd) || /^\.\.(?:\/|$)/.test(posix.normalize(ref))) continue;
      }
      let target: ReturnType<typeof locate>;
      try { target = locate(ref); } catch { continue; }
      if (target.external) {
        // Checked like the folder's own files, except where each look raises a macOS privacy prompt.
        if (target.privacyRoots.some(folder => within(target.absolute, folder))) matches[i] = 'outside';
        else external.set(i, target);
        continue;
      }
      // A bare name is searched for, except names searches skip (.env, keys): those only at the root.
      if (root && ref !== '.' && !ref.includes('/') && ref !== '~' && !secretName.test(ref)) { searchKeys.set(i, ref); continue; }
      direct.set(i, target);
      // A relative path written from a subfolder: found below the root when it is not at the root.
      const relative = ref.replace(/^\.\//, '');
      if (root && !/^[~/]/.test(ref) && relative.includes('/') && posix.normalize(relative) === relative) {
        searchKeys.set(i, relative);
      }
    }
    const keys = new Set(searchKeys.values());
    if (!direct.size && !keys.size && !external.size && !exact.size) return matches;
    const base = root?.absolute ?? [...direct.values(), ...[...exact.values()].filter(target => !target.external)][0]?.base ?? '/';
    const searched = new Set(paths.flatMap(ref => ref.split('/')).filter(name => outputDirectories.has(name)));
    const result = await this.transport.run(workspace, referenceScript(base, direct, keys, root?.hiddenRoots ?? [], root?.privacyRoots ?? [], external, searched, exact), {
      tag: 'artifact.resolve', maxBytes: 160 * 1024, timeoutMs: 8000,
    });
    const found = new Map<string, string>(), seen = new Set<string>();
    let complete = false;
    for (const line of result.stdout.toString('utf8').split('\n')) {
      if (line === '!') complete = true;
      else if (line.startsWith('?')) seen.add(line.slice(1));
      else if (/^c\d+$/.test(line)) exactFound.add(Number(line.slice(1)));
      else if (/^[de]\d+$/.test(line)) {
        const i = Number(line.slice(1)), target = (line[0] === 'd' ? direct : external).get(i);
        if (target) matches[i] = { path: target.path };
      } else if (line.startsWith('=') && line.includes('\t') && !line.includes('�')) {
        const tab = line.indexOf('\t'), key = line.slice(1, tab), item = line.slice(tab + 1), path = item.slice(2);
        if (!keys.has(key) || !item.startsWith('./') || posix.normalize(path) !== path) continue;
        if (key.includes('/') ? path !== key && !path.endsWith('/' + key) : posix.basename(path) !== key) continue;
        try {
          const target = locate(item);
          if (!target.external && target.path === path) found.set(key, path);
        } catch { /* Not a valid reference. */ }
      }
    }
    return matches.map((match, i) => {
      const hit = exactFound.has(i) && exact.get(i);
      if (hit) return { path: hit.path };
      // A shared batch can contain the same name from a cwd outside the workspace.
      const key = searchKeys.get(i);
      if (match || !key) return match;
      if (!complete) return undefined;
      const path = found.get(key);
      return path ? { path } : !paths[i].includes('/') && !seen.has(key) ? 'missing' : null;
    });
  }

  async list(workspace: Workspace, reference = '.', offset = 0, authorize?: AuthorizeArtifact): Promise<ArtifactDirectory> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > Number.MAX_SAFE_INTEGER - PAGE_SIZE) throw new Error(t('artifacts.invalidFolderPage'));
    const target = await this.target(workspace, reference, authorize);
    const result = await this.transport.run(workspace, readScript(target, 'list', 0, offset), { tag: 'artifact.list', maxBytes: MAX_LIST_BYTES });
    return readDirectory(target.path, result.stdout, offset);
  }

  /** `whole`: the user chose to open a text file over TEXT_OPEN_BYTES (returned `large`, unread); read up to LARGE_TEXT_BYTES. */
  async preview(workspace: Workspace, reference: string, authorize?: AuthorizeArtifact, whole = false): Promise<ArtifactPreview> {
    const target = await this.target(workspace, reference, authorize);
    const { path } = target, name = posix.basename(target.absolute) || '/';
    const ext = posix.extname(name).toLowerCase();
    const office = officeExtensions.has(ext), av = avExtensions.has(ext), textual = !office && !av && !mediaExtensions.has(ext);
    const limit = av ? AV_BYTES : !textual ? MEDIA_BYTES : whole ? LARGE_TEXT_BYTES : TEXT_OPEN_BYTES;
    const read = (max: number, mode: PreviewRead, stamp?: string) => this.transport.run(workspace, readScript(target, 'preview', max, 0, stamp, undefined, undefined, mode), {
      tag: 'artifact.preview', maxBytes: Math.max(MAX_LIST_BYTES, max + MAX_WIRE_HEADER), timeoutMs: max > MEDIA_BYTES ? 60_000 : undefined,
    });
    const { stdout } = await read(limit, !textual ? 'whole' : whole ? 'head' : 'sniff');
    if (stdout.toString('ascii', 0, 10) === 'directory\0') {
      return { ...readDirectory(path, stdout, 0), kind: 'directory', name, size: 0, mime: 'inode/directory' };
    }
    const { size, stamp, content } = decodeFile(stdout);
    // Media is read all or nothing: the script sends no bytes for a file over the limit. Text over
    // the open-at-once bound sends its head, enough to tell binary, media or text.
    const expected = !textual ? (size > limit ? 0 : size) : whole || size <= limit ? Math.min(size, limit) : Math.min(size, SNIFF_BYTES);
    if (content.length !== expected) throw new Error(t('artifacts.previewIncomplete'));
    const base = { path, name, size, truncated: false };
    const binary = (notice: string, truncated = false): ArtifactPreview => ({ ...base, kind: 'binary', mime: 'application/octet-stream', notice, truncated });
    const tooLarge = (bound: number) => binary(t('artifacts.tooLargeToPreview', { size: bound / 1024 / 1024 }), true);
    if (!expected && size) return tooLarge(limit);
    const mime = ext === '.svg' && content.length === size && isStaticSvg(content) ? 'image/svg+xml'
      : av ? avMediaType(content, ext) ?? artifactMediaType(content) : artifactMediaType(content) ?? avMediaType(content, ext);
    if (mime) {
      const playable = /^(?:audio|video)\//.test(mime), bound = playable ? AV_BYTES : MEDIA_BYTES;
      if (size > bound) return tooLarge(bound);
      const bytes = content.length === size ? content : decodeFile((await read(bound, 'whole', stamp)).stdout).content;
      if (bytes.length !== size) throw new Error(t('artifacts.previewIncomplete'));
      const kind = mime === 'application/pdf' ? 'pdf' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'image';
      return { ...base, kind, mime, data: new Uint8Array(bytes) };
    }
    if (office) {
      try {
        const document = await extractOfficeText(name, content);
        return { ...base, kind: 'document', mime: 'text/plain', notice: document.truncated ? t('artifacts.partialDocument') : t('artifacts.documentText'), ...document };
      } catch { return binary(t('artifacts.documentUnreadable')); }
    }
    if (mediaExtensions.has(ext) || av) return binary(t('artifacts.unknownMedia'));
    if (content.includes(0) || /[\x01-\x08\x0e-\x1f]/.test(content.toString('latin1'))) return binary(t('artifacts.downloadToView'));
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(content, { stream: content.length < size }); }
    catch { return binary(t('artifacts.notUtf8')); }
    const markdown = /^(?:\.md|\.markdown|\.mdown)$/i.test(ext);
    const code = codeExtensions.has(ext) || /^(?:dockerfile|makefile|cmakelists\.txt|\.gitignore)$/i.test(name);
    const kind = markdown ? 'markdown' : code ? 'code' : 'text', type = markdown ? 'text/markdown' : 'text/plain';
    // Too large to open at once: the user chooses to open (whole) or download it.
    if (!whole && size > limit) return { ...base, kind, mime: type, large: true, truncated: true };
    return { ...base, kind, mime: type, text, truncated: content.length < size };
  }

  /**
   * A small PNG encoded on the target (at most THUMB_EDGE px and THUMB_BYTES); the original never crosses the
   * connection. Results, failures included, are kept per machine and physical path while the file's stamp is
   * unchanged: the same command compares the stamp first and then sends only the header.
   * `attached`: a file the conversation attached by path, read even outside the folder (see attachedTarget).
   */
  async thumbnail(workspace: Workspace, reference: string, attached = false): Promise<ArtifactPreview> {
    const target = attached ? await this.attachedTarget(workspace, reference) : await this.target(workspace, reference);
    const key = JSON.stringify([workspace, target.absolute]), cached = this.thumbnails.get(key);
    const result = await this.transport.run(workspace, readScript(target, 'thumbnail', 0, 0, undefined, cached?.stamp), {
      tag: 'artifact.thumbnail', maxBytes: MAX_WIRE_HEADER + THUMB_BYTES, timeoutMs: 12_000,
    });
    const { size, stamp, content } = decodeFile(result.stdout);
    const preview = cached?.stamp === stamp ? cached.preview : thumbnailPreview(target.path, posix.basename(target.absolute), size, content);
    this.thumbnails.set(key, stamp, preview);
    return preview;
  }

  /** An attachment's path is the user's own choice, not a name from model output, so a thumbnail may read it
   * outside the folder without a grant, except in macOS privacy folders (Desktop, Downloads, …) that do not
   * contain the folder: reading one raises a system prompt. */
  private async attachedTarget(workspace: Workspace, reference: string, allowPrivacy = false): Promise<Target> {
    assertReference(reference);
    const locate = await this.locator(workspace, [reference]), target = locate(reference);
    let root: string | undefined;
    try { root = locate('.').absolute.toLowerCase(); } catch { /* No folder to compare with. */ }
    const inside = (path: string, folder: string) => within(path, folder.toLowerCase());
    if (!allowPrivacy && target.privacyRoots.some(folder => inside(target.absolute.toLowerCase(), folder) && !(root && inside(root, folder)))) {
      throw new PrivacyFolderError(t('artifacts.privacyFolderNotRead'));
    }
    return target;
  }

  /**
   * A byte window of a file a background command wrote its output to. The path comes from the
   * command in the transcript (parsed in the main process, never sent by the renderer), so it is
   * read like an attachment: outside the folder too, without grants, and a macOS privacy folder
   * only with `explicit` (the user asked to read it). The
   * window follows a growing file: `known` sends nothing when unchanged, `from` only new bytes.
   */
  async readWindow(workspace: Workspace, reference: string, window: FileWindowRequest, explicit = false): Promise<FileWindow> {
    const target = await this.attachedTarget(workspace, reference, explicit);
    const limit = Math.max(1, Math.min(8 * 1024 * 1024, Math.floor(window.limit)));
    const known = typeof window.known === 'string' && window.known.length < MAX_WIRE_HEADER ? window.known : undefined;
    const result = await this.transport.run(workspace, readScript(target, 'range', limit, 0, undefined, known, window), {
      tag: 'artifact.range', maxBytes: limit + 2 * MAX_WIRE_HEADER, timeoutMs: 20_000,
    });
    const { stamp, size, content } = decodeFile(result.stdout);
    const identity = stamp.split(':').slice(1, 3).join(':'), base = { path: target.absolute, stamp, identity, size };
    if (content.toString('ascii', 0, 5) === 'same\0') return { ...base, unchanged: true };
    const startEnd = content.indexOf(0), modeEnd = startEnd < 0 ? -1 : content.indexOf(0, startEnd + 1);
    const start = Number(content.toString('ascii', 0, startEnd)), mode = content.toString('ascii', startEnd + 1, modeEnd);
    if (modeEnd < 0 || !Number.isSafeInteger(start) || (mode !== 'tail' && mode !== 'from' && mode !== 'before')) throw new Error(t('artifacts.fileResponseIncomplete'));
    return { ...base, start, mode, bytes: content.subarray(modeEnd + 1) };
  }

  async prepareDownload(workspace: Workspace, reference: string, authorize?: AuthorizeArtifact) {
    const target = await this.target(workspace, reference, authorize);
    const result = await this.transport.run(workspace, readScript(target, 'metadata', 0), { tag: 'artifact.download_metadata', maxBytes: MAX_WIRE_HEADER });
    const { size, stamp } = decodeFile(result.stdout);
    return {
      name: posix.basename(target.absolute),
      saveTo: async (destination: string) => {
        // Keep the destination intact if SSH disconnects or the source changes.
        const temp = join(dirname(destination), '.lectern-download-' + randomUUID());
        const file = await open(temp, 'wx', 0o600);
        const output = file.createWriteStream();
        try {
          await this.transport.run(workspace, readScript(target, 'download', size, 0, stamp), { tag: 'artifact.download', maxBytes: size, timeoutMs: 60000, output });
          if ((await stat(temp)).size !== size) throw new Error(t('artifacts.downloadIncomplete'));
          await rename(temp, destination);
        } finally {
          output.destroy();
          await finished(output).catch(() => {});
          await file.close();
          await rm(temp, { force: true });
        }
      },
    };
  }
}
