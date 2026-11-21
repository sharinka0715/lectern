import { posix } from 'node:path';
import type { CompletionItem, Workspace } from '../shared/types';
import { quoteShell as q, type Transport } from './transport';
import { metadataReader } from './completion-metadata';
import { t } from '../shared/i18n';

const pathExpr = (s: string) => s === '~' ? '"$HOME"' : s.startsWith('~/') ? '"$HOME"/' + q(s.slice(2)) : q(s);
const validName = (v: string) => v.length <= 200 && /^[\p{L}\p{N}_.:-][\p{L}\p{M}\p{N}_.:-]*$/u.test(v);
const absolute = (v: unknown): v is string => typeof v === 'string' && v.startsWith('/') && v.length < 4096 && !/[\x00-\x1f\x7f�]/.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function json(encoded: string): Record<string, unknown> {
  try { const j: unknown = JSON.parse(Buffer.from(encoded, 'base64').toString()); return object(j) ? j : {}; } catch { return {}; }
}
const reader = async (transport: Transport, workspace: Workspace, script: string, signal: AbortSignal) => {
  const { stdout } = await transport.run(workspace, `PATH=/usr/bin:/bin; export PATH; unset CDPATH;\n${script}`, { signal, tag: 'completion.catalog', timeoutMs: 9000, maxBytes: 4 * 1024 * 1024 });
  const fields = stdout.toString().split('\0');
  if (fields.pop() !== '' || fields.length % 3 !== 0) throw new Error(t('backend.catalogIncomplete'));
  const records: string[][] = [];
  for (let i = 0; i < fields.length; i += 3) records.push(fields.slice(i, i + 3));
  return records;
};
interface Root { path: string; id: string; manifest?: Record<string, unknown> }
const paths = (v: unknown) => (Array.isArray(v) ? v : [v]).filter((p): p is string => typeof p === 'string' && (p === '.' || p.startsWith('./')) && !p.split('/').includes('..') && !/[\x00-\x1f\x7f\\]/.test(p)).slice(0, 32);

/** Read installation metadata on the same endpoint as Claude. No shell profiles, skill bodies,
 * hook evaluation, plugin loading, user executables, CLI invocation or marketplace fetches. */
export async function readCommandCatalog(transport: Transport, workspace: Workspace, signal: AbortSignal, isolated = false): Promise<CompletionItem[]> {
  const config = workspace.claudeDir ? pathExpr(workspace.claudeDir) : '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}"';
  const metadata = await reader(transport, workspace, `${metadataReader}
cd -P ${pathExpr(workspace.cwd)} || exit 1
cwd=$(pwd -P); config=${config}; plugins=${isolated ? '"$config/plugins"' : '"${CLAUDE_CODE_PLUGIN_CACHE_DIR:-$config/plugins}"'}
printf 'cwd\\0_\\0%s\\0profile\\0_\\0%s\\0' "$cwd" "$config"
record_json settings _ "$config/settings.json"
record_json installed _ "$plugins/installed_plugins.json"
# Only ascend inside this repository. Workspaces without a repository stay at their own cwd.
root="$cwd"; p="$cwd"
while [ "$p" != / ]; do if [ -e "$p/.git" ]; then root="$p"; break; fi; p=\${p%/*}; p=\${p:-/}; done
p="$cwd"; while :; do
 if [ -d "$p/.claude" ] && [ ! -L "$p/.claude" ]; then printf 'project\\0_\\0%s\\0' "$p/.claude"; fi
 [ "$p" != "$root" ] || break; p=\${p%/*}; p=\${p:-/}
done
for p in "$config" "$cwd/.claude"; do
 [ ! -L "$p" ] && [ ! -L "$p/skills" ] || continue
 for d in "$p"/skills/*; do
  [ -d "$d" ] && [ ! -L "$d" ] && [ ! -L "$d/.claude-plugin" ] && [ -f "$d/.claude-plugin/plugin.json" ] || continue
  printf 'localplugin\\0%s@skills-dir\\0%s\\0' "\${d##*/}" "$d"
 done
done
for p in "$root" "$cwd"; do
 [ ! -L "$p/.claude" ] || continue
 record_json settings _ "$p/.claude/settings.json"; record_json settings _ "$p/.claude/settings.local.json"
 [ "$root" != "$cwd" ] || break
done
# Never index marketplace checkouts as if every advertised plugin were installed.
# Use layout evidence only for old/no-registry installs (or explicitly enabled cache entries).
for p in "$plugins"/cache/*/*/* "$plugins"/cache/* "$plugins"/synced/*; do
 [ -d "$p" ] && [ ! -f "$p/.orphaned_at" ] && { [ -d "$p/skills" ] || [ -d "$p/commands" ] || [ -f "$p/.claude-plugin/plugin.json" ]; } || continue
 case "$p" in "$plugins"/cache/*/*/*) parent=\${p%/*}; name=\${parent##*/}; market=\${parent%/*}; id="$name@\${market##*/}";; "$plugins"/synced/*) id="\${p##*/}@synced";; *) id=\${p##*/};; esac
 printf 'cache\\0%s\\0%s\\0' "$id" "$p"
done` , signal);
  const cwd = metadata.find(([t]) => t === 'cwd')?.[2];
  const configPath = metadata.find(([t]) => t === 'profile')?.[2];
  if (!absolute(cwd) || !absolute(configPath)) throw new Error(t('backend.cannotLocateDirs'));
  const settings = new Map<string, boolean>();
  const plugins = new Map<string, Root>();
  const registry = metadata.find(([t]) => t === 'installed');
  for (const [type, , encoded] of metadata) if (type === 'settings') {
    const value = json(encoded).enabledPlugins;
    if (object(value)) for (const [k, v] of Object.entries(value)) if (typeof v === 'boolean') settings.set(k, v);
  }
  const installs = registry && json(registry[2]).plugins;
  if (object(installs)) for (const [id, entries] of Object.entries(installs)) {
    const matches = (Array.isArray(entries) ? entries : [entries]).filter(object).filter(e =>
      !e.scope || e.scope === 'user' || e.scope === 'managed' || ['project','local'].includes(String(e.scope)) && absolute(e.projectPath) && (cwd === e.projectPath || cwd.startsWith(e.projectPath + '/')));
    const path = matches.find(e => absolute(e.installPath))?.installPath;
    if (absolute(path) && settings.get(id) !== false) plugins.set(id, { path, id });
  }
  for (const [type, id, path] of metadata) if (type === 'cache' && absolute(path) && !plugins.has(id) && settings.get(id) !== false &&
    (id.endsWith('@synced') || !registry || settings.get(id) && !(object(installs) && Object.hasOwn(installs, id)))) plugins.set(id, { path, id });
  for (const [type, id, path] of metadata) if (type === 'localplugin' && absolute(path) && !plugins.has(id)) plugins.set(id, { path, id });
  const projects = metadata.filter(([t,, p]) => t === 'project' && absolute(p)).map(r => r[2]);
  const unknownSettings = metadata.some(([t,,v]) => t === 'settings' && v === 'unknown');
  if (unknownSettings) plugins.clear();
  const roots = [...plugins.values()].filter(r => validName(r.id.split('@')[0])).slice(0, 96);
  if (roots.length) {
    const manifests = await reader(transport, workspace, `${metadataReader}\n` + roots.map((r, i) => `[ ! -L ${q(posix.join(r.path, '.claude-plugin'))} ] && record_json manifest ${i} ${q(posix.join(r.path, '.claude-plugin/plugin.json'))}; :`).join('\n'), signal);
    for (const [,index,encoded] of manifests) if (roots[+index]) roots[+index].manifest = encoded === 'unknown' ? { unavailable: true } : json(encoded);
  }
  // Read at most a short frontmatter prefix on-target, and send *only* a name, never a body.
  const nameReader = `NR==1 && $0 !~ /^---[[:space:]]*$/ { exit } NR>1 && /^---[[:space:]]*$/ { exit } /^name:[[:space:]]*/ {sub(/^name:[[:space:]]*/, ""); name=$0} /^user-invocable:[[:space:]]*false([[:space:]]|$)/ {hidden=1} END {if(hidden) print "!"; else print name}`;
  const scans: string[] = [];
  const scan = (root: string, dir: string, type: 'skills' | 'commands', source: string, ns = '') => scans.push(`scan ${[root, dir, type, source, ns].map(q).join(' ')}`);
  for (const [source, base] of [['user',configPath], ...projects.map(p => ['project',p])]) {
    scan(base, 'skills', 'skills', source); scan(base, 'commands', 'commands', source);
  }
  const inline: CompletionItem[] = [];
  for (const r of roots) {
    const m = r.manifest ?? {}, n = typeof m.name === 'string' ? m.name : r.id.split('@')[0];
    const key = r.id.endsWith('@skills-dir') || r.id.endsWith('@synced') ? n + r.id.slice(r.id.lastIndexOf('@')) : r.id;
    if (m.unavailable || !validName(n) || settings.get(key) === false || m.defaultEnabled === false && settings.get(key) !== true) continue;
    for (const d of ['skills', ...paths(m.skills)]) scan(r.path, d, 'skills', 'plugin', n + ':');
    if (m.skills == null) scan(r.path, 'SKILL.md', 'skills', 'plugin', n + ':');
    if (object(m.commands)) {
      for (const [k,v] of Object.entries(m.commands)) if (validName(k) && object(v) && (v.content === true || paths(v.source).length)) inline.push({ kind: 'command', value: n + ':' + k, source: 'plugin' });
    } else for (const d of m.commands == null ? ['commands'] : paths(m.commands)) scan(r.path, d, 'commands', 'plugin', n + ':');
  }
  const listing = await reader(transport, workspace, `emit() {
 [ -f "$1" ] && [ ! -L "$1" ] && [ -r "$1" ] || return 0
 hint=$(head -c 8192 < "$1" | awk ${q(nameReader)}); [ "$hint" != '!' ] || return 0
 case "$1" in SKILL.md|*/SKILL.md) ;; *) hint='';; esac
 printf '%s\\0%s\\0%s\\0' "$3" "$4$2" "$hint"
}
scan() (
 cd -P "$1" 2>/dev/null || exit 0; base=$(pwd -P); rel=\${2#./}; leaf=\${rel##*/}; parent=\${rel%/*}
 if [ -f "$rel" ]; then
  [ "$parent" != "$rel" ] || parent=.; cd -P "./$parent" || exit 0
  case "$(pwd -P)/" in "$base/"*) ;; *) exit 0;; esac
  case "$3:$leaf" in skills:SKILL.md) [ ! -d "$base/skills" ] && emit "$leaf" "\${5%:}" "$4" "$5";; commands:*.md) emit "$leaf" "\${leaf%.md}" "$4" "$5";; esac; exit 0
 fi
 cd -P "./$rel" 2>/dev/null || exit 0; here=$(pwd -P); case "$here/" in "$base/"*) ;; *) exit 0;; esac
 if [ "$3" = skills ]; then
  if [ -f SKILL.md ]; then emit SKILL.md "\${here##*/}" "$4" "$5"; else
   for d in ./*; do [ -d "$d" ] || continue; [ "$d" != ./synced ] || continue
    # skills installers often symlink project entries into .agents/skills. Stay inside that repository.
    if [ -L "$d" ] && [ "$4" != user ]; then
      [ "$4" = project ] || continue; physical=$(cd -P "$d" 2>/dev/null && pwd -P) || continue
      case "$physical/" in "\${base%/*}/"*) ;; *) continue;; esac
    fi
    emit "$d/SKILL.md" "\${d#./}" "$4" "$5"
   done
   if [ "$4" = user ] && [ -d synced ] && [ ! -L synced ]; then for d in synced/*; do emit "$d/SKILL.md" "\${d##*/}" user 'anthropic-skills:'; done; fi
  fi
 else
  find -P . -maxdepth 12 \\( -name '.*' ! -name . -o -name node_modules -o -name vendor -o -name '*[[:cntrl:]]*' \\) -prune -o -type f -name '*.md' -print 2>/dev/null | head -n 512 | while IFS= read -r f; do name=\${f#./}; emit "$f" "\${name%.md}" "$4" "$5"; done
 fi
)
${scans.join('\n')}\n:`, signal);
  for (const [source, path, hint] of listing) {
    if (source !== 'user' && source !== 'project' && source !== 'plugin') continue;
    const fallback = path.replaceAll('/', ':');
    const label = hint.trim().replace(/^(["'])(.*)\1$/, '$2');
    const name = validName(label) ? fallback.slice(0, fallback.lastIndexOf(':') + 1) + label : fallback;
    if (validName(name)) inline.push({ kind: 'command', value: name, source });
  }
  return inline;
}
