// Replies of the host check (src/backend/host-probe.ts) for tests that stub the transport.
export interface ProbeFields {
  system?: string; arch?: string; uid?: string; osVersion?: string;
  osRelease?: { ID?: string; ID_LIKE?: string; PRETTY_NAME?: string; VERSION_ID?: string };
  managers?: string[];
  tmux?: string | null; tmuxVersion?: string; claude?: string | null; claudeVersion?: string;
  extra?: string[];
}
/** A complete reply; `tmux: null` or `claude: null` leaves the tool missing. */
export function probeReply(fields: ProbeFields = {}): string {
  const { system = 'Linux', arch = 'x86_64', uid = '1000', managers = ['apt-get'], osRelease = { ID: 'ubuntu', ID_LIKE: 'debian', PRETTY_NAME: '"Ubuntu 24.04 LTS"', VERSION_ID: '"24.04"' } } = fields;
  const tmux = fields.tmux === undefined ? '/usr/bin/tmux' : fields.tmux, claude = fields.claude === undefined ? '/home/dev/.local/bin/claude' : fields.claude;
  const lines = ['lectern-host-probe 1', `system=${system}`, `arch=${arch}`, `uid=${uid}`];
  if (fields.osVersion) lines.push(`os_version=${fields.osVersion}`);
  for (const [key, value] of Object.entries(osRelease)) lines.push(`os_${key}=${value ?? ''}`);
  for (const manager of managers) lines.push(`manager=${manager}`);
  lines.push(`tmux.path=${tmux ?? ''}`);
  if (tmux) lines.push(`tmux.version=${fields.tmuxVersion ?? 'tmux 3.4'}`);
  lines.push(`claude.path=${claude ?? ''}`);
  if (claude) lines.push(`claude.version=${fields.claudeVersion ?? '2.1.329 (Claude Code)'}`);
  return [...lines, ...fields.extra ?? [], 'end', ''].join('\n');
}
