import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';

const sharedTmp = process.platform === 'win32' ? undefined : realpathSync('/tmp');

export function privateTmux(directory, { name = 'default', env = process.env, executable = 'tmux' } = {}) {
  if (!directory || !path.isAbsolute(directory) || path.resolve(directory) === '/tmp') {
    throw new Error(`Expected an absolute private tmux directory: ${directory}`);
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..') throw new Error(`Invalid tmux socket name: ${name}`);
  const dir = path.resolve(directory);
  const socketDir = path.join(dir, `tmux-${process.getuid?.() ?? 0}`);
  const socket = path.join(socketDir, name);
  const childEnv = { ...env, TMUX_TMPDIR: dir };
  delete childEnv.TMUX;
  delete childEnv.TMUX_PANE;

  const exists = () => {
    if (lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) return false;
    if (sharedTmp && realpathSync(dir) === sharedTmp) throw new Error(`Expected a private tmux directory: ${dir}`);
    return true;
  };
  const args = (...command) => {
    if (!exists()) throw new Error(`Private tmux directory is missing: ${dir}`);
    if (!lstatSync(socketDir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Private tmux socket directory is missing: ${socketDir}`);
    return ['-S', socket, ...command];
  };
  const run = command => execFileSync(executable, command, {
    env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  }).toString();
  const hasSocketDir = () => exists() && lstatSync(socketDir, { throwIfNoEntry: false })?.isDirectory() === true;
  const killSocket = target => {
    if (!hasSocketDir() || !lstatSync(target, { throwIfNoEntry: false })?.isSocket()) return;
    try { run(['-S', target, 'kill-server']); }
    catch (error) {
      // The last pane can exit between checking the socket and reaching tmux.
      if (error.status !== 1 || !/no server running|Connection refused|No such file/.test(String(error.stderr))) throw error;
    }
  };
  const kill = () => killSocket(socket);
  return {
    dir, socket, env: childEnv, exists, args,
    tmux: (...command) => run(args(...command)),
    kill,
    killAll() {
      if (!hasSocketDir()) return;
      for (const entry of readdirSync(socketDir, { withFileTypes: true })) {
        if (entry.isSocket()) killSocket(path.join(socketDir, entry.name));
      }
    },
    cleanup() {
      kill();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

export function createPrivateTmux(directory, options) {
  const fixture = privateTmux(directory, options);
  // tmux creates this parent for an implicit socket, but requires it for -S.
  mkdirSync(fixture.dir, { recursive: true, mode: 0o700 });
  if (!fixture.exists()) throw new Error(`Expected a private tmux directory: ${fixture.dir}`);
  mkdirSync(path.dirname(fixture.socket), { mode: 0o700, recursive: true });
  fixture.args();
  return fixture;
}
