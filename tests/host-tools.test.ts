import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHostProbe } from '../src/backend/host-probe';
import {
  CLAUDE_INSTALL, claudeHints, compareVersions, isMissingToolsError, linuxFamily, missingTools, missingToolsMessage,
  outdatedClaude, systemLabel, tmuxHints, toolList, versionNumber, type HostTools,
} from '../src/shared/host-tools';
import { setLocale, translate } from '../src/shared/i18n';
import { probeReply, type ProbeFields } from './helpers/host-probe';

const tools = (fields: ProbeFields = {}) => parseHostProbe(probeReply(fields));
const mac = (managers: string[], fields: ProbeFields = {}) => tools({ system: 'Darwin', arch: 'arm64', osVersion: '15.1', osRelease: {}, managers, ...fields });
const linux = (ID: string, ID_LIKE = '', managers: string[] = [], fields: ProbeFields = {}) => tools({ osRelease: { ID, ID_LIKE }, managers, ...fields });
const commands = (list: { command: string }[]) => list.map(hint => hint.command);

test('the probe reply is parsed into the system, package managers and both tools', () => {
  const ubuntu = parseHostProbe('Welcome to the lab\n' + probeReply({ managers: ['apt-get', 'npm'] }));
  assert.deepEqual(ubuntu, {
    system: 'Linux', arch: 'x86_64', osVersion: '24.04', distro: ['ubuntu', 'debian'], distroName: 'Ubuntu 24.04 LTS',
    managers: ['apt-get', 'npm'], root: false,
    tmux: { path: '/usr/bin/tmux', version: 'tmux 3.4' }, claude: { path: '/home/dev/.local/bin/claude', version: '2.1.329 (Claude Code)' },
  });
  assert.equal(systemLabel(ubuntu), 'Ubuntu 24.04 LTS (x86_64)');
  const macOS = mac(['brew']);
  assert.equal(systemLabel(macOS), 'macOS 15.1 (arm64)');
  assert.deepEqual(macOS.distro, []);
  assert.deepEqual(missingTools(macOS), []);
});

test('a missing tool is reported with what was found outside the PATH, and several nvm installs as ambiguous', () => {
  const bare = tools({ tmux: null, claude: null, uid: '0', extra: ['tmux.elsewhere=/opt/local/bin/tmux',
    'claude.ambiguous=/home/dev/.nvm/versions/node/v20.1.0/bin/claude', 'claude.ambiguous=/home/dev/.nvm/versions/node/v22.3.0/bin/claude'] });
  assert.deepEqual(missingTools(bare), ['tmux', 'claude']);
  assert.equal(bare.root, true);
  assert.deepEqual(bare.tmux, { elsewhere: ['/opt/local/bin/tmux'] });
  assert.equal(bare.claude.ambiguous?.length, 2);
  // Only an absolute path counts as found.
  assert.deepEqual(missingTools(tools({ claude: 'claude' })), ['claude']);
});

test('an incomplete reply is a failed check, never a missing tool', () => {
  assert.throws(() => parseHostProbe(''), /incomplete/);
  assert.throws(() => parseHostProbe(probeReply().replace('end\n', '')), /incomplete/);
  assert.throws(() => parseHostProbe('tmux.path=\nclaude.path=\nend\n'), /incomplete/);
});

test('tmux install commands fit the system: Homebrew on macOS, the distribution package manager on Linux', () => {
  assert.deepEqual(commands(tmuxHints(mac(['brew']))), ['brew install tmux']);
  assert.deepEqual(commands(tmuxHints(mac(['port']))), ['sudo port install tmux']);
  const noBrew = commands(tmuxHints(mac([])));
  assert.match(noBrew[0], /Homebrew\/install\/HEAD\/install\.sh/, 'without Homebrew, install it first');
  assert.equal(noBrew[1], 'brew install tmux');
  assert.deepEqual(commands(tmuxHints(linux('ubuntu', 'debian', ['apt-get']))), ['sudo apt install tmux']);
  assert.deepEqual(commands(tmuxHints(linux('debian'))), ['sudo apt install tmux']);
  assert.deepEqual(commands(tmuxHints(linux('linuxmint', 'ubuntu debian'))), ['sudo apt install tmux']);
  assert.deepEqual(commands(tmuxHints(linux('debian', '', [], { uid: '0' }))), ['apt install tmux'], 'root needs no sudo');
  assert.deepEqual(commands(tmuxHints(linux('fedora', '', ['dnf']))), ['sudo dnf install tmux']);
  assert.deepEqual(commands(tmuxHints(linux('rhel', 'fedora', ['dnf', 'yum']))), ['sudo dnf install tmux']);
  assert.deepEqual(commands(tmuxHints(linux('rocky', 'rhel centos fedora'))), ['sudo dnf install tmux']);
  assert.deepEqual(commands(tmuxHints(linux('centos', 'rhel fedora', ['yum']))), ['sudo yum install tmux'], 'yum where there is no dnf');
  assert.deepEqual(commands(tmuxHints(linux('opensuse-leap', 'suse opensuse'))), ['sudo zypper install tmux']);
  assert.deepEqual(commands(tmuxHints(linux('arch'))), ['sudo pacman -S tmux']);
  assert.deepEqual(commands(tmuxHints(linux('alpine'))), ['sudo apk add tmux']);
  // No os-release: the package manager present decides.
  assert.equal(linuxFamily(tools({ osRelease: {}, managers: ['dnf'] })), 'fedora');
  assert.deepEqual(commands(tmuxHints(tools({ osRelease: {}, managers: ['apt-get'] }))), ['sudo apt install tmux']);
  assert.deepEqual(tmuxHints(tools({ osRelease: { ID: 'nixos' }, managers: [] })), [], 'unknown: the notice says to use the package manager');
  assert.deepEqual(tmuxHints(tools({ system: 'FreeBSD', osRelease: {}, managers: [] })), []);
  assert.equal(tmuxHints(linux('ubuntu'))[0].label, 'hostTools.viaManager');
  assert.deepEqual(tmuxHints(linux('ubuntu'))[0].params, { manager: 'apt' });
});

test('Claude Code: the official installer everywhere, plus Homebrew or npm where present, and a link for an off-PATH install', () => {
  assert.deepEqual(commands(claudeHints(linux('ubuntu'))), [CLAUDE_INSTALL]);
  assert.equal(CLAUDE_INSTALL, 'curl -fsSL https://claude.ai/install.sh | bash');
  assert.deepEqual(commands(claudeHints(mac(['brew', 'npm']))), [CLAUDE_INSTALL, 'brew install --cask claude-code', 'npm install -g @anthropic-ai/claude-code@latest']);
  assert.deepEqual(commands(claudeHints(linux('alpine', '', ['apk']))), ['sudo apk add bash curl', CLAUDE_INSTALL], 'the installer needs bash and curl on Alpine');
  const offPath = claudeHints(tools({ claude: null, extra: ['claude.elsewhere=/home/dev/.npm-global/bin/claude'] }));
  assert.equal(offPath[0].command, 'mkdir -p ~/.local/bin && ln -s /home/dev/.npm-global/bin/claude ~/.local/bin/claude');
  assert.deepEqual(offPath[0].params, { path: '/home/dev/.npm-global/bin/claude' });
  const nvm = claudeHints(tools({ claude: null, extra: ["claude.ambiguous=/home/dev/my nvm/versions/node/v22.3.0/bin/claude"] }));
  assert.equal(nvm[0].label, 'hostTools.pickNvm');
  assert.equal(nvm[0].command, "mkdir -p ~/.local/bin && ln -s '/home/dev/my nvm/versions/node/v22.3.0/bin/claude' ~/.local/bin/claude");
  assert.equal(commands(tmuxHints(tools({ tmux: null, extra: ['tmux.elsewhere=/opt/local/bin/tmux'] })))[0],
    'mkdir -p ~/.local/bin && ln -s /opt/local/bin/tmux ~/.local/bin/tmux');
});

test('versions older than the oldest tested Claude Code only warn', () => {
  assert.equal(versionNumber('2.1.329 (Claude Code)'), '2.1.329');
  assert.equal(versionNumber('tmux 3.4'), undefined);
  assert.ok(compareVersions('2.1.99', '2.1.300') < 0);
  assert.ok(compareVersions('2.2.0', '2.1.300') > 0);
  assert.equal(compareVersions('2.1.300', '2.1.300'), 0);
  assert.equal(outdatedClaude(tools({ claudeVersion: '2.1.250 (Claude Code)' })), '2.1.250');
  assert.equal(outdatedClaude(tools({ claudeVersion: '2.1.300 (Claude Code)' })), undefined);
  assert.equal(outdatedClaude(tools({ claudeVersion: 'garbled' })), undefined, 'an unreadable version is not a warning');
  assert.equal(outdatedClaude(tools({ claude: null })), undefined);
});

test('the refusal names the machine and what is missing, and is recognized in either language', () => {
  assert.equal(toolList(['tmux', 'claude']), 'tmux 和 Claude Code');
  const remote = missingToolsMessage('gpu-box', ['tmux']), local = missingToolsMessage(undefined, ['tmux', 'claude']);
  assert.match(remote, /^gpu-box 上找不到 tmux。/);
  assert.match(local, /^本机找不到 tmux 和 Claude Code。/);
  assert.ok(isMissingToolsError(remote) && isMissingToolsError(local));
  setLocale('en');
  try {
    const english = missingToolsMessage(undefined, ['claude']);
    assert.match(english, /^Claude Code not found on this computer\. /);
    assert.ok(isMissingToolsError(english));
    assert.equal(toolList(['tmux', 'claude']), 'tmux and Claude Code');
  } finally { setLocale('zh-CN'); }
  assert.ok(isMissingToolsError(`Error invoking remote method 'lectern:discover': Error: ${translate('en', 'hostTools.missingNote')}`));
  assert.ok(!isMissingToolsError('tmux is not installed on the target machine') && !isMissingToolsError(undefined));
});

/** A PATH without tmux and claude: every other system command, linked into one directory. */
async function sandbox() {
  const { mkdtemp, mkdir, readdir, realpath, symlink, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const root = await realpath(await mkdtemp('/tmp/lectern-host-probe-'));
  const sys = join(root, 'sys'), tools = join(root, 'tools'), home = join(root, 'home');
  await Promise.all([mkdir(sys), mkdir(tools), mkdir(join(home, 'bin'), { recursive: true })]);
  for (const directory of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
    for (const name of await readdir(directory).catch(() => [] as string[])) {
      if (name === 'tmux' || name === 'claude') continue;
      await symlink(join(directory, name), join(sys, name)).catch(() => { /* listed by an earlier directory */ });
    }
  }
  const tool = (directory: string, name: string, output: string) =>
    writeFile(join(directory, name), `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(output)}\n`, { mode: 0o755 });
  return { root, sys, tools, home, tool, path: `${tools}:${sys}` };
}

test('the probe script runs with the launch PATH and finds only what is on it', { skip: process.platform === 'win32' ? 'POSIX shell' : false }, async () => {
  const { rm } = await import('node:fs/promises');
  const { runCommand } = await import('../src/backend/transport');
  const { hostProbeScript } = await import('../src/backend/host-probe');
  const box = await sandbox(), saved = { path: process.env.LECTERN_LOCAL_PATH, home: process.env.HOME };
  const local = { id: 'probe', name: 'probe', kind: 'local' as const, cwd: '/' };
  const probe = async (options = {}) => parseHostProbe((await runCommand(local, hostProbeScript(options), { timeoutMs: 20_000 })).stdout.toString());
  try {
    process.env.LECTERN_LOCAL_PATH = box.path; process.env.HOME = box.home;
    const bare = await probe();
    assert.deepEqual(missingTools(bare), ['tmux', 'claude']);
    assert.equal(bare.system, process.platform === 'darwin' ? 'Darwin' : 'Linux');
    assert.equal(bare.root, process.getuid?.() === 0);
    // Installed where a non-login shell does not look: reported, still missing.
    await box.tool(`${box.home}/bin`, 'tmux', 'tmux 3.5a');
    assert.deepEqual((await probe()).tmux, { elsewhere: [`${box.home}/bin/tmux`] });
    await box.tool(box.tools, 'tmux', 'tmux 3.5a');
    await box.tool(box.tools, 'claude', '2.1.250 (Claude Code)');
    const found = await probe();
    assert.deepEqual(found.tmux, { path: `${box.tools}/tmux`, version: 'tmux 3.5a' });
    assert.deepEqual(found.claude, { path: `${box.tools}/claude`, version: '2.1.250 (Claude Code)' });
    assert.equal(outdatedClaude(found), '2.1.250');
    // A stand-in Claude (tests, the demo) is looked up but never run.
    const double = await probe({ claude: `${box.tools}/tmux`, version: false });
    assert.deepEqual(double.claude, { path: `${box.tools}/tmux` });
  } finally {
    if (saved.path === undefined) delete process.env.LECTERN_LOCAL_PATH; else process.env.LECTERN_LOCAL_PATH = saved.path;
    process.env.HOME = saved.home;
    await rm(box.root, { recursive: true, force: true });
  }
});

/** A backend whose target answers the host check with `reply` and stops every other command. */
async function gatedBackend(reply: () => string | Error) {
  const { Backend } = await import('../src/backend');
  const backend = new Backend({ claudeCommand: 'false' });
  const tags: (string | undefined)[] = [];
  (backend as any).transport.run = async (_workspace: unknown, _script: string, options: { tag?: string } = {}) => {
    tags.push(options.tag);
    if (options.tag !== 'host.tools') throw new Error('reached the target command');
    const answer = reply();
    if (answer instanceof Error) throw answer;
    return { stdout: Buffer.from(answer), stderr: '' };
  };
  return { backend, tags };
}
const remote = { id: 'remote', name: 'remote', kind: 'ssh' as const, host: 'gpu-box', cwd: '/srv/work' };

test('one host check per machine, kept until a recheck; a check that could not connect is asked again', async () => {
  let answer: string | Error = probeReply();
  const { backend, tags } = await gatedBackend(() => answer);
  try {
    const first = await backend.checkHost({ kind: 'ssh', host: 'gpu-box' });
    assert.ok(first.ok && !missingTools(first.tools).length);
    await backend.checkHost({ kind: 'ssh', host: 'gpu-box' });
    assert.deepEqual(tags, ['host.tools'], 'a known machine is not probed again');
    answer = probeReply({ tmux: null });
    const recheck = await backend.checkHost({ kind: 'ssh', host: 'gpu-box' }, true);
    assert.ok(recheck.ok && missingTools(recheck.tools).join() === 'tmux');
    await backend.checkHost({ kind: 'ssh', host: 'gpu-box', port: 2222 });
    assert.equal(tags.length, 3, 'another port is another machine');
    answer = new Error('dev@192.0.2.10: Permission denied (publickey).');
    assert.deepEqual(await backend.checkHost({ kind: 'ssh', host: 'lab' }), { ok: false, message: 'dev@192.0.2.10: Permission denied (publickey).' });
    answer = probeReply();
    assert.ok((await backend.checkHost({ kind: 'ssh', host: 'lab' })).ok, 'a failed check is not kept');
    answer = 'garbage';
    assert.deepEqual(await backend.checkHost({ kind: 'ssh', host: 'half' }), { ok: false, message: 'The host check returned an incomplete reply' });
    await assert.rejects(backend.checkHost({ kind: 'ssh', host: '-oProxyCommand=x' }));
  } finally { await backend.dispose(); }
});

test('session lists need tmux, new and resumed chats need both; a refusal says what to install', async () => {
  let answer: string | Error = probeReply({ tmux: null, claude: null });
  const { backend, tags } = await gatedBackend(() => answer);
  try {
    await assert.rejects(backend.discover(remote), (error: Error) => error.name === 'HostToolsError' && /^gpu-box 上找不到 tmux 和 Claude Code。/.test(error.message));
    await assert.rejects(backend.createSession(remote), { name: 'HostToolsError' });
    await assert.rejects(backend.probeModelCatalog(remote), { name: 'HostToolsError' });
    assert.deepEqual(tags, ['host.tools'], 'nothing else runs on the machine');
    answer = probeReply({ claude: null });
    await backend.checkHost(remote, true);
    // History can still be listed without Claude Code; starting one cannot.
    await assert.rejects(backend.discover(remote), /reached the target command/);
    await assert.rejects(backend.createSession(remote), (error: Error) => error.name === 'HostToolsError' && /找不到 Claude Code/.test(error.message));
    await assert.rejects(backend.resumeSession(remote, '00000000-0000-4000-8000-000000000000'), { name: 'HostToolsError' });
  } finally { await backend.dispose(); }
});

test('a check that cannot connect fails as the connection error; one that only timed out does not block', async () => {
  let answer: string | Error = new Error('dev@192.0.2.10: Permission denied (publickey).');
  const { backend } = await gatedBackend(() => answer);
  try {
    await assert.rejects(backend.discover(remote), (error: Error) => error.name === 'Error' && error.message === 'dev@192.0.2.10: Permission denied (publickey).');
    answer = new Error('SSH command timed out; no input is retried automatically');
    await assert.rejects(backend.discover(remote), /reached the target command/);
  } finally { await backend.dispose(); }
});

test('the window keeps one status per machine; a failed check is never shown as a missing tool', async () => {
  const { checkHostTools, ensureHostTools, hostMissing, hostToolsStatus, noteFolderRead } = await import('../src/renderer/host-tools');
  const { machineConnection, sshMachineKey } = await import('../src/renderer/ssh-machines');
  const asked: string[] = [];
  let reply = (host: string) => host === 'down' ? { ok: false as const, message: 'ssh: connect to host down port 22: No route to host' }
    : { ok: true as const, tools: tools(host === 'bare' ? { tmux: null, claude: null } : {}) };
  (globalThis as any).window = { desktop: { checkHost: async (target: { kind: string; host?: string }, force: boolean) => {
    asked.push(`${target.host ?? target.kind}${force ? '!' : ''}`);
    return reply(target.host ?? 'local');
  } } };
  try {
    const bare = { kind: 'ssh' as const, host: 'bare' };
    const [a, b] = [checkHostTools(bare), checkHostTools(bare)];
    assert.equal(hostToolsStatus(bare)?.state, 'checking');
    assert.equal(await a, await b, 'one request at a time per machine');
    assert.equal(hostToolsStatus(bare)?.state, 'missing');
    assert.deepEqual(hostMissing(hostToolsStatus(bare)), ['tmux', 'claude']);
    // Rechecking keeps what is missing on screen until the answer arrives.
    reply = () => ({ ok: true, tools: tools() });
    const recheck = checkHostTools(bare, { force: true });
    assert.deepEqual(hostMissing(hostToolsStatus(bare)), ['tmux', 'claude']);
    assert.equal((await recheck).state, 'ok');
    reply = host => host === 'down' ? { ok: false as const, message: 'ssh: connect to host down port 22: No route to host' } : { ok: true as const, tools: tools() };
    const down = { kind: 'ssh' as const, host: 'down' };
    assert.equal((await checkHostTools(down)).state, 'failed');
    assert.deepEqual(hostMissing(hostToolsStatus(down)), []);
    assert.equal(machineConnection(sshMachineKey('down'))?.state, 'unreachable', 'the connection problem goes to the machine status');
    asked.length = 0;
    // Going to a machine: unknown or failed ones are checked, missing ones rechecked, known good ones left alone.
    ensureHostTools(down); ensureHostTools(bare); ensureHostTools({ kind: 'local' });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(asked.sort(), ['down', 'local']);
    noteFolderRead({ kind: 'local' });
    noteFolderRead({ kind: 'ssh', host: 'other' }, new Error('当前目录不存在'));
    noteFolderRead({ kind: 'ssh', host: 'third' }, new Error(missingToolsMessage('third', ['tmux'])));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(asked.slice(2), ['third'], 'only a refusal for a missing tool asks an unknown machine');
  } finally { delete (globalThis as any).window; }
});
