import { spawn } from './child-fds';
import { randomBytes } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { diagnostic } from '../diagnostics';
import { t } from '../shared/i18n';

/** How the login dialog asks for one OpenSSH prompt. */
export type SshPromptKind = 'secret' | 'text' | 'hostkey' | 'confirm' | 'info';
export interface SshPrompt {
  kind: SshPromptKind;
  /** The prompt exactly as OpenSSH wrote it, for example "Verification code: ". */
  text: string;
  /** Recent server messages (banner, keyboard-interactive instructions). */
  context?: string;
}
/** Resolve with the reply, or null to cancel the login. */
export type AnswerPrompt = (prompt: SshPrompt) => Promise<string | null>;

export function classifyPrompt(text: string, askpassKind = ''): SshPromptKind {
  if (askpassKind === 'none') return 'info';
  if (askpassKind === 'confirm') return 'confirm';
  if (/\(yes\/no(?:\/\[fingerprint\])?\)\?\s*$/i.test(text)) return 'hostkey';
  if (/pass(?:word|phrase)|密码|口令|\bpin\b/i.test(text)) return 'secret';
  return 'text';
}

// OpenSSH runs SSH_ASKPASS once per prompt with the prompt as argv[1] and reads
// the reply from stdout. The helper forwards it to this process over a private
// socket; only a holder of the per-login token is answered.
const helperSource = `const net = require('net');
const prompt = process.argv[2] || '';
const socket = net.connect(process.env.LECTERN_ASKPASS_SOCKET);
let buffer = '';
process.exitCode = 1;
socket.setEncoding('utf8');
socket.on('connect', () => socket.write(JSON.stringify({ token: process.env.LECTERN_ASKPASS_TOKEN, prompt, kind: process.env.SSH_ASKPASS_PROMPT || '' }) + '\\n'));
socket.on('data', chunk => {
  buffer += chunk;
  const end = buffer.indexOf('\\n');
  if (end < 0) return;
  socket.end();
  try {
    const reply = JSON.parse(buffer.slice(0, end));
    if (typeof reply.answer === 'string') { process.stdout.write(reply.answer + '\\n'); process.exitCode = 0; }
  } catch {}
});
socket.on('error', () => {});
`;

export interface AskpassNodeOptions {
  platform?: NodeJS.Platform;
  execPath?: string;
  /** Electron's own answer (content::CHILD_PROCESS_EXE); undefined outside Electron. */
  helperExecPath?: string;
  isExecutable?: (file: string) => boolean;
}

function isExecutableFile(file: string): boolean {
  try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; }
}

/**
 * The executable that runs the askpass helper with ELECTRON_RUN_AS_NODE=1.
 * On macOS the app's own executable belongs to a regular app (no LSUIElement):
 * run as Node it still puts a second Lectern icon in the Dock for a moment, once
 * per prompt. Electron's base helper is LSUIElement, is signed with the same
 * hardened-runtime entitlements (JIT included), and is what Electron's own
 * child_process.fork runs Node in on macOS (process.helperExecPath). Its name
 * follows the executable's, not the bundle's, so this also finds it in a renamed
 * bundle and in Electron.app during development:
 *   X.app/Contents/MacOS/<exe> → X.app/Contents/Frameworks/<exe> Helper.app/Contents/MacOS/<exe> Helper
 * The (Renderer), (GPU) and (Plugin) variants are for Chromium's child processes.
 * Elsewhere, and if no helper is found, the executable itself.
 */
export function askpassNode({
  platform = process.platform, execPath = process.execPath,
  helperExecPath = (process as { helperExecPath?: string }).helperExecPath, isExecutable = isExecutableFile,
}: AskpassNodeOptions = {}): string {
  if (platform !== 'darwin') return execPath;
  const bundle = /^(.+\.app)\/Contents\/MacOS\/([^/]+)$/.exec(execPath);
  const derived = bundle && `${bundle[1]}/Contents/Frameworks/${bundle[2]} Helper.app/Contents/MacOS/${bundle[2]} Helper`;
  for (const candidate of [derived, helperExecPath]) if (candidate && candidate !== execPath && isExecutable(candidate)) return candidate;
  return execPath;
}

/**
 * OpenSSH before 8.4 ignores SSH_ASKPASS_REQUIRE and uses askpass only when
 * DISPLAY is set. An unknown version is treated as old.
 */
export function askpassNeedsDisplay(version: string): boolean {
  const match = /OpenSSH_(\d+)\.(\d+)/.exec(version);
  return !match || Number(match[1]) * 100 + Number(match[2]) < 804;
}

function sshVersion(file: string): Promise<string> {
  return new Promise(resolve => {
    let output = '';
    const child = spawn(file, ['-V'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => child.kill(), 5000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk: Buffer) => { if (output.length < 4096) output += chunk.toString(); });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('close', () => { clearTimeout(timer); resolve(output); });
  });
}

export interface LoginCommand { file: string; args: string[] }
export interface LoginOptions {
  /** ssh argv for the master: destination last, no remote command. */
  command: LoginCommand;
  answer: AnswerPrompt;
  /** Executable that runs the helper script with Node semantics (default askpassNode()). */
  node?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const maxAnswer = 4096;

/**
 * Run `ssh -f -N` with every prompt routed to `answer`. Resolves once OpenSSH has
 * authenticated and moved the master to the background; rejects with its error.
 */
export async function runInteractiveLogin({ command, answer, node = askpassNode(), signal, timeoutMs = 5 * 60_000 }: LoginOptions): Promise<void> {
  signal?.throwIfAborted();
  // A short path: Unix socket names are limited to 104 bytes on macOS.
  const directory = await mkdtemp(join(process.platform === 'win32' ? process.env.TEMP ?? '.' : '/tmp', 'lectern-login-'));
  const token = randomBytes(24).toString('hex');
  const socketPath = join(directory, 'askpass.sock');
  const helper = join(directory, 'askpass.cjs'), wrapper = join(directory, 'askpass');
  const sockets = new Set<Socket>();
  let stderr = '';
  let cancelled = false;
  const context = () => stderr.split('\n').map(line => line.trimEnd()).filter(line => line && !/^Warning: Permanently added/.test(line)).slice(-8).join('\n').slice(-800) || undefined;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', async (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) { if (buffer.length > 16_384) socket.destroy(); return; }
      let request: { token?: unknown; prompt?: unknown; kind?: unknown };
      try { request = JSON.parse(buffer.slice(0, end)); } catch { socket.destroy(); return; }
      buffer = '';
      if (request.token !== token || typeof request.prompt !== 'string') { socket.destroy(); return; }
      const kind = classifyPrompt(request.prompt, typeof request.kind === 'string' ? request.kind : '');
      diagnostic.event('ssh.login.prompt', { kind }, 'debug');
      let reply: string | null = null;
      try { reply = cancelled ? null : await answer({ kind, text: request.prompt.slice(0, 4000), context: context() }); }
      catch { reply = null; }
      if (reply !== null && (typeof reply !== 'string' || reply.length > maxAnswer || /[\r\n\0]/.test(reply))) reply = null;
      if (reply === null && kind !== 'info') cancelled = true;
      socket.end(JSON.stringify(reply === null ? { cancel: true } : { answer: reply }) + '\n');
    });
    socket.on('error', () => {});
  });
  try {
    await writeFile(helper, helperSource, { mode: 0o600 });
    await writeFile(wrapper, '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$LECTERN_ASKPASS_NODE" "$LECTERN_ASKPASS_HELPER" "$@"\n', { mode: 0o700 });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => resolve()); });
    await chmod(socketPath, 0o600).catch(() => {});
    // `ssh -f` backgrounds this very process, so the master (and a ControlPersist
    // master that outlives Lectern) keeps this environment. The askpass variables
    // are inert once the directory is gone: a later prompt fails closed. A made-up
    // DISPLAY would not be: with ForwardX11, every session multiplexed over the
    // master (for a master from ssh_config, the user's own terminals too) would set
    // up X11 forwarding to it.
    const env: NodeJS.ProcessEnv = {
      ...process.env, SSH_ASKPASS: wrapper, SSH_ASKPASS_REQUIRE: 'force',
      LECTERN_ASKPASS_NODE: node, LECTERN_ASKPASS_HELPER: helper, LECTERN_ASKPASS_SOCKET: socketPath, LECTERN_ASKPASS_TOKEN: token,
    };
    if (!env.DISPLAY && askpassNeedsDisplay(await sshVersion(command.file))) env.DISPLAY = ':0';
    // An abort while asking for the version would otherwise go unnoticed.
    if (signal?.aborted) throw new Error(t('backend.loginCancelled'));
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command.file, command.args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env });
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        // The backgrounded master may inherit stderr; stop reading it either way.
        child.stderr.destroy();
        if (error) reject(error); else resolve();
      };
      const abort = () => { cancelled = true; child.kill(); finish(new Error(t('backend.loginCancelled'))); };
      const timer = setTimeout(() => { child.kill(); finish(new Error(t('backend.loginTimeout'))); }, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { if (stderr.length < 32_768) stderr += chunk; });
      child.on('error', error => finish(error));
      child.on('exit', code => {
        if (code === 0) finish();
        else finish(new Error(cancelled ? t('backend.loginCancelled') : context()?.split('\n').at(-1) || t('backend.loginFailed', { code: String(code) })));
      });
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
    // The directory holds only the helper and socket, never a reply.
    await rm(directory, { recursive: true, force: true });
  }
}
