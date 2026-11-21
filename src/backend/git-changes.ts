import { homedir } from 'node:os';
import type { GitChange, GitChanges, Workspace } from '../shared/types';
import { quoteShell as q, type Transport } from './transport';

const fileLimit = 300;
const marker = 'LECTERN_GIT';
// Folders macOS guards with a per-app consent prompt; never read them unasked.
const privacyFolders = ['Desktop', 'Documents', 'Downloads', 'Library', 'Pictures', 'Movies', 'Music', 'Public'];

/** A local macOS folder inside Desktop, Documents, … : reading it may raise a system prompt. */
export function privacyGuarded(workspace: Workspace, home = homedir(), platform = process.platform): boolean {
  if (workspace.kind !== 'local' || platform !== 'darwin') return false;
  const cwd = workspace.cwd.replace(/\/+$/u, '');
  return privacyFolders.some(folder => cwd === `${home}/${folder}` || cwd.startsWith(`${home}/${folder}/`));
}

/** The repository containing the folder: its root, branch, then NUL-separated
 * `git status -z` and `git diff --numstat -z HEAD` (staged and unstaged). */
export function gitChangesScript(cwd: string): string {
  return `cd ${q(cwd)} 2>/dev/null || exit 0
command -v git >/dev/null 2>&1 || exit 0
lectern_top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
lectern_branch=$(git symbolic-ref --short -q HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null || true)
printf '%s\\0%s\\0%s\\0' ${q(marker)} "$lectern_top" "$lectern_branch"
cd "$lectern_top" || exit 0
git --no-optional-locks -c core.quotepath=off status --porcelain=v1 -z --untracked-files=normal 2>/dev/null | head -c 262144
printf '\\0%s\\0' ${q(marker + '_NUMSTAT')}
git --no-optional-locks -c core.quotepath=off diff --numstat -z HEAD 2>/dev/null | head -c 262144
exit 0`;
}

const kinds: Record<string, GitChange['status']> = { '?': 'untracked', A: 'added', D: 'deleted', R: 'renamed', C: 'added', M: 'modified', T: 'modified', U: 'conflict' };
function statusOf(code: string): GitChange['status'] {
  if (code === '??') return 'untracked';
  if (code.includes('U') || code === 'AA' || code === 'DD') return 'conflict';
  for (const letter of [code[0], code[1]]) if (letter && letter !== ' ' && kinds[letter]) return kinds[letter];
  return 'modified';
}

export function parseGitChanges(output: Buffer | string): GitChanges | undefined {
  const fields = output.toString('utf8').split('\0');
  const start = fields.indexOf(marker);
  if (start < 0 || !fields[start + 1]?.startsWith('/')) return;
  const root = fields[start + 1], branch = fields[start + 2] || undefined;
  const split = fields.indexOf(marker + '_NUMSTAT', start + 3);
  const status = fields.slice(start + 3, split < 0 ? undefined : split);
  const numstat = split < 0 ? [] : fields.slice(split + 1);
  const files = new Map<string, GitChange>();
  for (let i = 0; i < status.length; i++) {
    const entry = status[i];
    if (entry.length < 4 || entry[2] !== ' ') continue;
    const code = entry.slice(0, 2), path = entry.slice(3);
    const change: GitChange = { path, status: statusOf(code) };
    // A rename or copy is followed by its original path.
    if (/[RC]/u.test(code)) change.from = status[++i];
    files.set(path, change);
  }
  for (let i = 0; i < numstat.length; i++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/su.exec(numstat[i]);
    if (!match) continue;
    let path = match[3];
    if (!path) { i += 2; path = numstat[i] ?? ''; }
    const change = files.get(path);
    if (!change) continue;
    if (match[1] === '-') change.binary = true;
    else { change.added = Number(match[1]); change.removed = Number(match[2]); }
  }
  const all = [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { root, repo: root.split('/').filter(Boolean).at(-1) ?? root, ...(branch && { branch }),
    files: all.slice(0, fileLimit), total: all.length, added: all.reduce((n, f) => n + (f.added ?? 0), 0),
    removed: all.reduce((n, f) => n + (f.removed ?? 0), 0) };
}

/** The working changes of the git repository the folder is in; undefined outside one. */
export async function gitChanges(transport: Transport, workspace: Workspace): Promise<GitChanges | undefined> {
  const { stdout } = await transport.run(workspace, gitChangesScript(workspace.cwd), { tag: 'git.changes', timeoutMs: 15_000, maxBytes: 1024 * 1024 });
  return parseGitChanges(stdout);
}
