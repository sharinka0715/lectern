import { spawn } from './child-fds';
import { randomBytes } from 'node:crypto';
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

export interface LoginCommand { file: string; args: string[] }
export interface LoginOptions {
  /** ssh argv for the master: destination last, no remote command. */
  command: LoginCommand;
  answer: AnswerPrompt;
  /** Executable that runs the helper script with Node semantics. */
  node?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const maxAnswer = 4096;

/**
 * Run `ssh -f -N` with every prompt routed to `answer`. Resolves once OpenSSH has
 * authenticated and moved the master to the background; rejects with its error.
 */
export async function runInteractiveLogin({ command, answer, node = process.execPath, signal, timeoutMs = 5 * 60_000 }: LoginOptions): Promise<void> {
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
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command.file, command.args, {
        stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
        env: {
          ...process.env, SSH_ASKPASS: wrapper, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || ':0',
          LECTERN_ASKPASS_NODE: node, LECTERN_ASKPASS_HELPER: helper, LECTERN_ASKPASS_SOCKET: socketPath, LECTERN_ASKPASS_TOKEN: token,
        },
      });
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
