import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, realpath, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend, projectSlug, quoteShell, runCommand } from '../src/backend';
import { decodePresence, matchPresence, presenceReadScript, presenceUnchangedGuard, tornPresence } from '../src/backend/native-presence';
import { keysNotSent } from '../src/backend/native-settings';
import { t as translate } from '../src/shared/i18n';
import { paneNavigationStatus } from '../src/backend/session-status';
import type { Workspace } from '../src/shared/types';

const id = randomUUID(), cwd = '/tmp/project', target = 'example:@3.%5';
const record = { pid: 215, tmux: target, procStart: '130894', startedAt: 1700000000000, pidDomain: 'linux:machine:pid:[1]', kind: 'interactive', cwd, sessionId: id, status: 'waiting', waitingFor: 'permission', updatedAt: 1 };
const match = (changes: Record<string, unknown> = {}) => matchPresence({ pid: 215, start: record.procStart, domain: record.pidDomain, bytes: Buffer.from(JSON.stringify({ ...record, ...changes })) }, target, [cwd]);

test('native identity requires the exact foreground process, start, PID domain, full tmux address, directory and UUID', () => {
  assert.equal(match()?.sessionId, id);
  for (const change of [{ pid: '215' }, { procStart: undefined }, { procStart: 'another' }, { pidDomain: 'foreign' },
    { kind: 'bg' }, { tmux: 'other:@3.%5' }, { tmux: 'example:@4.%5' }, { cwd: '/tmp/other' }, { sessionId: '../../other' }]) assert.equal(match(change), undefined);
  const pane = { id: '%5', active: true, dead: false };
  assert.equal(paneNavigationStatus({ ...pane, native: match() }).status, 'waiting', 'change-only records do not expire as heartbeats');
  assert.equal(paneNavigationStatus({ ...pane, native: match({ status: 'busy' }) }).status, 'working');
  // Background shells (native "shell") or, with the prompt back on screen, background
  // subagents and workflows (native "busy"): the reply is done, the work is not.
  const shell = paneNavigationStatus({ ...pane, native: match({ status: 'shell' }) });
  assert.equal(shell.status, 'idle'); assert.match(shell.background!, /^终端仍在运行$/);
  const idleScreen = '────────\n❯ \n────────\n  ? for shortcuts';
  const delegated = paneNavigationStatus({ ...pane, native: match({ status: 'busy' }) }, { screen: idleScreen });
  assert.equal(delegated.status, 'idle'); assert.match(delegated.background!, /子代理或工作流/);
  const spinning = paneNavigationStatus({ ...pane, native: match({ status: 'busy' }) }, { screen: '✻ Pondering… (3s · esc to interrupt)\n' + idleScreen });
  assert.equal(spinning.status, 'working'); assert.equal(spinning.background, undefined);
  assert.equal(paneNavigationStatus({ ...pane, native: match({ status: 'idle' }) }, { screen: idleScreen }).background, undefined);
  assert.equal(paneNavigationStatus({ ...pane, native: match({ status: 'idle' }) }, { screen: 'API Error: 401 invalid authentication' }).status, 'error');
  assert.equal(paneNavigationStatus({ ...pane, native: match({ status: undefined }) }).status, 'unknown');
  assert.equal(paneNavigationStatus({ ...pane, identityError: 'invalid' }, { screen: '❯\n? for shortcuts' }).status, 'unknown');
  assert.equal(match({ waitingFor: 'invalid\nreason' })?.waitingFor, undefined);
});

test('an empty record, or new JSON followed by the old tail, is a torn read', () => {
  const frame = (text: string) => ({ pid: 215, start: record.procStart, domain: record.pidDomain, bytes: Buffer.from(text) });
  // Captured from Claude Code 2.1.329 while it opened the /rewind dialog (identifiers replaced).
  const torn = JSON.stringify({ ...record, status: 'idle', statusUpdatedAt: 1795264908833 }) + '47,"waitingFor":"dialog open"}';
  assert.equal(tornPresence(frame(torn)), true);
  assert.equal(tornPresence(frame('')), true);
  assert.equal(tornPresence(frame(JSON.stringify(record))), false);
  assert.equal(matchPresence(frame(torn), target, [cwd]), undefined);
});

test('durable registration identity requires the native start and PID domain and ignores mutable status', () => {
  const original = match()!.registrationId!;
  assert.match(original, /^[0-9a-f]{64}$/);
  assert.equal(match({ status: 'busy', updatedAt: 2, name: 'renamed' })?.registrationId, original);
  assert.notEqual(match({ sessionId: randomUUID() })?.registrationId, original);
  assert.notEqual(match({ startedAt: record.startedAt + 1 })?.registrationId, original);
  for (const change of [{ startedAt: undefined }, { startedAt: '1700000000000' }, { startedAt: -1 }, { pidDomain: undefined }]) {
    const older = match(change);
    assert.equal(older?.sessionId, id);
    assert.equal(older?.registrationId, undefined);
  }
  for (const pidDomain of ['linux::pid:[1]', 'linux:machine:']) {
    const partial = matchPresence({ pid: record.pid, start: record.procStart, domain: pidDomain, bytes: Buffer.from(JSON.stringify({ ...record, pidDomain })) }, target, [cwd]);
    assert.equal(partial?.sessionId, id);
    assert.equal(partial?.registrationId, undefined);
  }
});

test('project directory encoding uses the whole original UTF-16 path for the native long-path hash', () => {
  const short = '/' + 'a'.repeat(199);
  assert.equal(projectSlug(short), '-' + 'a'.repeat(199));
  assert.equal(projectSlug(short + 'a'), '-' + 'a'.repeat(199) + '-b6ymvl');
  assert.equal(projectSlug(short + '🧭'), '-' + 'a'.repeat(199) + '-86sich');
});

test('isolated tmux uses structured presence, reuses only stable frames and revokes the old UUID after clear', { skip: process.platform === 'win32', timeout: 30_000 }, async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'lectern-presence-')));
  const config = join(dir, 'config'), socket = 'presence-' + randomUUID().slice(0, 8), mock = join(dir, 'fixture.mjs');
  const child = join(dir, 'child');
  const workspace: Workspace = { id: 'presence-fixture', name: 'fixture', kind: 'local', cwd: dir, claudeDir: config };
  const tmux = (...args: string[]) => ['tmux', '-L', socket, ...args].map(quoteShell).join(' ');
  const backend = new Backend({ tmuxSocket: socket, claudeCommand: process.execPath, claudeArgs: [mock] });
  try {
    try { await runCommand(workspace, 'command -v tmux'); } catch { t.skip('tmux unavailable'); return; }
    await mkdir(child);
    await mkdir(join(config, 'sessions'), { recursive: true });
    await writeFile(mock, `import fs from 'node:fs'; import path from 'node:path';
const id=process.argv.at(-1), p=path.join(process.env.CLAUDE_CONFIG_DIR,'projects',process.cwd().replace(/[^A-Za-z0-9]/g,'-'));
fs.mkdirSync(p,{recursive:true});fs.writeFileSync(path.join(p,id+'.jsonl'),JSON.stringify({type:'user',uuid:id,sessionId:id,cwd:process.cwd(),message:{role:'user',content:'old history'}})+'\\n');
const initial=process.cwd();process.on('SIGUSR1',()=>process.chdir(process.cwd()===initial?path.join(initial,'child'):initial));
process.stdin.setRawMode(true);process.stdin.resume();
process.stdin.on('data',b=>fs.appendFileSync(path.join(process.cwd(),'keys'),b));
process.stdout.write('❯\\r\\n? for shortcuts\\r\\n');`);
    const original = await backend.createSession(workspace);
    const { stdout } = await runCommand(workspace, tmux('display-message', '-p', '-t', original.paneId!, '#{pane_pid}|#{session_name}:#{window_id}.#{pane_id}'));
    const [pid, tmuxTarget] = stdout.toString().trim().split('|');
    const startCmd = process.platform === 'darwin' ? `LC_ALL=C TZ=UTC ps -p ${pid} -o lstart=` : `sed 's/^.*) //' /proc/${pid}/stat | awk '{print $20}'`;
    const procStart = (await runCommand(workspace, startCmd)).stdout.toString().trim();
    const file = join(config, 'sessions', pid + '.json'), nextId = randomUUID();
    const base = { pid: Number(pid), procStart, startedAt: Date.now(),
      tmux: tmuxTarget, kind: 'interactive', cwd: dir, sessionId: original.id, status: 'idle' };
    let pidDomain: string | undefined;
    const update = (changes: Record<string, unknown>) => writeFile(file, JSON.stringify({ ...base, pidDomain, ...changes }));
    await update({});
    for (let i = 0; i < 50; i++) {
      const ready = await backend.readSession(workspace, original.id, true);
      if (ready.viewport?.includes('shortcuts')) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal((await backend.readSession(workspace, original.id)).runtimeInstanceId, undefined, 'older registrations are memory-only');
    const identityFrame = await runCommand(workspace, presenceReadScript(config, Number(pid)));
    pidDomain = decodePresence(identityFrame.stdout.toString().split('\0')).frames.get(Number(pid))!.domain;
    await update({});
    const first = await backend.readSession(workspace, original.id, true);
    assert.equal(first.nativeStatus, 'idle');
    assert.equal(first.session.status, 'idle');
    assert.match(first.runtimeInstanceId!, /^[a-f0-9]{64}$/);

    const transport = (backend as any).transport, run = transport.run.bind(transport);
    const operations: string[] = [];
    transport.run = (...args: any[]) => { operations.push(args[2]?.tag); return run(...args); };
    const second = await backend.readSession(workspace, original.id);
    assert.deepEqual(operations, ['session.poll'], 'steady poll needs one round trip and no capture');
    assert.equal(second.screenCapturedAt, first.screenCapturedAt);
    await backend.readSession(workspace, original.id, true);
    assert.equal(operations.at(-1), 'tmux.session_capture', 'an explicit viewport read always bypasses the cache');
    operations.length = 0;
    await backend.discover(workspace);
    await backend.discover(workspace);
    assert.equal(operations.includes('tmux.navigation_status'), false, 'passive navigation reuses the observed native pane status');

    const restarted = new Backend({ tmuxSocket: socket, claudeCommand: process.execPath, claudeArgs: [mock] });
    try {
      assert.equal((await restarted.readSession(workspace, original.id)).runtimeInstanceId, first.runtimeInstanceId, 'desktop restarts preserve the live process identity');
    } finally { await restarted.dispose(); }

    for (const moved of [child, dir]) {
      await runCommand(workspace, `kill -USR1 ${Number(pid)}`);
      let tmuxCwd = '';
      for (let i = 0; i < 50 && tmuxCwd !== moved; i++) {
        tmuxCwd = (await runCommand(workspace, tmux('display-message', '-p', '-t', original.paneId!, '#{pane_current_path}'))).stdout.toString().trim();
        if (tmuxCwd !== moved) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(tmuxCwd, moved);
      await update({ cwd: moved });
      assert.equal((await backend.readSession(workspace, original.id, true)).active, true, '/cd retains the original binding after fresh process and pane checks');
    }
    await update({ status: 'waiting', waitingFor: 'worker request' });
    const waiting = await backend.readSession(workspace, original.id);
    assert.equal(waiting.nativeStatus, 'waiting'); assert.match(waiting.session.statusDetail!, /worker request/);
    assert.equal(waiting.runtimeInstanceId, first.runtimeInstanceId);
    await update({ startedAt: base.startedAt + 1 });
    const ticket = backend.bindSettingChoices(workspace, original.id, original.paneId!, {
      kind: 'model', command: '/model', complete: true, options: [{ label: 'Fixture model' }],
    });
    operations.length = 0;
    await assert.rejects(backend.setSessionSetting(workspace, original.id, ticket.token, ticket.options[0].id,
      { panePid: first.panePid, instanceId: first.runtimeInstanceId }), /终端进程已变化/);
    assert.equal(operations.includes('settings.input_observe'), false, 'a replacement registration cannot receive even the opening command');
    assert.notEqual((await backend.readSession(workspace, original.id)).runtimeInstanceId, first.runtimeInstanceId, 'a replacement registration invalidates the same pane ID and PID');
    await update({ status: 'busy' });
    // The fixture's screen shows the empty prompt: busy then means background subagents or workflows.
    const busy = (await backend.discover(workspace)).sessions.find(s => s.id === original.id);
    assert.equal(busy?.status, 'idle'); assert.match(busy?.background ?? '', /子代理或工作流/);

    const args = { tag: 'presence-fixture' };
    const observation = await run(workspace, presenceReadScript(config, Number(pid)), args);
    const frame = decodePresence(observation.stdout.toString().split('\0')).frames.get(Number(pid))!;
    const guard = presenceUnchangedGuard(config, Number(pid), frame.fingerprint!);
    await run(workspace, guard, args);
    await update({ sessionId: nextId });
    await assert.rejects(run(workspace, guard, args), /身份或状态/);
    // Input guards say so when nothing was sent, which lets their callers read again.
    await assert.rejects(run(workspace, presenceUnchangedGuard(config, Number(pid), frame.fingerprint!, translate('native.presenceChangedNoKeys')), args),
      error => keysNotSent(error));
    const discovery = await backend.discover(workspace);
    assert.equal(discovery.sessions.find(s => s.id === original.id)?.paneId, undefined);
    assert.equal(discovery.sessions.find(s => s.id === nextId)?.paneId, original.paneId);
    assert.equal((await backend.readSession(workspace, original.id)).screen, '');
    await assert.rejects(backend.sendKey(workspace, original.id, 'Enter'), /UUID/);
    await assert.rejects(backend.bindSession(workspace, original.id, original.paneId!), /UUID/);

    await writeFile(file, '{"pid":');
    await assert.rejects(backend.sendKey(workspace, original.id, 'Enter'), { name: 'SessionMappingError' });
    await rm(file);
    await assert.rejects(backend.sendKey(workspace, original.id, 'Enter'), { name: 'SessionMappingError' });
    await symlink(join(dir, 'fixture.mjs'), file);
    const link = decodePresence((await run(workspace, presenceReadScript(config, Number(pid)))).stdout.toString().split('\0')).frames.get(Number(pid))!;
    assert.equal(link.bytes.length, 0);
    await assert.rejects(backend.sendKey(workspace, original.id, 'Enter'), { name: 'SessionMappingError' });
    await rm(file);
    await update({ sessionId: nextId, procStart: 'reused-pid' });
    await assert.rejects(backend.sendKey(workspace, original.id, 'Enter'), { name: 'SessionMappingError' });
    await assert.rejects(readFile(join(dir, 'keys')), { code: 'ENOENT' });
    await update({ sessionId: nextId });
    assert.equal((await backend.readSession(workspace, nextId)).active, true);
    let swapped = false;
    transport.run = async (...args: any[]) => {
      if (!swapped && args[1].includes('lectern_capture_presence') && args[1].includes("'send-keys'")) {
        swapped = true; await update({ sessionId: randomUUID() });
      }
      return run(...args);
    };
    await assert.rejects(backend.sendKey(workspace, nextId, 'Enter'), /身份或状态/);
    assert.ok(swapped);
    await assert.rejects(readFile(join(dir, 'keys')), { code: 'ENOENT' });
    transport.run = run;
    await update({ sessionId: nextId });
    await backend.sendKey(workspace, nextId, 'Space');
    let keys: string | undefined;
    // 创建文件与追加首个按键是两个系统调用，等待实际字节到达。
    for (let i = 0; i < 50 && !keys; i++) {
      try { keys = await readFile(join(dir, 'keys'), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!keys) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(keys, ' ');
    // Claude Code rewrites the record in place: a read can catch the new JSON followed
    // by the old record's tail. That read is repeated, not taken as a changed identity.
    const valid = JSON.stringify({ ...base, pidDomain, sessionId: nextId });
    await writeFile(file, valid + '47,"waitingFor":"dialog open"}');
    let probes = 0;
    transport.run = async (...args: any[]) => {
      const result = await run(...args);
      if (args[2]?.tag === 'tmux.probe' && ++probes === 1) await writeFile(file, valid);
      return result;
    };
    await backend.sendKey(workspace, nextId, 'Space');
    assert.equal(probes, 2, 'the torn record was read again');
    for (let i = 0; i < 50 && keys !== '  '; i++) { keys = await readFile(join(dir, 'keys'), 'utf8'); if (keys !== '  ') await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal(keys, '  ');
    transport.run = run;
  } finally {
    await backend.dispose();
    await runCommand(workspace, tmux('kill-server') + ' 2>/dev/null || true');
    await rm(dir, { recursive: true, force: true });
  }
});
