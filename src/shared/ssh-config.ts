import { t } from './i18n';
// Lists the concrete Host aliases of an OpenSSH client configuration so they can be
// imported as Lectern machines. Only aliases are imported: OpenSSH keeps resolving
// HostName, User, Port, ProxyJump and keys from the user's own files at connect time.

export interface SshConfigHost {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
  proxyJump?: string;
  /** File and 1-based line of the Host line that declared the alias. */
  source: string;
  line: number;
}
export interface SshConfigImport {
  path: string;
  hosts: SshConfigHost[];
  /** Unreadable or recursive Include files, oversized files and similar. */
  warnings: string[];
  /** The main config file does not exist or cannot be read. */
  missing?: boolean;
}
/** File access is injected so the parser stays pure and testable. */
export interface SshConfigFiles {
  /** undefined when the file does not exist or cannot be read. */
  read(path: string): string | undefined;
  /** Paths matching a glob pattern (absolute, already ~-expanded), sorted. */
  expand(pattern: string): string[];
}

const MAX_DEPTH = 16;

/** Same rule as a hand-typed machine: alias or user@host made of safe characters. */
export function importableSshAlias(alias: string): boolean {
  return alias.length <= 255 && /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9_\[][A-Za-z0-9_.:\[\]-]*$/.test(alias);
}

/** OpenSSH arguments: whitespace separated, double quotes group. */
export function splitSshArgs(text: string): string[] {
  const args: string[] = [];
  for (const match of text.matchAll(/"([^"]*)"|(\S+)/g)) args.push(match[1] ?? match[2]);
  return args;
}

function resolveInclude(path: string, home: string, sep: string): string {
  if (path === '~' || path.startsWith('~/')) return home + path.slice(1).replace(/\//g, sep);
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return path;
  // Relative user-config includes are relative to ~/.ssh (ssh_config(5)).
  return [home, '.ssh', path].join(sep);
}

export function parseSshConfig(entry: string, home: string, files: SshConfigFiles, sep = '/'): SshConfigImport {
  const hosts: SshConfigHost[] = [], warnings: string[] = [], seen = new Set<string>(), visiting = new Set<string>();
  let missing = false;
  const visit = (path: string, depth: number) => {
    if (depth > MAX_DEPTH) { warnings.push(t('shared.includeTooDeep', { path })); return; }
    if (visiting.has(path)) { warnings.push(t('shared.includeCycle', { path })); return; }
    const text = files.read(path);
    if (text === undefined) { if (depth > 0) warnings.push(t('shared.includeUnreadable', { path })); else missing = true; return; }
    visiting.add(path);
    // Settings after Host apply to every alias on that line until the next Host/Match.
    let block: SshConfigHost[] | undefined;
    text.split(/\r?\n/).forEach((raw, index) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const match = /^([A-Za-z][A-Za-z0-9]*)(?:\s*=\s*|\s+)(.*)$/.exec(line);
      if (!match) return;
      const keyword = match[1].toLowerCase(), args = splitSshArgs(match[2]);
      if (keyword === 'host') {
        block = [];
        for (const pattern of args) {
          // Patterns, negations and wildcards are rules for other hosts, not machines.
          if (!pattern || /[*?!,]/.test(pattern) || seen.has(pattern)) continue;
          seen.add(pattern);
          const host: SshConfigHost = { alias: pattern, source: path, line: index + 1 };
          hosts.push(host); block.push(host);
        }
      } else if (keyword === 'match') {
        block = undefined;
      } else if (keyword === 'include') {
        for (const pattern of args) for (const file of files.expand(resolveInclude(pattern, home, sep))) visit(file, depth + 1);
      } else if (block && args[0] !== undefined) {
        // OpenSSH uses the first value obtained for each option.
        for (const host of block) {
          if (keyword === 'hostname') host.hostName ??= args[0];
          else if (keyword === 'user') host.user ??= args[0];
          else if (keyword === 'port' && /^\d{1,5}$/.test(args[0]) && +args[0] >= 1 && +args[0] <= 65535) host.port ??= +args[0];
          else if (keyword === 'proxyjump') host.proxyJump ??= args[0];
        }
      }
    });
    visiting.delete(path);
  };
  visit(entry, 0);
  return { path: entry, hosts, warnings, ...(missing ? { missing } : {}) };
}

/** Text shown beside an alias: user@hostname:port via jump. */
export function describeSshHost(host: SshConfigHost): string {
  const target = host.hostName ? `${host.user ? host.user + '@' : ''}${host.hostName}${host.port ? ':' + host.port : ''}`
    : `${host.user ? host.user + '@' : ''}${host.port ? t('shared.sshPort', { port: host.port }) : ''}`;
  return [target, host.proxyJump && host.proxyJump !== 'none' ? t('shared.sshVia', { jump: host.proxyJump }) : ''].filter(Boolean).join(' · ');
}
