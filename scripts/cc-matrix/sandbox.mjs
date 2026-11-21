// An isolated world for one Claude Code version: a temporary HOME whose
// ~/.local/bin/claude is that version (the desktop app and its shell environment
// put ~/.local/bin first on PATH, so this is how the app finds it; no other
// `claude` is reachable), a private CLAUDE_CONFIG_DIR with first-run state
// pre-seeded, a private tmux server (TMUX_TMPDIR; TMUX/TMUX_PANE unset), and an
// environment built from scratch: the fake API as ANTHROPIC_BASE_URL and as the
// HTTP(S) proxy, a fake API key, no OAuth tokens or cloud-provider variables, and
// the user's real ~/.claude never mentioned. Nothing here sets CLAUDE_CODE_AUTO_MODE_SERVER:
// as with Lectern, auto mode's check is to run on the server, which the fake API (a
// gateway to Claude Code) never does; the matrix's folders and the probes choose
// the local check where they need it (scenarios.mjs prepareFolders, probe --local).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The tmux session prefix the app gives its own panes (src/backend/index.ts). The only
// place the harness spells it, so a rename touches one line.
export const SESSION_PREFIX = 'lectern-';
export const API_KEY = 'sk-ant-ccm-fake-0000'; // 20 characters: Claude Code remembers approvals by the last 20.
const SYSTEM_PATH = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
// Tools that may live elsewhere (Homebrew on macOS): linked into the sandbox's bin.
const LINKED_TOOLS = ['tmux', 'git'];
const which = name => (process.env.PATH ?? '').split(':').map(dir => path.join(dir, name)).find(file => existsSync(file));

export async function createSandbox({ version, binary, api, label = version }) {
  const base = process.platform === 'darwin' ? '/tmp' : os.tmpdir();
  const root = await realpath(await mkdtemp(path.join(base, `ccm-${label.replace(/[^0-9a-z.]/gi, '')}-`)));
  const dirs = { home: path.join(root, 'home'), config: path.join(root, 'claude-config'), work: path.join(root, 'work'), profile: path.join(root, 'profile'), bin: path.join(root, 'bin'), tmux: path.join(root, 'tmux') };
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true, mode: 0o700 });
  await mkdir(path.join(dirs.home, '.local', 'bin'), { recursive: true });
  await symlink(binary, path.join(dirs.home, '.local', 'bin', 'claude'));
  // node for helper scripts, without the directory that may also hold the user's claude.
  await symlink(process.execPath, path.join(dirs.bin, 'node'));
  // Outbound SSH (git fetching a plugin marketplace) cannot use the HTTP proxy: refuse it here.
  await writeFile(path.join(dirs.bin, 'ssh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${path.join(root, 'blocked-ssh.log')}'\necho 'cc-matrix sandbox: ssh is disabled' >&2\nexit 255\n`, { mode: 0o755 });
  for (const tool of LINKED_TOOLS) {
    const found = which(tool);
    if (found) await symlink(await realpath(found), path.join(dirs.bin, tool));
    else if (tool === 'tmux') throw new Error('tmux is not installed');
  }
  // A system directory holding another claude (e.g. a global npm install) stays off PATH.
  const systemPath = SYSTEM_PATH.filter(dir => existsSync(dir) && !existsSync(path.join(dir, 'claude')));

  const env = {
    HOME: dirs.home, USER: os.userInfo().username, LOGNAME: os.userInfo().username, SHELL: '/bin/sh',
    PATH: [path.join(dirs.home, '.local', 'bin'), dirs.bin, ...systemPath].join(':'),
    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TERM: 'xterm-256color', TZ: process.env.TZ || 'UTC',
    TMPDIR: process.env.TMPDIR || '/tmp',
    TMUX_TMPDIR: dirs.tmux,
    CLAUDE_CONFIG_DIR: dirs.config,
    ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: API_KEY,
    HTTP_PROXY: api.url, HTTPS_PROXY: api.url, http_proxy: api.url, https_proxy: api.url, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_BUG_COMMAND: '1',
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1', CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
  };
  // Display and session bus for Electron (xvfb-run provides DISPLAY and XAUTHORITY).
  for (const name of ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'ELECTRON_MIRROR'])
    if (process.env[name]) env[name] = process.env[name];

  await seedConfig(dirs, version);
  const tmuxBin = path.join(dirs.bin, 'tmux');
  // The harness's tmux client gets the whole sandbox environment (TMUX_TMPDIR included, TMUX
  // unset): whoever starts the private server hands its environment to every pane made in it
  // later, the app's too (the app's new-session passes none of its own). subagent-elsewhere starts
  // the server when the app has no pane left; with only PATH, HOME and LANG, a chat the app
  // opened while that server lived ran Claude Code without the API key, base URL and proxy
  // ("Not logged in", no request reached the fake API).
  const tmux = (...args) => {
    try { return execFileSync(tmuxBin, args, { env, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); }
    catch { return ''; }
  };
  return {
    version, root, ...dirs, env, tmux,
    /** The app's own panes (session names start with SESSION_PREFIX). */
    panes: () => tmux('list-panes', '-a', '-F', '#{pane_id} #{session_name}').split('\n').filter(line => line.split(' ')[1]?.startsWith(SESSION_PREFIX)).map(line => line.split(' ')[0]),
    capture: pane => pane ? tmux('capture-pane', '-p', '-t', pane) : '',
    projectFiles: async () => listJsonl(dirs.config),
    /** Outbound SSH attempts the stub refused (destination arguments). */
    blockedSsh: async () => (await readFile(path.join(root, 'blocked-ssh.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean),
    /** Close the private tmux server and make sure every process it ran is gone.
     * Returns the processes that outlived it (a bug in what was tested). */
    async close({ keep = false } = {}) {
      // Only the private server (its own TMUX_TMPDIR socket), never the default one;
      // processes are checked and stopped by exact PID, never by name.
      const server = Number(tmux('display-message', '-p', '#{pid}').trim());
      const tracked = server > 1 ? descendants(server) : [];
      tmux('kill-server');
      const leftovers = await reap(tracked);
      if (!keep) for (let i = 0; i < 5; i++) { try { await rm(root, { recursive: true, force: true }); break; } catch { await new Promise(resolve => setTimeout(resolve, 300)); } }
      return leftovers;
    },
  };
}

function processTable() {
  try {
    return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { maxBuffer: 16 * 1024 * 1024 }).toString().split('\n')
      .map(line => /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line)).filter(Boolean).map(([, pid, ppid, command]) => ({ pid: +pid, ppid: +ppid, command }));
  } catch { return []; }
}

/** The process `root` and everything below it, as a snapshot of exact PIDs. */
export function descendants(root) {
  const table = processTable(), found = new Map([[root, table.find(row => row.pid === root)?.command ?? '']]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of table) if (found.has(row.ppid) && !found.has(row.pid)) { found.set(row.pid, row.command); grew = true; }
  }
  return [...found].map(([pid, command]) => ({ pid, command }));
}

/** Wait for these exact processes to exit; stop the ones that do not (TERM, then KILL)
 * and report them. A PID is only signalled while it still runs the same command. */
export async function reap(tracked) {
  const alive = () => {
    const now = new Map(processTable().map(row => [row.pid, row.command]));
    return tracked.filter(item => now.get(item.pid) === item.command);
  };
  for (let i = 0; i < 20 && alive().length; i++) await new Promise(resolve => setTimeout(resolve, 250));
  const leftovers = alive();
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const item of alive()) { try { process.kill(item.pid, signal); } catch {} }
    for (let i = 0; i < 8 && alive().length; i++) await new Promise(resolve => setTimeout(resolve, 250));
  }
  return leftovers.map(item => ({ pid: item.pid, command: item.command.slice(0, 160) }));
}

/** First-run state a logged-in user already has: onboarding done, the API key
 * approved, the working folder trusted. A second folder stays untrusted for the
 * trust scenario. */
async function seedConfig(dirs, version) {
  const project = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, projectOnboardingSeenCount: 1, allowedTools: [] };
  await writeFile(path.join(dirs.config, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true, lastOnboardingVersion: version, lastReleaseNotesSeen: version, numStartups: 3, theme: 'dark', autoUpdates: false,
    hasSeenTasksHint: true, hasUsedBackslashReturn: true, shiftEnterKeyBindingInstalled: true, hasAcknowledgedCostThreshold: true,
    hasSeenEffortMediumNudge: true,
    // No auto-mode flags and no permission default: the app itself must get past
    // auto-mode prompts and start its sessions in auto mode.
    customApiKeyResponses: { approved: [API_KEY.slice(-20)], rejected: [] },
    projects: { [dirs.work]: project },
  }, null, 2));
  await writeFile(path.join(dirs.config, 'settings.json'), JSON.stringify({ autoUpdates: false }, null, 2));
}

async function listJsonl(config) {
  const projects = path.join(config, 'projects');
  const out = [];
  try {
    const { readdir } = await import('node:fs/promises');
    for (const dir of await readdir(projects)) for (const name of await readdir(path.join(projects, dir))) if (name.endsWith('.jsonl')) out.push(path.join(projects, dir, name));
  } catch {}
  return out;
}

export async function readJsonl(file) {
  return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return undefined; } }).filter(Boolean);
}
