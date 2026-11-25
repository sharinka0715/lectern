import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setMaxListeners } from 'node:events';
import { spawn } from './child-fds';
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Workspace } from '../shared/types';
import { diagnostic, summarize } from '../diagnostics';
import { runInteractiveLogin, type AnswerPrompt } from './ssh-login';
import { ChannelUnavailable, CommandChannel, channelScript, remoteWatcher } from './command-channel';
import { hangUp, hangUpGraceMs, whenGone } from './hang-up';
import { defaultSessionLimits, HostSessions, type ConnectionMode, type SessionPlace } from './session-slots';
import { sshOnly, sshOnlyMessage, targetSystem, unsupportedTargetMessage, windowsShellFailure } from '../shared/supported-targets';
import { t } from '../shared/i18n';
import { defaultSshConnectionPreferences, type SshDisconnectResult, type SshMasterState } from '../shared/ssh-connections';
import { ownerFile, privateSshDirectory, sshControlSockets, type SshControlDirectory } from './ssh-control';

/** The SSH target runs neither macOS nor Linux. Kept for the host: every later command fails the same way. */
export class UnsupportedTargetError extends Error {}

export function quoteShell(value: string): string {
  if (value.includes('\0')) throw new Error('Shell arguments cannot contain NUL');
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function validateWorkspace(value: Workspace): Workspace {
  if (!value || typeof value !== 'object') throw new Error('Invalid workspace');
  if (!/^[\w-]{1,100}$/.test(value.id)) throw new Error('Invalid workspace ID');
  if (!['local', 'ssh'].includes(value.kind)) throw new Error('Invalid connection type');
  const path = value.cwd;
  if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('|~lectern~|') || /[\x00-\x1f\x7f]/.test(path) || !(path.startsWith('/') || path === '~' || path.startsWith('~/'))) {
    throw new Error('Working directory must be an absolute POSIX path or ~/path');
  }
  if (value.kind === 'ssh') {
    // ssh receives separate argv, but reject option-like destinations and URI syntax too.
    if (typeof value.host !== 'string' || !/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9_\[][A-Za-z0-9_.:\[\]-]*$/.test(value.host) || value.host.length > 255) throw new Error('Use an SSH config alias or user@hostname');
    if (value.port !== undefined && (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535)) throw new Error('Invalid SSH port');
  }
  // A default label is the target's POSIX basename, including significant spaces.
  if (value.name && value.name === posix.basename(value.cwd) && Buffer.byteLength(value.name) <= 255) return { ...value };
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120) throw new Error('Workspace name must be 1–120 characters');
  return { ...value, name: value.name.trim() };
}

export interface CommandOptions {
  signal?: AbortSignal; input?: string | Buffer; timeoutMs?: number; maxBytes?: number; controlPath?: string; controlPersist?: number; sshConfigPath?: string; reuseExistingMaster?: boolean; tag?: string; output?: Writable;
  /** Skip the channel's request/output files for sensitive command data. */
  privateContent?: boolean;
  /** Called once the command's process is gone, which for SSH means its session has ended on the target
   * (`confirmed` false: the client had to be killed, the session may linger). The promise may settle earlier. */
  onSessionEnd?: (confirmed: boolean) => void;
  /** How long a cancelled SSH command gets to end on the target before its client is killed. */
  hangUpGraceMs?: number;
}
export interface CommandResult { stdout: Buffer; stderr: string }

/** Resolve a unique nvm installation without sourcing executable shell profiles.
 * LECTERN_LOCAL_PATH replaces the PATH of commands on this computer outright (no
 * additions, no nvm lookup): tests use it to run with tmux or claude out of reach. */
export function shellEnvironment(kind: Workspace['kind'] = 'ssh'): string {
  const fixed = kind === 'local' ? process.env.LECTERN_LOCAL_PATH : undefined;
  if (fixed) return `export PATH=${quoteShell(fixed)}\nlectern_claude_path_error=''\n`;
  return `export PATH="$HOME/.local/bin:$HOME/.claude/local:/opt/homebrew/bin:/usr/local/bin:$PATH"
lectern_claude_path_error=''
if ! command -v claude >/dev/null 2>&1; then
 lectern_nvm_bin=''; lectern_nvm_count=0
 for lectern_nvm_cli in "\${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/claude; do
  [ -f "$lectern_nvm_cli" ] && [ -x "$lectern_nvm_cli" ] || continue
  lectern_nvm_bin=\${lectern_nvm_cli%/*}; lectern_nvm_count=$((lectern_nvm_count + 1))
  [ "$lectern_nvm_count" -lt 2 ] || break
 done
 if [ "$lectern_nvm_count" -eq 1 ]; then export PATH="$lectern_nvm_bin:$PATH"
 elif [ "$lectern_nvm_count" -gt 1 ]; then lectern_claude_path_error='Multiple nvm Claude installations found; expose the intended Claude executable in the non-interactive SSH PATH before launching.'
 fi
fi\n`;
}

/**
 * The text `exec sh -s` reads for one command; also one request on a command
 * channel (`session` false: the channel loop runs it and watches the client itself).
 * A one-off session (`session` true) keeps reading its input while the command
 * runs: the client sends nothing more and closes it only to cancel, and the
 * watcher then ends the command so sshd frees the session (see hang-up.ts). The
 * whole request is one `{ … }` block ending in `exit`: the shell parses all of it
 * before running anything, so the watcher can never read a line of the request,
 * and the shell never waits for more input after it.
 */
export function remoteRequest(command: string, input?: string | Buffer, statusMarker?: string, session = false): string {
  const run = `eval ${quoteShell(command)}`;
  let body = `${run} </dev/null`;
  if (input !== undefined && input.length) {
    // The shell parses the complete pipeline before executing it. Only the
    // original bytes reach commands such as tmux load-buffer, even for NULs
    // and input resembling shell syntax. '_' cannot occur in base64 data.
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
    body = `{\nbase64 -d <<'LECTERN_STDIN'\n${bytes.toString('base64')}\nLECTERN_STDIN\n} | ${run}`;
  }
  // Some jump hosts report success for a one-off session whose command
  // never ran, or failed: print the real status after it. The subshell keeps an
  // `exit` in the command from skipping the report.
  const report = statusMarker ? `printf '\\n%s%s\\n' ${quoteShell(statusMarker)} "$?"\n` : '';
  if (!session) return statusMarker ? `(\n${body}\n)\n${report}` : `${body}\n`;
  return `{\nexec 3<&0\n${remoteWatcher}\n(\n${body}\n) 3<&- &\nlectern_job=$!\nlectern_watch "$lectern_job"\nwait "$lectern_job"\n`
    + `lectern_status=$?\nkill -KILL "$lectern_watcher" 2>/dev/null; wait "$lectern_watcher" 2>/dev/null\n`
    + (statusMarker ? `(exit "$lectern_status")\n${report}exit 0\n` : 'exit "$lectern_status"\n') + '}\n';
}

export function commandInvocation(workspace: Workspace, script: string, controlPath?: string, sshConfigPath?: string, reuseExistingMaster = false, input?: string | Buffer, statusMarker?: string, privateContent = false, controlPersist = 0): { file: string; args: string[]; input?: string | Buffer; closeInput?: boolean } {
  validateWorkspace(workspace);
  // Windows has no tmux: Lectern runs Claude Code on macOS and Linux machines over SSH only.
  if (sshOnly(process.platform) && workspace.kind !== 'ssh') throw new Error(sshOnlyMessage());
  // GUI launch PATHs are often minimal. Do not source interactive shell startup files.
  const command = shellEnvironment(workspace.kind) + script;
  if (workspace.kind === 'ssh') {
    const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2'];
    if (sshConfigPath) args.push('-F', sshConfigPath);
    if (reuseExistingMaster) args.push('-o', 'ControlMaster=no');
    // OpenSSH treats zero as unlimited. Transport explicitly closes those masters at quit.
    else if (controlPath && process.platform !== 'win32') args.push('-o', 'ControlMaster=auto', '-o', `ControlPersist=${controlPersist}`, '-o', `ControlPath=${controlPath}`);
    if (workspace.port) args.push('-p', String(workspace.port));
    if (privateContent && input !== undefined) {
      // Keep the payload out of the remote command and the shell's here-document
      // storage. Only the script is in argv, and SSH streams the bytes on stdin.
      const commandWithStatus = statusMarker
        ? `(${command}\n)\nprintf '\\n%s%s\\n' ${quoteShell(statusMarker)} "$?"`
        : command;
      args.push(workspace.host!, 'exec sh -c ' + quoteShell(commandWithStatus));
      return { file: 'ssh', args, input, closeInput: true };
    }
    // OpenSSH sends the remote command and then three file descriptors over
    // its local mux socket. A full macOS socket can reject the fd transfer
    // with EMSGSIZE. Keep that command constant for every SSH operation.
    args.push(workspace.host!, 'exec sh -s');
    // stdin stays open while the command runs; closing it cancels the command (see remoteRequest).
    return { file: 'ssh', args, input: remoteRequest(command, input, statusMarker, true) };
  }
  return { file: '/bin/sh', args: ['-c', command], input };
}

export async function runCommand(workspace: Workspace, script: string, options: CommandOptions = {}): Promise<CommandResult> {
  let spawned: ChildProcessWithoutNullStreams | undefined, ended = false;
  const end = (confirmed: boolean) => { if (!ended) { ended = true; options.onSessionEnd?.(confirmed); } };
  try {
    return await diagnostic.operation('transport.command', { workspaceId: workspace.id, transport: workspace.kind, commandTag: options.tag ?? commandTag(script) }, async () => {
  // A one-off SSH session reports its command's status itself (see remoteRequest);
  // streamed downloads keep their bytes untouched.
  const marker = workspace.kind === 'ssh' && !options.output ? `__LECTERN_STATUS_${randomUUID()}__:` : undefined;
  const invocation = commandInvocation(workspace, script, options.controlPath, options.sshConfigPath, options.reuseExistingMaster, options.input, marker, options.privateContent, options.controlPersist);
  const started = performance.now();
  diagnostic.event('transport.command.request', { script: options.privateContent ? undefined : summarize(script), input: options.input === undefined || options.privateContent ? undefined : summarize(options.input),
    sshCommandBytes: workspace.kind === 'ssh' ? Buffer.byteLength(invocation.args.at(-1)!) : undefined,
    stdinBytes: options.privateContent ? undefined : invocation.input === undefined ? 0 : Buffer.byteLength(invocation.input),
    timeoutMs: options.timeoutMs ?? 20_000, maxBytes: options.maxBytes ?? 20 * 1024 * 1024 });
  return new Promise<CommandResult>((resolve, reject) => {
    options.signal?.throwIfAborted();
    // An SSH command is cancelled by closing its input (see remoteRequest), never by
    // killing the client: the remote command would keep running and keep its session.
    const ssh = invocation.file === 'ssh';
    // Cancellable local scans may have a find/awk pipeline. Killing only the shell
    // leaves its descendants walking the tree after the composer has moved on.
    const scanGroup = !!options.signal && !ssh;
    const child = spawned = spawn(invocation.file, invocation.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, signal: ssh ? undefined : options.signal, detached: scanGroup });
    whenGone(child, end);
    diagnostic.event('transport.command.spawned', { pid: child.pid }, 'debug');
    const output: Buffer[] = [], errors: Buffer[] = [];
    let size = 0, finished = false;
    // The command's own limit, plus the status line a one-off SSH session appends
    // ("\n<marker><status>\n"). Reads sized to the exact byte (maxBytes = n + 1)
    // otherwise failed whenever they went over a one-off session.
    const maxBytes = options.maxBytes ?? 20 * 1024 * 1024, limit = maxBytes + (marker ? marker.length + 5 : 0);
    const abort = () => fail(options.signal!.reason instanceof Error ? options.signal!.reason : new Error('Aborted'));
    const fail = (error: Error) => {
      if (finished) return;
      finished = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      if (ssh) hangUp(child, options.hangUpGraceMs);
      else if (scanGroup && child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ } }
      else child.kill();
      reject(error);
    };
    if (ssh) options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { diagnostic.event('transport.command.timeout', { timeoutMs: options.timeoutMs ?? 20_000, stdoutBytes: size }, 'warn'); fail(new Error(`${workspace.kind === 'ssh' ? 'SSH' : 'Local'} command timed out; no input is retried automatically`)); }, options.timeoutMs ?? 20_000);
    let written = Promise.resolve();
    if (options.output) {
      // Preserve pipe backpressure all the way through SSH. For file transfers
      // the timeout measures inactivity, so a long healthy download can finish.
      const count = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        timer.refresh();
        callback(size > (options.maxBytes ?? 20 * 1024 * 1024) ? new Error('File size changed during download') : null, chunk);
      } });
      written = pipeline(child.stdout, count, options.output);
      void written.catch(fail);
    } else {
      child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > limit) fail(new Error('Command output exceeded safety limit')); else output.push(chunk); });
    }
    child.stderr.on('data', (chunk: Buffer) => { if (errors.reduce((n, b) => n + b.length, 0) < 65536) errors.push(chunk); });
    child.on('error', fail);
    child.stdin.on('error', error => {
      // SSH may close stdin before we finish sending the script. Let its exit
      // and stderr report the connection error, including mux failures.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPIPE' && code !== 'ECONNRESET') fail(error);
    });
    child.on('close', async (code, signal) => {
      if (ssh) child.stdin.destroy();
      if (finished) return;
      try { await written; } catch { return; }
      if (finished) return;
      finished = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      const stderr = Buffer.concat(errors).toString('utf8');
      let stdout = Buffer.concat(output), status = code, reported: boolean | undefined;
      if (marker && code === 0) {
        const at = stdout.lastIndexOf(`\n${marker}`), rest = at < 0 ? '' : stdout.subarray(at + 1 + marker.length).toString('latin1');
        reported = /^\d{1,3}\n$/.test(rest);
        if (reported) { status = Number(rest.trim()); stdout = stdout.subarray(0, at); }
      }
      diagnostic.event('transport.command.exited', { code, status, reported, signal, durationMs: Math.round(performance.now() - started),
        ...(!options.privateContent && { stdoutBytes: size, stderrBytes: Buffer.byteLength(stderr), stderr: stderr.slice(0, 8192), stderrTruncated: stderr.length > 8192 }),
      }, status === 0 && reported !== false ? 'debug' : 'error');
      if (stdout.length > maxBytes) { reject(new Error('Command output exceeded safety limit')); return; }
      // No report: the command never ran (a jump host refused the session) or was
      // cut off. Never read that as an empty result; nothing is retried.
      const message = options.privateContent ? '' : stderr.trim();
      if (reported === false) reject(new Error(message || 'SSH session ended before its command reported a result'));
      else if (status !== 0) reject(new Error(message || `Command exited with status ${status}`));
      else resolve({ stdout, stderr });
    });
    if (ssh && !invocation.closeInput) child.stdin.write(invocation.input!);
    else child.stdin.end(invocation.input);
  });
    });
  } finally {
    // Nothing was started (invalid target, aborted first): no session to wait for.
    if (!spawned) end(true);
  }
}

function commandTag(script: string): string {
  for (const tag of ['capture-pane', 'load-buffer', 'paste-buffer', 'send-keys', 'new-session', 'set-option', 'delete-buffer']) if (script.includes(`'${tag}'`)) return `tmux.${tag}`;
  if (script.includes('count=0')) return 'history.discover';
  if (script.includes('size=$(wc')) return 'history.read';
  if (script.includes('ps -eo')) return 'tmux.probe';
  if (script.includes('pwd -P')) return 'workspace.locate';
  return 'shell.command';
}

const controlRoot = () => process.platform === 'darwin' ? '/tmp' : tmpdir();
function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
let staleSweep: Promise<void> | undefined;
/** Old per-launch directories are reclaimed once their owner is gone. */
export function closeStaleMasters(root?: string): Promise<void> {
  if (process.platform === 'win32') return Promise.resolve();
  if (root === undefined) return staleSweep ??= sweepStaleMasters(controlRoot());
  return sweepStaleMasters(root);
}
async function sweepStaleMasters(root: string): Promise<void> {
  const uid = process.getuid?.();
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (!/^lectern-ssh-[A-Za-z0-9]{6}$/.test(name)) continue;
    const directory = join(root, name);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o7777) !== 0o700) continue;
      const owner = Number(await readFile(join(directory, ownerFile), 'utf8'));
      if (!Number.isSafeInteger(owner) || owner < 2 || alive(owner)) continue;
      for (const socket of await sshControlSockets(directory)) await controlSocket(socket, 'exit');
      await rm(directory, { recursive: true, force: true });
      diagnostic.event('transport.ssh.stale_masters_closed', { directory: name });
    } catch { /* Older or foreign directory: leave it alone. */ }
  }
}

function sshControl(args: string[]): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn('ssh', args, { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 2000);
    const finish = (exists: boolean) => { clearTimeout(timer); resolve(exists); };
    child.on('error', () => finish(false)); child.on('exit', code => finish(code === 0));
  });
}

function controlSocket(path: string, operation: 'check' | 'exit'): Promise<boolean> {
  return sshControl(['-F', '/dev/null', '-S', path, '-O', operation, 'lectern-private']);
}

/** A command channel's place on its host, and whether a caller has claimed it to run next. */
interface ChannelEntry { place: SessionPlace; generation: number; claimed: boolean }
/** Per host: the sessions Lectern has open there, its command channels and their start-up back-off. */
interface HostState {
  abort: AbortController;
  clients: Set<Promise<unknown>>;
  sessions: HostSessions<CommandChannel>;
  channels: Map<CommandChannel, ChannelEntry>;
  opening: number; failures: number; retryAt: number;
  /** A command has succeeded over Lectern's own master, so the master is up. Until then a channel would
   * race the first command to create it: the loser opens a connection of its own (and logs in again). */
  connected: boolean;
}
/** How the next session to a host connects. */
interface Route { controlPath?: string; controlPersist?: number; reuseExistingMaster: boolean; mode: ConnectionMode }
export interface TransportOptions {
  /** Connection kinds whose commands run on persistent command channels (default: SSH). */
  channelKinds?: Workspace['kind'][];
  /** Connection kinds whose sessions count against the per-host limits (default: SSH). */
  sessionKinds?: Workspace['kind'][];
  /** Commands reuse a master the user's ssh_config already runs for the host (default).
   * When false Lectern uses only its own connections (see setReuseUserMasters). */
  reuseUserMasters?: boolean;
  /** Profiles with a userData path can keep their private masters across app restarts. */
  userData?: string;
  keepAliveSeconds?: number;
  controlRoot?: string;
  /** Sessions and channels per host for each connection mode (default defaultSessionLimits). */
  limits?: Record<ConnectionMode, { sessions: number; channels: number }>;
  channelIdleMs?: number;
  /** How long a hung-up SSH client may take to end by itself (see hang-up.ts). */
  hangUpGraceMs?: number;
  /** How long the session of a client that had to be killed still counts. */
  unconfirmedHoldMs?: number;
  /** Demo mode rehearses a slow or failing machine: an extra wait before each command
   * and, for a matching command tag, a failure instead of running it. */
  rehearsal?: (tag?: string) => { delayMs?: number; error?: string } | undefined;
}
const channelStartMs = 15_000;
const channelKey = (workspace: Workspace) => `${workspace.kind}:${workspace.host ?? ''}:${workspace.port ?? ''}`;
const masterKey = (workspace: Workspace) => `${workspace.host}:${workspace.port ?? ''}`;
const disposedError = () => new Error('Transport has been disposed');
const disconnectedError = () => new Error(t('backend.sshDisconnected'));

/** Control sockets stay local; authentication and known_hosts remain OpenSSH's job. */
export class Transport {
  private directory?: Promise<SshControlDirectory>;
  private exitDirectory?: Promise<SshControlDirectory>;
  /** Sockets adopted at startup, and targets encountered by routing or login. */
  private readonly masters = new Set<string>();
  private readonly masterTargets = new Map<string, Workspace>();
  private readonly existingMasters = new Map<string, Promise<boolean>>();
  private readonly disconnected = new Set<string>();
  private readonly disconnecting = new Map<string, Promise<void>>();
  private readonly reconnecting = new AsyncLocalStorage<string>();
  private readonly inputScope = new AsyncLocalStorage<{ key: string; signal: AbortSignal }>();
  private disposed = false;
  private readonly hosts = new Map<string, HostState>();
  private readonly channelKinds: ReadonlySet<Workspace['kind']>;
  private readonly sessionKinds: ReadonlySet<Workspace['kind']>;
  private readonly limits: Record<ConnectionMode, { sessions: number; channels: number }>;
  private readonly channelIdleMs: number;
  private readonly hangUpGraceMs: number;
  private readonly unconfirmedHoldMs: number;
  private reuseUserMasters: boolean;
  private keepAliveSeconds: number;
  /** Bumped when the connection setting changes: channels of an older generation are retired. */
  private generation = 0;
  private sweeper?: ReturnType<typeof setInterval>;
  private readonly platforms = new Map<string, Promise<void>>();
  private readonly rehearsal: TransportOptions['rehearsal'];
  private readonly userData?: string;
  private readonly controlRoot: string;
  constructor(private readonly sshConfigPath?: string, options: TransportOptions = {}) {
    this.rehearsal = options.rehearsal;
    // Every new SSH session repeats the handshake (≈300 ms through a relay); a
    // request on an open channel costs one round trip. LECTERN_SSH_CHANNEL=0 opts out.
    const kinds = process.env.LECTERN_SSH_CHANNEL === '0' || process.platform === 'win32' ? [] : options.channelKinds ?? ['ssh'];
    this.channelKinds = new Set(kinds);
    this.sessionKinds = new Set(options.sessionKinds ?? ['ssh']);
    this.limits = options.limits ?? defaultSessionLimits;
    this.channelIdleMs = options.channelIdleMs ?? 10 * 60_000;
    this.hangUpGraceMs = options.hangUpGraceMs ?? hangUpGraceMs;
    this.unconfirmedHoldMs = options.unconfirmedHoldMs ?? 30_000;
    this.reuseUserMasters = options.reuseUserMasters ?? true;
    this.userData = options.userData;
    this.keepAliveSeconds = options.keepAliveSeconds ?? (this.userData ? defaultSshConnectionPreferences.keepAliveSeconds : 0);
    this.controlRoot = options.controlRoot ?? controlRoot();
  }
  private host(workspace: Workspace): HostState {
    const key = channelKey(workspace);
    let state = this.hosts.get(key);
    if (!state) {
      // Kinds that are not counted (a local target) never wait; they keep the channel count.
      const limits = this.sessionKinds.has(workspace.kind) ? this.limits
        : { shared: { sessions: Infinity, channels: this.limits.shared.channels }, exclusive: { sessions: Infinity, channels: this.limits.exclusive.channels } };
      const created: HostState = { abort: new AbortController(), clients: new Set(), channels: new Map(), opening: 0, failures: 0, retryAt: 0, connected: false, sessions: undefined! };
      setMaxListeners(0, created.abort.signal);
      created.sessions = new HostSessions<CommandChannel>({ host: workspace.host, port: workspace.port }, {
        takeIdleChannel: () => this.takeIdleChannel(created),
        closeIdleChannel: () => this.yieldIdleChannel(created),
      }, limits);
      this.hosts.set(key, state = created);
    }
    return state;
  }
  private assertActive(workspace: Workspace, state?: HostState): void {
    if (this.disposed) throw disposedError();
    state?.abort.signal.throwIfAborted();
    const key = masterKey(workspace);
    const input = this.inputScope.getStore();
    if (workspace.kind === 'ssh' && input?.key === key) input.signal.throwIfAborted();
    if (workspace.kind === 'ssh' && this.disconnected.has(key) && this.reconnecting.getStore() !== key) throw disconnectedError();
  }
  private trackClient<T>(state: HostState, client: Promise<T>): Promise<T> {
    state.clients.add(client);
    const done = () => state.clients.delete(client);
    void client.then(done, done);
    return client;
  }
  private closeHost(state: HostState, error: Error): Promise<unknown> {
    state.abort.abort(error);
    state.sessions.drain();
    for (const channel of state.channels.keys()) channel.close(error.message);
    return Promise.allSettled(state.clients);
  }
  setKeepAliveSeconds(seconds: number): void { this.keepAliveSeconds = seconds; }
  withSshInput<T>(workspace: Workspace, input: () => Promise<T>): Promise<T> {
    this.assertActive(workspace);
    return this.inputScope.run({ key: masterKey(workspace), signal: this.host(workspace).abort.signal }, input);
  }

  /** Adopt sockets even for targets no longer listed in the app. A control check makes no network connection. */
  async initializeSsh(): Promise<void> {
    if (!this.userData || process.platform === 'win32') return;
    const directory = await this.controlDirectory();
    if (!directory.persistent) return;
    await Promise.all((await sshControlSockets(directory.path)).map(async socket => {
      if (await controlSocket(socket, 'check')) this.masters.add(socket);
    }));
  }

  isSshDisconnected(workspace: Workspace): boolean {
    return workspace.kind === 'ssh' && this.disconnected.has(masterKey(workspace));
  }
  async sshMasterState(workspace: Workspace): Promise<SshMasterState> {
    if (this.isSshDisconnected(workspace)) return 'disconnected';
    if (process.platform === 'win32') return 'none';
    for (;;) {
      const reuse = this.reuseUserMasters;
      const key = masterKey(workspace), cached = this.existingMasters.get(key);
      const cachedShared = cached && await cached;
      const shared = reuse && (!cached || cachedShared) && await this.checkMaster(workspace);
      const own = !shared && (await this.livePrivatePaths(workspace)).length > 0;
      if (this.isSshDisconnected(workspace)) return 'disconnected';
      if (reuse !== this.reuseUserMasters) continue;
      if (!shared && cachedShared && this.existingMasters.get(key) === cached) this.existingMasters.delete(key);
      if (own) this.masterTargets.set(key, workspace);
      return shared ? 'user' : own ? 'private' : 'none';
    }
  }
  async disconnectSsh(workspace: Workspace, confirm: () => { terminal: boolean; input: boolean } | undefined): Promise<SshDisconnectResult> {
    const status = await this.sshMasterState(workspace);
    if (status !== 'private' || this.isSshDisconnected(workspace)) return this.isSshDisconnected(workspace) ? 'disconnected' : status;
    const busy = confirm();
    if (busy) return busy;
    const key = masterKey(workspace), hostKey = channelKey(workspace);
    this.disconnected.add(key);
    const state = this.hosts.get(hostKey);
    this.hosts.delete(hostKey);
    this.platforms.delete(hostKey);
    this.existingMasters.delete(key);
    const closing = (async () => {
      if (state) await this.closeHost(state, disconnectedError());
      const paths = await this.livePrivatePaths(workspace);
      const closed = await Promise.all(paths.map(async path => await this.controlMaster(workspace, path, 'exit') || !await this.checkMaster(workspace, path)));
      if (closed.includes(false)) {
        this.disconnected.delete(key);
        throw new Error(t('backend.sshDisconnectFailed'));
      }
      this.masterTargets.delete(key);
    })();
    this.disconnecting.set(key, closing);
    try { await closing; }
    finally { this.disconnecting.delete(key); }
    return 'disconnected';
  }
  async reconnectSsh<T>(workspace: Workspace, connect: () => Promise<T>): Promise<T> {
    const key = masterKey(workspace);
    await this.disconnecting.get(key);
    if (!this.disconnected.has(key)) return connect();
    // Only this explicit connection attempt may reach the target while it is disconnected.
    const result = await this.reconnecting.run(key, connect);
    this.disconnected.delete(key);
    return result;
  }
  /** Frees a stream's or command's place once its client is gone. A client that had to
   * be killed may leave its session open on the target: that place is kept a while longer. */
  private releaseWhenEnded(place: SessionPlace, workspace: Workspace) {
    return (confirmed: boolean) => {
      if (confirmed) { place.release(); return; }
      diagnostic.event('transport.session.unconfirmed', { host: workspace.host, port: workspace.port, use: place.use, holdMs: this.unconfirmedHoldMs }, 'warn');
      setTimeout(() => place.release(), this.unconfirmedHoldMs).unref?.();
    };
  }
  /**
   * Whether commands reuse a master the user's ssh_config already runs (shared with their
   * terminals and editors) or only Lectern's own connections. Applies to connections made
   * from now on: Lectern's command channels close (busy ones after their current command)
   * and reopen over the new route; when sharing again, Lectern's private master for a host
   * with a user master stops accepting new sessions and exits once its last one (such as
   * a terminal takeover) ends. The user's own masters are never touched.
   */
  async setReuseUserMasters(reuse: boolean): Promise<void> {
    if (this.disposed || reuse === this.reuseUserMasters) return;
    this.reuseUserMasters = reuse;
    this.generation++;
    this.existingMasters.clear();
    diagnostic.event('transport.ssh.connection_setting', { reuseUserMasters: reuse });
    for (const state of this.hosts.values())
      for (const [channel, entry] of state.channels) if (channel.usable && !entry.claimed) channel.close('connection setting changed');
    if (!reuse || !this.directory) return;
    await Promise.all([...this.masterTargets].map(async ([key, workspace]) => {
      if (!await this.hasExistingMaster(workspace)) return;
      this.masterTargets.delete(key);
      const state = this.hosts.get(channelKey(workspace));
      if (state) state.connected = false;
      if (this.isSshDisconnected(workspace)) return;
      await Promise.all((await this.privatePaths()).map(path => this.controlMaster(workspace, path, 'stop')));
      diagnostic.event('transport.ssh.private_master_stopped', { host: workspace.host, port: workspace.port });
    }));
  }
  /** `ssh -O <operation>` for one of Lectern's masters. */
  private controlMaster(workspace: Workspace, controlPath: string | undefined, operation: 'check' | 'exit' | 'stop'): Promise<boolean> {
    const invocation = commandInvocation(workspace, '', undefined, this.sshConfigPath, true);
    invocation.args.pop();
    if (controlPath) invocation.args.splice(-1, 0, '-o', `ControlPath=${controlPath}`);
    invocation.args.splice(-1, 0, '-O', operation);
    return sshControl(invocation.args);
  }
  /** How the next session to this host connects; the host's limits follow it. */
  private async route(workspace: Workspace, state: HostState): Promise<Route> {
    for (;;) {
      this.assertActive(workspace, state);
      const reuse = this.reuseUserMasters;
      let route: Route = { reuseExistingMaster: false, mode: 'exclusive' };
      if (workspace.kind === 'ssh' && process.platform !== 'win32') {
        if (reuse && await this.hasExistingMaster(workspace)) route = { reuseExistingMaster: true, mode: 'shared' };
        else {
          const { path, seconds } = await this.privateRoute(workspace);
          route = { controlPath: path, controlPersist: seconds, reuseExistingMaster: false, mode: 'exclusive' };
        }
      }
      this.assertActive(workspace, state);
      // The setting changed meanwhile: decide again.
      if (reuse !== this.reuseUserMasters) continue;
      if (route.controlPath) this.masterTargets.set(masterKey(workspace), workspace);
      state.sessions.setMode(route.mode);
      return route;
    }
  }
  /** `ssh -O check` against the user's configured ControlPath, or against ours. Never connects. */
  private checkMaster(workspace: Workspace, controlPath?: string): Promise<boolean> {
    return this.controlMaster(workspace, controlPath, 'check');
  }
  private hasExistingMaster(workspace: Workspace): Promise<boolean> {
    const key = `${workspace.host}:${workspace.port ?? ''}`;
    let check = this.existingMasters.get(key);
    if (!check) {
      check = this.checkMaster(workspace);
      this.existingMasters.set(key, check);
    }
    return check;
  }
  private controlDirectory() {
    if (!this.directory) {
      void closeStaleMasters(this.controlRoot === controlRoot() ? undefined : this.controlRoot);
      this.directory = privateSshDirectory(this.controlRoot, this.userData);
    }
    return this.directory;
  }
  private async privatePaths(): Promise<string[]> {
    const directories = await Promise.all([this.directory, this.exitDirectory]);
    return directories.flatMap(directory => directory ? [join(directory.path, '%C')] : []);
  }
  private async livePrivatePaths(workspace: Workspace): Promise<string[]> {
    const paths = await this.privatePaths();
    const live = await Promise.all(paths.map(path => this.checkMaster(workspace, path)));
    return paths.filter((_, i) => live[i]);
  }
  private async privateRoute(workspace: Workspace) {
    const directory = await this.controlDirectory(), path = join(directory.path, '%C');
    if (!directory.persistent) return { path, seconds: 0 };
    const seconds = this.keepAliveSeconds;
    if (seconds === 0) {
      // Keep the stable path bounded even if the existing master expires before ssh attaches.
      if (await this.checkMaster(workspace, path)) return { path, seconds: defaultSshConnectionPreferences.keepAliveSeconds };
      // A zero-timeout master needs explicit cleanup even if the setting changes before quit.
      this.exitDirectory ??= privateSshDirectory(this.controlRoot);
      return { path: join((await this.exitDirectory).path, '%C'), seconds: 0 };
    }
    if (this.exitDirectory) {
      const temporary = join((await this.exitDirectory).path, '%C');
      if (await this.checkMaster(workspace, temporary)) return { path: temporary, seconds: 0 };
    }
    return { path, seconds };
  }
  /** ssh_config's multiplexing for this host (`ssh -G` prints it without connecting). */
  private configuredMultiplexing(workspace: Workspace): Promise<{ path?: string; persists: boolean }> {
    return new Promise(resolve => {
      const args = ['-G', ...(this.sshConfigPath ? ['-F', this.sshConfigPath] : []), ...(workspace.port ? ['-p', String(workspace.port)] : []), workspace.host!];
      const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      let output = '';
      const timer = setTimeout(() => { child.kill(); resolve({ persists: false }); }, 5000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { if (output.length < 262_144) output += chunk; });
      child.on('error', () => { clearTimeout(timer); resolve({ persists: false }); });
      child.on('close', code => {
        clearTimeout(timer);
        const value = (key: string) => code === 0 ? output.match(new RegExp(`^${key} (.+)$`, 'm'))?.[1]?.trim().toLowerCase() : undefined;
        const raw = code === 0 ? output.match(/^controlpath (.+)$/m)?.[1]?.trim() : undefined;
        const path = raw && raw.toLowerCase() !== 'none' ? raw : undefined;
        const master = value('controlmaster'), persist = value('controlpersist');
        resolve({ path, persists: !!path && !!master && master !== 'false' && master !== 'no' && !!persist && persist !== 'no' && persist !== '0' });
      });
    });
  }
  /**
   * Authenticate interactively once and leave a multiplexed master in the background.
   * Prompts (password, one-time code, new host key) go to `answer`.
   * - Reusing the user's connections, and ssh_config already multiplexes with
   *   ControlPersist: log in exactly as a terminal would; the user's own persistence
   *   applies and Lectern never closes that master. (`true` runs as one short session
   *   on it, outside Lectern's session count.)
   * - Otherwise (including whenever Lectern uses only its own connections) Lectern
   *   uses its own private path and idle timeout: `-f -N` opens no session.
   * Later commands keep BatchMode and simply reuse the master.
   */
  async login(target: { host?: string; port?: number }, answer: AnswerPrompt, signal?: AbortSignal): Promise<'existing' | 'connected'> {
    const workspace = validateWorkspace({ id: 'ssh-login', name: 'SSH login', kind: 'ssh', cwd: '/', host: target?.host, port: target?.port });
    return this.reconnectSsh(workspace, () => this.loginNow(workspace, answer, signal));
  }
  private async loginNow(workspace: Workspace, answer: AnswerPrompt, signal?: AbortSignal): Promise<'existing' | 'connected'> {
    this.assertActive(workspace);
    if (process.platform === 'win32') throw new Error(t('backend.winLoginUnsupported'));
    const state = this.host(workspace);
    signal = signal ? AbortSignal.any([signal, state.abort.signal]) : state.abort.signal;
    const key = masterKey(workspace), reuse = this.reuseUserMasters;
    this.existingMasters.delete(key);
    if (reuse && await this.hasExistingMaster(workspace)) { signal.throwIfAborted(); return 'existing'; }
    const { path: privatePath, seconds } = await this.privateRoute(workspace);
    if (await this.checkMaster(workspace, privatePath)) {
      signal.throwIfAborted();
      this.masterTargets.set(key, workspace);
      state.connected = true;
      return 'existing';
    }
    const multiplexing = reuse ? await this.configuredMultiplexing(workspace) : { persists: false, path: undefined };
    const userPath = multiplexing.persists ? multiplexing.path : undefined;
    const common = ['-T', '-o', 'BatchMode=no', '-o', 'StrictHostKeyChecking=ask', '-o', 'ConnectTimeout=15',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '-o', 'ClearAllForwardings=yes', ...(this.sshConfigPath ? ['-F', this.sshConfigPath] : [])];
    const destination = [...(workspace.port ? ['-p', String(workspace.port)] : []), workspace.host!];
    // The user's own ControlMaster/ControlPersist take over once `true` has run.
    const args = userPath ? [...common, ...destination, 'true']
      : ['-f', '-N', ...common, '-o', 'ControlMaster=yes', '-o', `ControlPersist=${seconds}`, '-o', `ControlPath=${privatePath}`, ...destination];
    signal.throwIfAborted();
    diagnostic.event('transport.ssh.login.start', { host: workspace.host, port: workspace.port, master: userPath ? 'user' : 'private', reuseUserMasters: reuse });
    if (!userPath) this.masterTargets.set(key, workspace);
    await this.trackClient(state, runInteractiveLogin({ command: { file: 'ssh', args }, answer, signal }));
    state.failures = 0; state.retryAt = 0; state.connected = true;
    // The foreground ssh exits once authenticated; the socket follows immediately.
    for (let attempt = 0; attempt < 30; attempt++) {
      signal.throwIfAborted();
      this.existingMasters.delete(key);
      if (userPath ? await this.hasExistingMaster(workspace) : await this.checkMaster(workspace, privatePath)) {
        signal.throwIfAborted();
        diagnostic.event('transport.ssh.login.connected', { host: workspace.host, port: workspace.port });
        return 'connected';
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(t('backend.loginNoMaster'));
  }
  /**
   * A long-lived shell on the target whose stdin stays open, over the same
   * multiplexed connection as run(). `script` reads its own commands from stdin.
   * It holds a session place on the host until its client has exited (a terminal
   * takeover waits for one like any command).
   */
  async stream(workspace: Workspace, script: string): Promise<ChildProcessWithoutNullStreams> {
    this.assertActive(workspace);
    const state = this.host(workspace);
    await this.supported(workspace, state);
    await this.route(workspace, state);
    const { place } = await state.sessions.acquire('terminal', { signal: state.abort.signal });
    // The connection setting may have changed while waiting.
    let route: Route;
    try { route = await this.route(workspace, state); this.assertActive(workspace, state); } catch (error) { place!.release(); throw error; }
    return this.spawnStream(workspace, script, route, state, place!);
  }
  private spawnStream(workspace: Workspace, script: string, route: Route, state: HostState, place: SessionPlace): ChildProcessWithoutNullStreams {
    const invocation = commandInvocation(workspace, script, route.controlPath, this.sshConfigPath, route.reuseExistingMaster, undefined, undefined, false, route.controlPersist);
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(invocation.file, invocation.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch (error) { place.release(); throw error; }
    const abort = () => hangUp(child, this.hangUpGraceMs);
    const release = this.releaseWhenEnded(place, workspace);
    if (workspace.kind === 'ssh') state.abort.signal.addEventListener('abort', abort, { once: true });
    void this.trackClient(state, new Promise<void>(resolve => whenGone(child, confirmed => {
      state.abort.signal.removeEventListener('abort', abort);
      release(confirmed);
      resolve();
    })));
    // The remote `exec sh -s` reads exactly this first command and is replaced by
    // the loop, which then owns the rest of stdin. Nothing else is written until
    // the loop reports that it is ready, so no later line is consumed early.
    if (workspace.kind === 'ssh') child.stdin.write(`exec /bin/sh -c ${quoteShell(shellEnvironment() + script)}\n`);
    return child;
  }
  /**
   * An SSH target must run macOS or Linux; asked once per host (`uname -s`) before
   * its first command. Only a definite answer is kept: a failed connection asks again.
   */
  private supported(workspace: Workspace, state: HostState): Promise<void> {
    if (workspace.kind !== 'ssh') return Promise.resolve();
    const key = channelKey(workspace);
    let check = this.platforms.get(key);
    if (!check) {
      const refuse = (system: string) => new UnsupportedTargetError(unsupportedTargetMessage(workspace.host ?? '', system));
      check = this.unchecked(workspace, state, 'uname -s', { tag: 'ssh.platform', timeoutMs: 20_000, maxBytes: 4096 }).then(({ stdout }) => {
        const system = targetSystem(stdout.toString());
        if (!system.supported) throw refuse(system.system);
      }, error => {
        // cmd.exe or PowerShell cannot even start the POSIX shell Lectern asks for.
        if (windowsShellFailure(error instanceof Error ? error.message : String(error))) throw refuse('Windows');
        throw error;
      });
      check.catch(error => { if (!(error instanceof UnsupportedTargetError) && this.platforms.get(key) === check) this.platforms.delete(key); });
      this.platforms.set(key, check);
    }
    return check;
  }
  async run(workspace: Workspace, script: string, options: CommandOptions = {}): Promise<CommandResult> {
    this.assertActive(workspace);
    const state = this.host(workspace);
    const rehearsal = this.rehearsal?.(options.tag);
    if (rehearsal?.delayMs && rehearsal.delayMs > 0) await new Promise(resolve => setTimeout(resolve, rehearsal.delayMs));
    if (rehearsal?.error) throw new Error(rehearsal.error);
    this.assertActive(workspace, state);
    await this.supported(workspace, state);
    return this.unchecked(workspace, state, script, options);
  }
  private async unchecked(workspace: Workspace, state: HostState, script: string, options: CommandOptions = {}): Promise<CommandResult> {
    await this.route(workspace, state);
    // Cancellable scans and streamed downloads keep their own session: aborting
    // one must not cost a warm channel.
    const channelOk = this.channelKinds.has(workspace.kind) && !options.signal && !options.output && !options.privateContent;
    const signal = workspace.kind !== 'ssh' ? options.signal : options.signal ? AbortSignal.any([options.signal, state.abort.signal]) : state.abort.signal;
    for (;;) {
      this.assertActive(workspace, state);
      let channel = channelOk ? this.idleChannel(workspace) : undefined, place: SessionPlace | undefined;
      if (!channel) {
        // A free place, or (waiting in line) whichever comes first: a place or an idle channel.
        const grant = await state.sessions.acquire('command', { channelOk, signal });
        try { this.assertActive(workspace, state); } catch (error) {
          grant.place?.release(); if (grant.channel) this.unclaim(state, grant.channel); throw error;
        }
        ({ channel, place } = grant);
      }
      if (channel) {
        try { return await this.runOnChannel(workspace, state, channel, script, options); }
        catch (error) {
          // Nothing was sent when the channel was unavailable: try again.
          if (error instanceof ChannelUnavailable) continue;
          if (workspace.kind === 'ssh') this.existingMasters.delete(masterKey(workspace));
          throw error;
        }
      }
      let route: Route;
      // The connection setting may have changed while waiting.
      try { route = await this.route(workspace, state); this.assertActive(workspace, state); } catch (error) { place!.release(); throw error; }
      if (workspace.kind === 'ssh') diagnostic.event('transport.ssh.connection', { host: workspace.host, port: workspace.port, mode: route.reuseExistingMaster ? 'existing-user-master' : 'private-master' }, 'debug');
      try {
        // The place is freed when the session has ended on the target, which may be after this settles.
        const release = this.releaseWhenEnded(place!, workspace);
        let end!: () => void;
        if (workspace.kind === 'ssh') void this.trackClient(state, new Promise<void>(resolve => { end = resolve; }));
        const result = await runCommand(workspace, script, { ...options, signal, controlPath: route.controlPath, controlPersist: route.controlPersist, reuseExistingMaster: route.reuseExistingMaster,
          sshConfigPath: this.sshConfigPath, hangUpGraceMs: this.hangUpGraceMs, onSessionEnd: confirmed => { release(confirmed); end?.(); } });
        state.connected = true;
        return result;
      } catch (error) {
        // A user may authenticate a new master after a failed attempt, or their
        // old master may disappear. Reinspect on the next explicit operation;
        // never replay the failed command (especially terminal input).
        if (workspace.kind === 'ssh' && !signal?.aborted) this.existingMasters.delete(masterKey(workspace));
        throw error;
      }
    }
  }
  /** A ready idle channel claimed for the caller, or undefined (one may then be opened in the background). */
  private idleChannel(workspace: Workspace): CommandChannel | undefined {
    const state = this.host(workspace);
    const channel = this.takeIdleChannel(state);
    if (!channel) this.startChannel(workspace, state);
    return channel;
  }
  private takeIdleChannel(state: HostState): CommandChannel | undefined {
    for (const [channel, entry] of state.channels) {
      if (!channel.usable || entry.claimed || entry.generation !== this.generation) continue;
      entry.claimed = true;
      return channel;
    }
  }
  private unclaim(state: HostState, channel: CommandChannel): void {
    const entry = state.channels.get(channel);
    if (entry) { entry.claimed = false; this.channelIdle(state, channel); }
  }
  /** Close the least recently used idle channel so a waiting session gets its place. */
  private yieldIdleChannel(state: HostState): SessionPlace | undefined {
    let oldest: [CommandChannel, ChannelEntry] | undefined;
    for (const item of state.channels) if (item[0].usable && !item[1].claimed && (!oldest || item[0].lastUsed < oldest[0].lastUsed)) oldest = item;
    if (!oldest) return;
    oldest[0].close('yielded its session to a waiting command');
    return oldest[1].place;
  }
  /** A channel finished a request or opened: hand it to a waiting command, or retire it. */
  private channelIdle(state: HostState, channel: CommandChannel): void {
    const entry = state.channels.get(channel);
    if (!entry || entry.claimed || !channel.usable) return;
    if (entry.generation !== this.generation) { channel.close('connection setting changed'); return; }
    state.sessions.pump();
  }
  /** Start channels ahead of the first command, e.g. when a target is shown. */
  warmChannels(workspace: Workspace): void {
    if (this.disposed || this.isSshDisconnected(workspace) || !this.channelKinds.has(workspace.kind)) return;
    const state = this.host(workspace);
    void this.route(workspace, state).then(() => this.startChannel(workspace, state), () => {});
  }
  /**
   * Open one more channel in the background when none is idle and there is room: one
   * at a time (a burst while the first starts must not open the whole pool), never past
   * the mode's channel count, never ahead of a waiting session, never into the last
   * free place, and over Lectern's own master only once it is up.
   */
  private startChannel(workspace: Workspace, state: HostState): void {
    if (this.disposed || state.abort.signal.aborted || this.isSshDisconnected(workspace) || !this.channelKinds.has(workspace.kind) || state.opening || state.channels.size >= state.sessions.channelLimit || Date.now() < state.retryAt) return;
    // Lectern's own master is made by the first session over it (ControlMaster=auto): wait for that.
    if (workspace.kind === 'ssh' && process.platform !== 'win32' && state.sessions.mode === 'exclusive' && !state.connected) return;
    for (const [channel, entry] of state.channels) if (channel.usable && !entry.claimed && entry.generation === this.generation) return;
    const place = state.sessions.tryReserve('channel', 1);
    if (place) void this.openChannel(workspace, state, place);
  }
  private async openChannel(workspace: Workspace, state: HostState, place: SessionPlace): Promise<void> {
    state.opening++;
    const nonce = randomBytes(16).toString('hex'), started = performance.now(), generation = this.generation;
    const where = { transport: workspace.kind, host: workspace.host, port: workspace.port };
    try {
      let child: ChildProcessWithoutNullStreams;
      try {
        const route = await this.route(workspace, state);
        this.assertActive(workspace, state);
        // The connection setting changed meanwhile: the next command opens one over the new route.
        if (generation !== this.generation) { place.release(); return; }
        child = this.spawnStream(workspace, channelScript(nonce), route, state, place);
      } catch (error) { place.release(); throw error; }
      const channel = await CommandChannel.open(child, nonce, channelStartMs, {
        onClose: (closed, reason) => {
          state.channels.delete(closed);
          diagnostic.event('transport.channel.closed', { ...where, reason: reason.slice(0, 500), channels: state.channels.size }, 'debug');
        },
        onIdle: idle => this.channelIdle(state, idle),
      });
      if (this.disposed || state.abort.signal.aborted || generation !== this.generation) { channel.close('connection retired'); return; }
      state.channels.set(channel, { place, generation, claimed: false });
      state.failures = 0;
      this.sweeper ??= setInterval(() => this.closeIdleChannels(), Math.min(60_000, this.channelIdleMs));
      this.sweeper.unref?.();
      diagnostic.event('transport.channel.opened', { ...where, durationMs: Math.round(performance.now() - started), channels: state.channels.size, mode: state.sessions.mode });
      this.channelIdle(state, channel);
    } catch (error) {
      state.failures++;
      const retryInMs = Math.min(5 * 60_000, 15_000 * 2 ** (state.failures - 1));
      state.retryAt = Date.now() + retryInMs;
      diagnostic.event('transport.channel.failed', { ...where, error: error instanceof Error ? error.message.slice(0, 500) : String(error), retryInMs }, 'warn');
    } finally { state.opening--; }
  }
  private closeIdleChannels(): void {
    const now = Date.now();
    for (const state of this.hosts.values())
      for (const [channel, entry] of state.channels) if (channel.usable && !entry.claimed && now - channel.lastUsed > this.channelIdleMs) channel.close('idle');
  }
  private runOnChannel(workspace: Workspace, state: HostState, channel: CommandChannel, script: string, options: CommandOptions): Promise<CommandResult> {
    return diagnostic.operation('transport.command', { workspaceId: workspace.id, transport: workspace.kind, commandTag: options.tag ?? commandTag(script), route: 'channel' }, async () => {
      const request = remoteRequest(shellEnvironment(workspace.kind) + script, options.input);
      const started = performance.now();
      const timeoutMs = options.timeoutMs ?? 20_000, maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
      diagnostic.event('transport.command.request', { script: summarize(script), input: options.input === undefined ? undefined : summarize(options.input),
        stdinBytes: Buffer.byteLength(request), timeoutMs, maxBytes, channel: true });
      const entry = state.channels.get(channel);
      if (entry) entry.claimed = false;
      const result = await channel.run(request, { timeoutMs, maxBytes,
        timeoutMessage: `${workspace.kind === 'ssh' ? 'SSH' : 'Local'} command timed out; no input is retried automatically` });
      diagnostic.event('transport.command.exited', { code: result.code, signal: null, durationMs: Math.round(performance.now() - started), stdoutBytes: result.stdout.length,
        stderrBytes: Buffer.byteLength(result.stderr), stderr: result.stderr.slice(0, 8192), stderrTruncated: result.stderr.length > 8192, channel: true }, result.code === 0 ? 'debug' : 'error');
      if (result.code !== 0) throw new Error(result.stderr.trim() || `Command exited with status ${result.code}`);
      return { stdout: result.stdout, stderr: result.stderr };
    });
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.sweeper);
    await Promise.all([...this.hosts].map(([key, state]) => {
      const closing = this.closeHost(state, disposedError());
      return key.startsWith('ssh:') ? closing : undefined;
    }));
    this.hosts.clear();
    await Promise.allSettled(this.disconnecting.values());
    if (!this.directory) return;
    for (const directory of await Promise.all([this.directory, this.exitDirectory])) {
      if (!directory || (directory.persistent && this.keepAliveSeconds !== 0)) continue;
      // Include adopted sockets and newly created masters even when a host was removed.
      const sockets = new Set([...(directory.persistent ? this.masters : []), ...await sshControlSockets(directory.path)]);
      await Promise.all([...sockets].map(socket => controlSocket(socket, 'exit')));
      if (!directory.persistent) {
        await Promise.all([...this.masterTargets.values()].map(workspace => this.controlMaster(workspace, join(directory.path, '%C'), 'exit')));
        await rm(directory.path, { recursive: true, force: true });
      }
    }
  }
}
