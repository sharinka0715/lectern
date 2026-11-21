import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseSshConfig, type SshConfigImport } from '../shared/ssh-config';

const MAX_BYTES = 1 << 20;

/** ssh_config(5) Include globs: `*` and `?` in any segment; dotfiles need an explicit dot. */
export function expandSshGlob(pattern: string): string[] {
  if (!/[*?]/.test(pattern)) return [pattern];
  const { root } = path.parse(pattern);
  let current = [root || '.'];
  for (const segment of pattern.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    if (!/[*?]/.test(segment)) { current = current.map(dir => path.join(dir, segment)); continue; }
    const matcher = new RegExp('^' + segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    current = current.flatMap(dir => {
      try { return readdirSync(dir).filter(name => (!name.startsWith('.') || segment.startsWith('.')) && matcher.test(name)).sort().map(name => path.join(dir, name)); }
      catch { return []; }
    });
  }
  return current;
}

/** Read the local user's OpenSSH client config (and its Includes) for importable Host aliases. */
export function readSshConfigHosts(home = homedir()): SshConfigImport {
  return parseSshConfig(path.join(home, '.ssh', 'config'), home, {
    read(file) {
      try {
        const stat = statSync(file);
        return stat.isFile() && stat.size <= MAX_BYTES ? readFileSync(file, 'utf8') : undefined;
      } catch { return undefined; }
    },
    expand: expandSshGlob,
  }, path.sep);
}
