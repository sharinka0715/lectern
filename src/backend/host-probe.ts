// One command per machine that reports whether tmux and Claude Code can run there,
// their versions, and what the install hints need to know (system, distribution,
// package managers, root). It runs through Transport like every other command, so
// it sees exactly the PATH sessions are launched with (shellEnvironment: ~/.local/bin,
// Homebrew, a single nvm installation, …). Output is `key=value` lines between a
// header and `end`; anything else (an incomplete reply) is a failed check, never a
// missing tool.
import { quoteShell } from './transport';
import type { HostTool, HostTools, HostToolState } from '../shared/host-tools';

const HEADER = 'lectern-host-probe 1';
/** Common install directories a non-login shell's PATH lacks; only reported, never used. */
const elsewhere = ['$HOME/bin', '$HOME/.npm-global/bin', '$HOME/.bun/bin', '$HOME/.volta/bin', '$HOME/.linuxbrew/bin',
  '/home/linuxbrew/.linuxbrew/bin', '/opt/local/bin', '/snap/bin', '/usr/local/sbin'];

/** The probe script. `claude`: the executable sessions launch (a test double may stand in);
 * `version: false` skips running it (a double may not understand --version). */
export function hostProbeScript({ claude = 'claude', version = true }: { claude?: string; version?: boolean } = {}): string {
  // Every value is one line already (command -v, uname, head -n 1), so no extra process per field.
  return `lectern_field() { printf '%s=%s\\n' "$1" "$2"; }
lectern_tool() {
 lectern_path=$(command -v "$2" 2>/dev/null) || lectern_path=
 case "$lectern_path" in /*) ;; *) lectern_path= ;; esac
 lectern_field "$1.path" "$lectern_path"
 if [ -n "$lectern_path" ] && [ -n "$3" ]; then
  if command -v timeout >/dev/null 2>&1; then lectern_v=$(timeout 10 "$lectern_path" "$3" </dev/null 2>/dev/null | head -n 1)
  else lectern_v=$("$lectern_path" "$3" </dev/null 2>/dev/null | head -n 1); fi
  lectern_field "$1.version" "$lectern_v"
 fi
 [ -z "$lectern_path" ] || return 0
 for lectern_dir in ${elsewhere.map(dir => `"${dir}"`).join(' ')}; do
  [ -f "$lectern_dir/$2" ] && [ -x "$lectern_dir/$2" ] && lectern_field "$1.elsewhere" "$lectern_dir/$2"
 done
 return 0
}
printf '%s\\n' ${quoteShell(HEADER)}
lectern_field system "$(uname -s 2>/dev/null)"
lectern_field arch "$(uname -m 2>/dev/null)"
lectern_field uid "$(id -u 2>/dev/null)"
[ "$(uname -s 2>/dev/null)" = Darwin ] && lectern_field os_version "$(sw_vers -productVersion 2>/dev/null)"
if [ -r /etc/os-release ]; then
 for lectern_key in ID ID_LIKE PRETTY_NAME VERSION_ID; do lectern_field "os_$lectern_key" "$(sed -n "s/^$lectern_key=//p" /etc/os-release 2>/dev/null | head -n 1)"; done
fi
for lectern_manager in brew port apt-get dnf yum zypper pacman apk npm; do
 command -v "$lectern_manager" >/dev/null 2>&1 && lectern_field manager "$lectern_manager"
done
lectern_tool tmux tmux -V
lectern_tool claude ${quoteShell(claude)} ${version ? '--version' : "''"}
if [ -z "$(command -v ${quoteShell(claude)} 2>/dev/null)" ] && [ -n "$lectern_claude_path_error" ]; then
 for lectern_cli in "\${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/claude; do [ -x "$lectern_cli" ] && lectern_field claude.ambiguous "$lectern_cli"; done
fi
printf 'end\\n'
`;
}

/** The probe's reply, or an Error when it is not a complete reply. */
export function parseHostProbe(output: string): HostTools {
  const lines = output.split('\n').map(line => line.replace(/\r$/, ''));
  const start = lines.indexOf(HEADER), end = lines.indexOf('end', start + 1);
  if (start < 0 || end < 0) throw new Error('The host check returned an incomplete reply');
  const values = new Map<string, string[]>();
  for (const line of lines.slice(start + 1, end)) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const key = line.slice(0, at), value = line.slice(at + 1).trim();
    if (value) values.set(key, [...values.get(key) ?? [], value]);
  }
  const one = (key: string) => values.get(key)?.[0];
  // os-release values may be quoted.
  const unquote = (value?: string) => value?.replace(/^(["'])(.*)\1$/, '$2');
  const tool = (name: HostTool): HostToolState => {
    const path = one(`${name}.path`);
    return { ...(path?.startsWith('/') && { path }), ...(path && one(`${name}.version`) && { version: one(`${name}.version`) }),
      ...(!path && values.has(`${name}.elsewhere`) && { elsewhere: values.get(`${name}.elsewhere`) }),
      ...(!path && values.has(`${name}.ambiguous`) && { ambiguous: values.get(`${name}.ambiguous`) }) };
  };
  const distro = [unquote(one('os_ID')), ...(unquote(one('os_ID_LIKE'))?.split(/\s+/) ?? [])]
    .filter((id): id is string => !!id).map(id => id.toLowerCase());
  const osVersion = one('os_version') ?? unquote(one('os_VERSION_ID')), distroName = unquote(one('os_PRETTY_NAME'));
  return {
    system: one('system') ?? '', ...(one('arch') && { arch: one('arch') }), ...(osVersion && { osVersion }),
    distro, ...(distroName && { distroName }), managers: values.get('manager') ?? [], root: one('uid') === '0',
    tmux: tool('tmux'), claude: tool('claude'),
  };
}

/** A session operation refused because the machine lacks a tool it needs (see missingToolsMessage). */
export class HostToolsError extends Error {
  constructor(message: string, readonly missing: HostTool[]) { super(message); this.name = 'HostToolsError'; }
}
