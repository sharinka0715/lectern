// What a machine needs before Lectern can run Claude Code on it: `tmux` and `claude`,
// looked up with the same PATH Lectern launches sessions with (shellEnvironment in
// src/backend/transport.ts). The backend probes each machine once (host-probe.ts);
// this module says what is missing and which install commands fit its system.
import { allTranslations, joinList, t, type MessageKey, type MessageParams } from './i18n';

export type HostTool = 'tmux' | 'claude';
/** Display order. */
export const hostTools: readonly HostTool[] = ['tmux', 'claude'];
export const toolName = (tool: HostTool) => tool === 'claude' ? 'Claude Code' : 'tmux';
/** The oldest Claude Code release the compatibility matrix tests (scripts/cc-matrix). */
export const OLDEST_TESTED_CLAUDE = '2.1.300';

export interface HostToolState {
  /** Absolute path on the launch PATH; absent when the tool is not found there. */
  path?: string;
  /** First line of `tmux -V` or `claude --version`. */
  version?: string;
  /** Executables of this name in common install directories outside the launch PATH. */
  elsewhere?: string[];
  /** Several nvm installations and none on PATH: Lectern will not pick one. */
  ambiguous?: string[];
}
export interface HostTools {
  /** `uname -s`: Darwin, Linux, … */
  system: string;
  arch?: string;
  /** macOS product version or /etc/os-release VERSION_ID. */
  osVersion?: string;
  /** /etc/os-release ID followed by ID_LIKE, lowercase. */
  distro: string[];
  /** /etc/os-release PRETTY_NAME. */
  distroName?: string;
  /** Package managers on the launch PATH (brew, port, apt-get, dnf, yum, zypper, pacman, apk, npm). */
  managers: string[];
  root: boolean;
  tmux: HostToolState;
  claude: HostToolState;
}
/** A probe that ran (`tools`), or why it could not run: never read as a missing tool. */
export type HostCheck = { ok: true; tools: HostTools } | { ok: false; message: string };

export function missingTools(tools: HostTools): HostTool[] {
  return hostTools.filter(tool => !tools[tool].path);
}
/** "tmux", "Claude Code", or both joined for the current language. */
export function toolList(tools: readonly HostTool[]): string {
  const names = tools.map(toolName);
  return names.length === 2 ? t('hostTools.pair', { first: names[0], second: names[1] }) : joinList(names);
}

/** Message parameters naming a machine: `where` selects "this computer" when there is no SSH name. */
export const machineParams = (machine?: string) => ({ where: machine ? 'ssh' : 'local', machine: machine ?? '' });
/** The error a session operation fails with on a machine that lacks a tool it needs (`machine`: an SSH name, or none for this computer). */
export function missingToolsMessage(machine: string | undefined, missing: readonly HostTool[]): string {
  return t('hostTools.missingError', { ...machineParams(machine), tools: toolList(missing), note: t('hostTools.missingNote') });
}
/** That error, in either language (a backend error may be worded before a language switch). */
export const isMissingToolsError = (message: string | undefined) =>
  !!message && allTranslations('hostTools.missingNote').some(note => message.includes(note));

/** "2.1.329" from "2.1.329 (Claude Code)"; undefined when there is no x.y.z. */
export function versionNumber(text: string | undefined): string | undefined {
  return /(?:^|[^\d.])(\d+\.\d+\.\d+)(?![\d.])/.exec(` ${text ?? ''}`)?.[1];
}
/** Negative, zero or positive as version a sorts before, with or after b. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [a, b].map(v => v.split('.').map(Number));
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}
/** The Claude Code version when it is older than the oldest one tested. Never a reason to block. */
export function outdatedClaude(tools: HostTools): string | undefined {
  const version = tools.claude.path ? versionNumber(tools.claude.version) : undefined;
  return version && compareVersions(version, OLDEST_TESTED_CLAUDE) < 0 ? version : undefined;
}

/** One way to install a tool: what it is (a message key) and the command to copy. */
export interface InstallHint { label: MessageKey; params?: MessageParams; command: string }
/** Official commands (https://code.claude.com/docs/en/setup, https://brew.sh). */
export const CLAUDE_INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';
export const CLAUDE_UPDATE = 'claude update';
const HOMEBREW_INSTALL = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';

/** A path as one POSIX shell word. */
export function shellWord(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
}
/** ~/.local/bin is first on the PATH Lectern launches with (and the official installer's own directory). */
const linkHint = (label: MessageKey, path: string, name: string): InstallHint =>
  ({ label, params: { path }, command: `mkdir -p ~/.local/bin && ln -s ${shellWord(path)} ~/.local/bin/${name}` });

export type LinuxFamily = 'debian' | 'fedora' | 'suse' | 'arch' | 'alpine';
/** The distribution family from os-release ID and ID_LIKE, else from the package manager present. */
export function linuxFamily(tools: HostTools): LinuxFamily | undefined {
  for (const id of tools.distro) {
    if (['debian', 'ubuntu', 'linuxmint', 'pop', 'raspbian', 'kali', 'elementary', 'zorin', 'neon'].includes(id)) return 'debian';
    if (['fedora', 'rhel', 'centos', 'rocky', 'almalinux', 'ol', 'amzn', 'nobara'].includes(id)) return 'fedora';
    if (id === 'suse' || id === 'sles' || id.startsWith('opensuse')) return 'suse';
    if (['arch', 'manjaro', 'endeavouros', 'garuda'].includes(id)) return 'arch';
    if (id === 'alpine') return 'alpine';
  }
  const has = (manager: string) => tools.managers.includes(manager);
  return has('apt-get') ? 'debian' : has('dnf') || has('yum') ? 'fedora' : has('zypper') ? 'suse' : has('pacman') ? 'arch' : has('apk') ? 'alpine' : undefined;
}

/** Ways to get tmux onto the machine: macOS → Homebrew, Linux → its package manager. Empty when unknown. */
export function tmuxHints(tools: HostTools): InstallHint[] {
  const hints = tools.tmux.elsewhere?.length ? [linkHint('hostTools.linkIntoPath', tools.tmux.elsewhere[0], 'tmux')] : [];
  const sudo = tools.root ? '' : 'sudo ';
  if (tools.system === 'Darwin') {
    if (tools.managers.includes('brew')) hints.push({ label: 'hostTools.viaHomebrew', command: 'brew install tmux' });
    else if (tools.managers.includes('port')) hints.push({ label: 'hostTools.viaMacPorts', command: `${sudo}port install tmux` });
    else hints.push({ label: 'hostTools.installHomebrew', command: HOMEBREW_INSTALL }, { label: 'hostTools.viaHomebrew', command: 'brew install tmux' });
  } else if (tools.system === 'Linux') {
    const yum = !tools.managers.includes('dnf') && tools.managers.includes('yum'), family = linuxFamily(tools);
    const command = family && { debian: 'apt install tmux', fedora: `${yum ? 'yum' : 'dnf'} install tmux`, suse: 'zypper install tmux', arch: 'pacman -S tmux', alpine: 'apk add tmux' }[family];
    if (command) hints.push({ label: 'hostTools.viaManager', params: { manager: command.split(' ')[0] }, command: sudo + command });
  }
  return hints;
}

/** Ways to get Claude Code: the official installer first, then Homebrew or npm where present. */
export function claudeHints(tools: HostTools): InstallHint[] {
  const hints: InstallHint[] = [];
  if (tools.claude.ambiguous?.length) hints.push(linkHint('hostTools.pickNvm', tools.claude.ambiguous[0], 'claude'));
  else if (tools.claude.elsewhere?.length) hints.push(linkHint('hostTools.linkIntoPath', tools.claude.elsewhere[0], 'claude'));
  // The installer needs bash and curl, which Alpine lacks by default.
  if (tools.system === 'Linux' && linuxFamily(tools) === 'alpine') hints.push({ label: 'hostTools.alpineDeps', command: `${tools.root ? '' : 'sudo '}apk add bash curl` });
  hints.push({ label: 'hostTools.officialInstaller', command: CLAUDE_INSTALL });
  if (tools.system === 'Darwin' && tools.managers.includes('brew')) hints.push({ label: 'hostTools.viaHomebrew', command: 'brew install --cask claude-code' });
  if (tools.managers.includes('npm')) hints.push({ label: 'hostTools.viaNpm', command: 'npm install -g @anthropic-ai/claude-code@latest' });
  return hints;
}
export const installHints = (tools: HostTools, tool: HostTool) => tool === 'tmux' ? tmuxHints(tools) : claudeHints(tools);

/** "macOS 15.1 (arm64)", "Ubuntu 24.04 LTS (x86_64)", or the bare `uname -s`. */
export function systemLabel(tools: HostTools): string {
  const name = tools.system === 'Darwin' ? `macOS${tools.osVersion ? ` ${tools.osVersion}` : ''}` : tools.distroName || tools.system || '?';
  return tools.arch ? `${name} (${tools.arch})` : name;
}
