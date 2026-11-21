import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { access, appendFile, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Backend, commandInvocation, projectSlug, runCommand } from '../src/backend';
import { Transport, type CommandOptions } from '../src/backend/transport';
import type { Workspace } from '../src/shared/types';
import { uploadAttachment } from '../src/backend/attachment-upload';

const exec = promisify(execFile);
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test('SSH invocation keeps local config and destination as independent argv and pins host keys', () => {
  const workspace: Workspace = { id: 'ssh-test', name: 'SSH', kind: 'ssh', cwd: '/tmp', host: 'dev-alias', port: 2222 };
  const invocation = commandInvocation(workspace, "printf '%s' 'hello'", '/tmp/control-%C', '/tmp/config with spaces');
  assert.equal(invocation.file, 'ssh');
  assert.equal(invocation.args[invocation.args.indexOf('-F') + 1], '/tmp/config with spaces');
  assert.ok(invocation.args.includes('StrictHostKeyChecking=yes'));
  assert.ok(invocation.args.includes('BatchMode=yes'));
  assert.ok(invocation.args.includes('2222'));
  assert.equal(invocation.args.at(-2), 'dev-alias');
  assert.equal(invocation.args.at(-1), 'exec sh -s');
  const reused = commandInvocation(workspace, 'printf reuse', undefined, '/tmp/config with spaces', true);
  assert.ok(reused.args.includes('ControlMaster=no'));
  assert.equal(reused.args.some(arg => arg.startsWith('ControlPath=')), false, 'user-configured master location stays OpenSSH-owned');
});

test('SSH mux command stays constant for large scripts, empty stdin and binary payloads', { skip: process.platform === 'win32' }, () => {
  const target: Workspace = { id: 'ssh-stdio', name: 'SSH stdio', kind: 'ssh', cwd: '/tmp', host: 'test' };
  const padding = '# ' + 'x'.repeat(200_000) + '\n';
  const execute = (script: string, stdin?: string | Buffer) => {
    const invocation = commandInvocation(target, padding + script, undefined, undefined, true, stdin);
    assert.equal(invocation.args.at(-1), 'exec sh -s');
    return execFileSync('/bin/sh', ['-c', invocation.args.at(-1)!], { input: invocation.input });
  };
  for (const input of [undefined, '', Buffer.alloc(0)]) {
    const script = "read -r input && exit 19\ncat\ncat <<'END'\nquoted '$data'\nEND\n# trailing comment";
    assert.equal(execute(script, input).toString(), "quoted '$data'\n");
  }
  const payload = Buffer.concat([Buffer.from("LECTERN_STDIN\n'\n$(exit 12)\n"),
    Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 256))]);
  assert.deepEqual(execute('cat', payload), payload);
  assert.equal(execute('cat', '🙂\n第二行').toString(), '🙂\n第二行');
  assert.throws(() => execute('exit 37', payload), { status: 37 });
});

test('SSH failure while writing stdin preserves the original error and runs only once', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lectern-ssh-error-'));
  const previousPath = process.env.PATH;
  const calls = join(directory, 'calls');
  const error = 'mm_send_fd: sendmsg(2): Message too long\nmux_client_request_session: send fds failed';
  const target: Workspace = { id: 'ssh-error', name: 'SSH error', kind: 'ssh', cwd: '/tmp', host: 'test' };
  try {
    await writeFile(join(directory, 'ssh'), `#!/bin/sh\nexec 0<&-\nprintf x >> "$(dirname "$0")/calls"\nprintf '%s\\n' '${error}' >&2\nexit 255\n`, { mode: 0o700 });
    process.env.PATH = directory + ':' + previousPath;
    await assert.rejects(runCommand(target, 'cat', { input: Buffer.alloc(1_000_000) }), { message: error });
    assert.equal(await readFile(calls, 'utf8'), 'x');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test('loopback SSH: actual OpenSSH transports tmux input, capture, and authoritative JSONL', { timeout: 30_000, skip: process.platform === 'win32' ? 'Requires POSIX sshd/tmux host' : false }, async t => {
  const sshd = '/usr/sbin/sshd';
  try { await access(sshd); await exec('tmux', ['-V']); await exec('ssh-keygen', ['-V']); } catch (error) {
    // ssh-keygen -V requires a value and intentionally exits nonzero; presence is checked below.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { t.skip('sshd, ssh-keygen, or tmux is unavailable'); return; }
  }
  const directory = await realpath(await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'lectern-loopback-')));
  const socket = `lectern-ssh-${randomUUID().slice(0, 8)}`;
  let daemon: ReturnType<typeof spawn> | undefined;
  let backend: Backend | undefined;
  let daemonLog = '';
  let userMasterConfig: string | undefined;
  const local: Workspace = { id: 'cleanup', name: 'Cleanup', kind: 'local', cwd: directory };
  try {
    await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(directory, 'host-key')]);
    await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(directory, 'client-key')]);
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer(); probe.on('error', reject);
      probe.listen(0, '127.0.0.1', () => { const address = probe.address(); const port = typeof address === 'object' && address ? address.port : 0; probe.close(() => resolve(port)); });
    });
    await writeFile(join(directory, 'authorized_keys'), await readFile(join(directory, 'client-key.pub')), { mode: 0o600 });
    await writeFile(join(directory, 'known_hosts'), `lectern-loopback ${await readFile(join(directory, 'host-key.pub'), 'utf8')}`, { mode: 0o600 });
    const serverConfig = join(directory, 'sshd_config');
    await writeFile(serverConfig, [
      `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${join(directory, 'host-key')}`, `PidFile ${join(directory, 'sshd.pid')}`,
      `AuthorizedKeysFile ${join(directory, 'authorized_keys')}`, `SetEnv HOME=${join(directory, 'workspace')}`, 'StrictModes no', 'UsePAM no', 'PasswordAuthentication no',
      'KbdInteractiveAuthentication no', 'PubkeyAuthentication yes', 'PermitRootLogin no', `AllowUsers ${userInfo().username}`, 'LogLevel ERROR',
    ].join('\n') + '\n', { mode: 0o600 });
    const clientConfig = join(directory, 'ssh_config');
    await writeFile(clientConfig, [
      'Host lectern-loopback', '  HostName 127.0.0.1', `  Port ${port}`, `  User ${userInfo().username}`, '  HostKeyAlias lectern-loopback',
      `  IdentityFile ${join(directory, 'client-key')}`, `  UserKnownHostsFile ${join(directory, 'known_hosts')}`, '  IdentitiesOnly yes',
    ].join('\n') + '\n', { mode: 0o600 });
    daemon = spawn(sshd, ['-D', '-e', '-f', serverConfig], { stdio: ['ignore', 'pipe', 'pipe'] });
    daemon.stdout?.on('data', b => { daemonLog += b.toString(); });
    daemon.stderr?.on('data', b => { daemonLog += b.toString(); });
    await wait(250);
    if (daemon.exitCode !== null) { t.skip(`Unprivileged sshd unavailable: ${daemonLog.trim()}`); return; }
    const workspace: Workspace = { id: 'loopback', name: 'Loopback SSH', kind: 'ssh', host: 'lectern-loopback', cwd: join(directory, 'workspace'), claudeDir: join(directory, 'claude') };
    await mkdir(workspace.cwd);
    try {
      assert.equal((await runCommand(workspace, 'printf ssh-ready', { sshConfigPath: clientConfig, timeoutMs: 3000 })).stdout.toString(), 'ssh-ready');
    } catch (error) {
      t.skip(`Host disallows isolated sshd authentication: ${(error as Error).message}; ${daemonLog.trim()}`);
      return;
    }
    // Warm commands run on one persistent channel of the real OpenSSH session
    // (the loop shell is their parent) and match one-off sessions byte for byte.
    const channelled = new Transport(clientConfig), oneOff = new Transport(clientConfig, { channelKinds: [] });
    try {
      let parents: string[] = [];
      for (let i = 0; i < 100 && !(parents.length >= 2 && parents.at(-1) === parents.at(-2)); i++) {
        channelled.warmChannels(workspace);
        parents.push((await channelled.run(workspace, 'printf %s "$PPID"')).stdout.toString());
        if (parents.length < 2 || parents.at(-1) !== parents.at(-2)) await wait(50);
      }
      assert.equal(parents.at(-1), parents.at(-2), 'consecutive commands share the channel loop');
      const input = Buffer.concat([Buffer.from([0, 255, 10, 13]), Buffer.from("'$(id)' 中文\n"), Buffer.alloc(200_000, 'z')]);
      const outcome = (transport: Transport, script: string, payload?: Buffer) => transport.run(workspace, script, { input: payload })
        .then(r => [r.stdout.toString('base64'), r.stderr], (e: Error) => e.message);
      for (const [script, payload] of [["printf '\\000a\\377'"], ['echo out; echo err >&2; exit 4'], ['cat', input], ['head -c 1000000 /dev/zero']] as [string, Buffer?][])
        assert.deepEqual(await outcome(channelled, script, payload), await outcome(oneOff, script, payload), script);
    } finally { await channelled.dispose(); await oneOff.dispose(); }
    // A file pasted or dropped into an SSH chat is copied into that machine's
    // temporary directory (macOS sshd sessions bring their own TMPDIR).
    const uploads = new Transport(clientConfig);
    let uploaded: string | undefined;
    try {
      const bytes = Buffer.concat([Buffer.from([0, 255, 10, 13]), Buffer.from("'$(id)'"), Buffer.alloc(300_000, 'p')]);
      uploaded = await uploadAttachment(uploads, workspace, "截图 '1'.png", bytes);
      assert.match(uploaded, new RegExp(`/lectern-attachments-${process.getuid!()}/[A-Za-z0-9]{8}/截图 1\\.png$`));
      assert.deepEqual(await readFile(uploaded), bytes);
    } finally {
      await uploads.dispose();
      if (uploaded) await rm(join(uploaded, '..'), { recursive: true, force: true });
    }
    backend = new Backend({ tmuxSocket: socket, claudeCommand: process.execPath, claudeArgs: [resolve('scripts/mock-claude.mjs'), '--fixture-config', workspace.claudeDir!], sshConfigPath: clientConfig });
    const artifactName = "远端 ' quote.md", artifactContent = '# real OpenSSH artifact\n';
    await writeFile(join(workspace.cwd, artifactName), artifactContent);
    assert.equal((await backend.artifacts.list(workspace)).entries[0].path, artifactName);
    assert.equal((await backend.artifacts.preview(workspace, artifactName)).text, artifactContent);
    const download = await backend.artifacts.prepareDownload(workspace, artifactName);
    const saved = join(directory, 'download.md');
    await download.saveTo(saved);
    assert.equal(await readFile(saved, 'utf8'), artifactContent);
    // `@` completion over real OpenSSH: the background index answers the query.
    backend.completions.prefetchFiles(workspace);
    assert.deepEqual((await backend.completions.query(workspace, 'primary', 'ssh-at', { kind: 'mention', prefix: "远端 '" })).map(item => item.value), [artifactName]);
    const remoteChild = "远端 ' project", alias = join(directory, 'linked workspace');
    await mkdir(join(workspace.cwd, remoteChild, '.hidden'), { recursive: true });
    await symlink(workspace.cwd, alias);
    const endpoint = { kind: workspace.kind, host: workspace.host, port };
    assert.deepEqual(await backend.listWorkspaceDirectories(endpoint, ''), { path: workspace.cwd, directories: [remoteChild] });
    assert.deepEqual(await backend.listWorkspaceDirectories(endpoint, alias), { path: alias, directories: [remoteChild] });
    const childPath = join(alias, remoteChild);
    assert.deepEqual(await backend.listWorkspaceDirectories(endpoint, childPath), { path: childPath, directories: ['.hidden'] });
    await assert.rejects(backend.listWorkspaceDirectories(endpoint, join(alias, artifactName)));
    const session = await backend.createSession(workspace);
    let ready = false, lastState: unknown;
    for (let i = 0; i < 30; i++) { const state = await backend.readSession(workspace, session.id); lastState = state; if (state.active && state.screen.includes('offline fixture')) { ready = true; break; } await wait(50); }
    assert.ok(ready, 'mock TUI is ready over SSH: ' + JSON.stringify(lastState));
    // A takeover link over the same multiplexed SSH: frames come back and keys go through.
    {
      const pid = Number((await runCommand(workspace, `tmux -L ${socket} display-message -p -t ${session.paneId} '#{pane_pid}'`, { sshConfigPath: clientConfig })).stdout.toString().trim());
      const frames: string[] = [];
      const link = await backend.openTerminalLink(workspace, session.paneId!, pid, { onFrame: frame => frames.push(frame.ansi), onClosed: () => {} });
      link.send({ type: 'literal', text: 'link probe' });
      for (let i = 0; i < 100 && !frames.some(f => f.includes('link probe')); i++) await wait(30);
      assert.ok(frames.some(f => f.includes('offline fixture')), 'captures arrive over SSH');
      assert.ok(frames.some(f => f.includes('link probe')), 'typed text reached the remote pane: ' + JSON.stringify(frames.at(-1)?.slice(-400)));
      for (let i = 0; i < 'link probe'.length; i++) link.send({ type: 'key', key: 'Backspace' });
      for (let i = 0; i < 100 && frames.at(-1)!.includes('link probe'); i++) await wait(30);
      assert.equal(frames.at(-1)!.includes('link probe'), false);
      link.close();
    }
    const childDir = join(workspace.claudeDir!, 'projects', projectSlug(workspace.cwd), session.id, 'subagents');
    await mkdir(childDir, { recursive:true });
    const childRow = { parentUuid:null, isSidechain:true, type:'assistant', sessionId:session.id, agentId:'a123',
      message:{ content:[{type:'text',text:'Loopback child progress'}] } };
    await writeFile(join(childDir, 'agent-a123.jsonl'), JSON.stringify(childRow) + '\n');
    const run = Transport.prototype.run;
    const commands: { tag?: string; command: string }[] = [];
    const counted = t.mock.method(Transport.prototype,'run',function(this: Transport, target: Workspace, command: string, options: CommandOptions = {}) {
      commands.push({tag:options.tag,command});
      return run.call(this,target,command,options);
    });
    const observed = await backend.readSession(workspace, session.id, false, [{kind:'agent', taskId:'a123'}]);
    counted.mock.restore();
    assert.match(observed.activitySamples?.[0]?.tail ?? '', /Loopback child progress/);
    assert.deepEqual(commands.map(c => c.tag).filter(tag => tag !== 'tmux.session_capture'), ['session.poll'],
      'Activity samples and the main transcript share one SSH invocation');
    // The subagent column reads the same file over the same transport: listed with its meta file, then its records.
    await writeFile(join(childDir, 'agent-a123.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Loopback child', toolUseId: 'toolu_loop' }));
    const [listed] = await backend.listSubagents(workspace, session.id);
    assert.equal(listed.agentId, 'a123');
    assert.equal(listed.description, 'Loopback child');
    assert.equal(listed.toolUseId, 'toolu_loop');
    const child = await backend.readSubagent(workspace, session.id, 'a123');
    assert.equal(child.reset, true);
    assert.match(child.jsonl.toString(), /Loopback child progress/);
    await appendFile(join(childDir, 'agent-a123.jsonl'), JSON.stringify({ ...childRow, uuid: 'later', message: { content: [{ type: 'text', text: 'Loopback child later' }] } }) + '\n');
    const later = await backend.readSubagent(workspace, session.id, 'a123', child.cursor);
    assert.equal(later.reset, false);
    assert.match(later.jsonl.toString(), /^\{.*Loopback child later.*\}\n$/);
    await backend.sendMessage(workspace, session.id, '你好 SSH');
    backend.resetRead(workspace.id, session.id);
    const records: Buffer[] = [];
    let sawPreview = false, sawReply = false;
    for (let i = 0; i < 60; i++) {
      const state = await backend.readSession(workspace, session.id);
      records.push(state.jsonl);
      if (state.screen.includes('这是运行在真实 tmux')) sawPreview = true;
      if (Buffer.concat(records).toString().includes('"stop_reason":"end_turn"')) { sawReply = true; break; }
      await wait(80);
    }
    assert.ok(sawPreview, 'tmux preview crossed real SSH');
    assert.ok(sawReply, 'completed JSONL crossed real SSH');
    const parsed = Buffer.concat(records).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(parsed.filter(r => r.type === 'user').length, 1);
    assert.equal(parsed[0].message.content[0].text, '你好 SSH');
    assert.equal(parsed.filter(r => r.type === 'assistant').length, 1);
    assert.equal((await backend.discover(workspace)).sessions[0].paneId, session.paneId);
    const historyId = randomUUID();
    const historyFile = join(workspace.claudeDir!, 'projects', projectSlug(workspace.cwd), historyId + '.jsonl');
    const history = Array.from({ length: 57 }, (_, i) => JSON.stringify({ type: 'user', uuid: String(i), cwd: workspace.cwd,
      sessionId: historyId, message: { content: '历史' + i } }) + '\n').join('');
    await writeFile(historyFile, history);
    const newest = await backend.readSession(workspace, historyId, false, [], true);
    assert.ok(newest.olderCursor);
    const older = await backend.readOlderHistory(workspace, historyId, newest.olderCursor);
    assert.equal(older.olderCursor, undefined);
    assert.equal(Buffer.concat([older.jsonl, newest.jsonl]).toString(), history);
    await backend.sendKey(workspace, session.id, 'C-c');
    await wait(100);
    await assert.rejects(() => backend!.sendMessage(workspace, session.id, 'must not execute'), /not running/);
    await backend.dispose(); backend = undefined;
    // Emulate a user-authenticated ControlMaster. Once established, make this
    // fixture's key unavailable: a new private connection must not be required.
    await appendFile(clientConfig, `  ControlMaster auto\n  ControlPath ${join(directory, 'user-master')}\n  ControlPersist 60\n`);
    await exec('ssh', ['-F', clientConfig, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-M', '-N', '-f', 'lectern-loopback']);
    userMasterConfig = clientConfig;
    await rename(join(directory, 'client-key'), join(directory, 'client-key-disabled'));
    await assert.rejects(runCommand(workspace, 'printf must-not-connect', { sshConfigPath: clientConfig, controlPath: join(directory, 'fresh-master'), timeoutMs: 3000 }), /Permission denied/);
    const reusing = new Backend({ sshConfigPath: clientConfig });
    try {
      const binary = Buffer.from([0, 255, 39, 10, 0, 128]);
      const large = '# ' + 'mux'.repeat(55_000) + '\ncat';
      const copy = await runCommand(workspace, large, { input: binary, sshConfigPath: clientConfig, reuseExistingMaster: true });
      assert.deepEqual(copy.stdout, binary, 'large scripts and byte-exact stdin share the existing authenticated master');
      const scan = await reusing.discoverHistoryProjects({ kind: 'ssh', host: 'lectern-loopback', claudeDir: workspace.claudeDir });
      assert.equal(scan.projects.find(project => project.cwd === workspace.cwd)?.sessionCount, 2);
    } finally { await reusing.dispose(); }
    const master = await exec('ssh', ['-F', clientConfig, '-O', 'check', 'lectern-loopback']);
    assert.match(master.stderr, /Master running/, 'Backend disposal must never close the user-owned SSH master');
  } finally {
    await backend?.dispose();
    if (userMasterConfig) await exec('ssh', ['-F', userMasterConfig, '-O', 'exit', 'lectern-loopback']).catch(() => {});
    await runCommand(local, `tmux -L '${socket}' kill-server 2>/dev/null || true`).catch(() => {});
    daemon?.kill('SIGTERM');
    daemon?.stdout?.destroy(); daemon?.stderr?.destroy();
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) await Promise.race([new Promise(resolve => daemon!.once('exit', resolve)), wait(1000)]);
    await rm(directory, { recursive: true, force: true });
  }
});
