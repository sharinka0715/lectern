import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeDirectoryTrust, type TrustContext, type TrustDriver, type TrustObservation } from '../src/backend/native-trust';
import { Backend, quoteShell, runCommand } from '../src/backend';
import type { Workspace } from '../src/shared/types';

function trustScreen(cwd: string, focus: 'trust' | 'exit' = 'exit', home = false): string {
  return `──────────────────────────────────\nAccessing workspace:\n\n${cwd}\n\nQuick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source\nproject, or work from your team). If not, take a moment to review what's in this folder first.\n\nClaude Code'll be able to read, edit, and execute files here.${home ? ' This is your home folder, so Yes lasts for this session only.' : ''}\n\nSecurity guide\n\n${focus === 'exit' ? '❯' : ' '} No, exit\n${focus === 'trust' ? '❯' : ' '} Yes, I trust this folder\n\nEnter to confirm · Esc to cancel\n`;
}
const composer = '────────────────────────\n❯ \n────────────────────────\n? for shortcuts\n';
const sendsKey = (script: string, pane: string, key: string) => script.includes(['send-keys', '-t', pane, key].map(quoteShell).join(' '));
const context: TrustContext = { workspaceId: 'fixture', sessionId: randomUUID(), targetKey: 'fixture:0' };
class TrustFixture implements TrustDriver {
  cwd = '/example/project';
  cwdAliases = ['/example/project'];
  paneId: string | undefined = '%3';
  active = true;
  focused: 'trust' | 'exit' = 'exit';
  closed = false;
  override?: string;
  keys: string[] = [];
  onKey?: (key: string) => void;
  async inspect(): Promise<TrustObservation> { return { paneId: this.paneId, active: this.active, cwdAliases: this.cwdAliases, viewport: this.override ?? (this.closed ? composer : trustScreen(this.cwd, this.focused)) }; }
  async key(key: Parameters<TrustDriver['key']>[0], paneId: string): Promise<void> {
    assert.equal(paneId, this.paneId); assert.equal(this.active, true); this.keys.push(key);
    if (key === 'Down') this.focused = 'trust';
    else if (key === 'Up') this.focused = 'exit';
    else if (this.focused === 'trust') this.closed = true;
    else { this.active = false; this.paneId = undefined; }
    this.onKey?.(key);
  }
}

test('trust observations are read-only, stable across polls, and require actual cwd alias and active pane', async () => {
  const engine = new NativeDirectoryTrust(), fixture = new TrustFixture();
  const first = engine.observe(context, await fixture.inspect());
  assert.ok(first); assert.equal(first.scope, 'unspecified');
  assert.deepEqual(engine.observe(context, await fixture.inspect()), first);
  assert.deepEqual(fixture.keys, []);
  assert.equal(engine.observe(context, { ...await fixture.inspect(), cwdAliases: ['/different/path'] }), undefined);
  await assert.rejects(engine.respond(fixture, context, first.token, 'trust'), /过期/);
  assert.equal(engine.observe(context, { ...await fixture.inspect(), active: false }), undefined);
  assert.equal(engine.observe(context, { ...await fixture.inspect(), viewport: 'Permission required\n❯ Yes\nNo' }), undefined);
  const home = engine.observe(context, { ...await fixture.inspect(), viewport: trustScreen(fixture.cwd, 'exit', true) });
  assert.equal(home?.scope, 'session');
  assert.deepEqual(fixture.keys, []);
});

test('explicit trust chooses Yes using observed positions and confirms closure without sending chat text', async () => {
  const engine = new NativeDirectoryTrust(), fixture = new TrustFixture();
  const snapshot = await engine.get(fixture, context); assert.ok(snapshot);
  const result = await engine.respond(fixture, context, snapshot.token, 'trust');
  assert.deepEqual(result, { decision: 'trust', sessionId: context.sessionId, paneId: '%3', closed: true });
  assert.deepEqual(fixture.keys, ['Down', 'Enter']);
  assert.equal(fixture.active, true);
  assert.equal(await engine.get(fixture, context), undefined);
  await assert.rejects(engine.respond(fixture, context, snapshot.token, 'trust'), /过期/);
});

test('explicit exit chooses native No and verifies Claude is no longer active', async () => {
  const engine = new NativeDirectoryTrust(), fixture = new TrustFixture(); fixture.focused = 'trust';
  const snapshot = await engine.get(fixture, context); assert.ok(snapshot);
  const result = await engine.respond(fixture, context, snapshot.token, 'exit');
  assert.equal(result.closed, true); assert.equal(fixture.active, false);
  assert.deepEqual(fixture.keys, ['Up', 'Enter']);
});

test('stale focus, workspace revisions, pane replacement, expiration and foreign sessions fail without input', async () => {
  for (const variant of ['focus', 'context', 'pane', 'inactive', 'expiry', 'session'] as const) {
    const engine = new NativeDirectoryTrust(5000, variant === 'expiry' ? 1 : 120000), fixture = new TrustFixture();
    const snapshot = await engine.get(fixture, context); assert.ok(snapshot);
    if (variant === 'focus') fixture.focused = 'trust';
    if (variant === 'pane') fixture.paneId = '%4';
    if (variant === 'inactive') fixture.active = false;
    if (variant === 'expiry') await new Promise(resolve => setTimeout(resolve, 5));
    const changed = variant === 'context' ? { ...context, targetKey: 'fixture:1' } : variant === 'session' ? { ...context, sessionId: randomUUID() } : context;
    await assert.rejects(engine.respond(fixture, changed, snapshot.token, 'trust'), { name: 'DirectoryTrustError' });
    assert.deepEqual(fixture.keys, [], variant);
  }
});

test('changed directory or unknown overlay after navigation cannot receive Enter', async () => {
  for (const variant of ['cwd', 'overlay'] as const) {
    const engine = new NativeDirectoryTrust(), fixture = new TrustFixture();
    const snapshot = await engine.get(fixture, context); assert.ok(snapshot);
    fixture.onKey = key => { if (key === 'Down') { if (variant === 'cwd') fixture.cwd = '/other/project'; else fixture.override = trustScreen(fixture.cwd, 'trust') + '\nApprove account access? [Y/n]'; } };
    await assert.rejects(engine.respond(fixture, context, snapshot.token, 'trust'), /已变化/);
    assert.deepEqual(fixture.keys, ['Down']);
  }
});

test('uncertain confirmation never retries Enter or sends cleanup keys', async () => {
  const engine = new NativeDirectoryTrust(), fixture = new TrustFixture(); fixture.focused = 'trust';
  const snapshot = await engine.get(fixture, context); assert.ok(snapshot);
  fixture.onKey = key => { if (key === 'Enter') throw new Error('simulated SSH lost receipt'); };
  await assert.rejects(engine.respond(fixture, context, snapshot.token, 'trust'), /已发送.*未核验/);
  assert.deepEqual(fixture.keys, ['Enter']);
  await assert.rejects(engine.respond(fixture, context, snapshot.token, 'trust'), /过期/);
  assert.deepEqual(fixture.keys, ['Enter']);
});

test('backend directory-trust operations share the message, terminal-key, and settings input lease', async () => {
  const backend = new Backend(), fixture = new TrustFixture();
  const workspace: Workspace = { id: 'fixture', name: 'Trust fixture', kind: 'local', cwd: fixture.cwd };
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const inspect = fixture.inspect.bind(fixture); let first = true;
  fixture.inspect = async () => { if (first) { first = false; entered(); await held; } return inspect(); };
  (backend as any).locate = async () => ({ cwd: fixture.cwd, cwdAliases: fixture.cwdAliases, claudeDir: '/example/config', projectDirs: [] });
  (backend as any).getSession = async () => ({ id: context.sessionId, title: 'Fixture' });
  (backend as any).directoryTrustDriver = () => fixture;
  try {
    const pending = backend.getDirectoryTrust(workspace, context.sessionId); await started;
    for (const operation of [() => backend.sendMessage(workspace, context.sessionId, 'must not send'), () => backend.sendKey(workspace, context.sessionId, 'Enter'), () => backend.setSessionSetting(workspace, context.sessionId, 'not-a-token', 'option'), () => backend.respondDirectoryTrust(workspace, context.sessionId, 'not-a-token', 'trust')]) await assert.rejects(operation(), { name: 'SessionInputBusyError' });
    release(); const snapshot = await pending; assert.ok(snapshot);
    assert.equal((await backend.respondDirectoryTrust(workspace, context.sessionId, snapshot.token, 'trust')).closed, true);
    assert.deepEqual(fixture.keys, ['Down', 'Enter']);
    assert.equal((backend as any).cursors.size, 0);
  } finally { release(); await backend.dispose(); }
});

test('real tmux readSession exposes a trust token without extra probes or input; explicit Yes and No work before JSONL exists', { timeout: 30_000 }, async t => {
  const base: Workspace = { id: randomUUID(), name: 'Trust fixture', kind: 'local', cwd: '/tmp' };
  try { await runCommand(base, 'command -v tmux'); } catch { t.skip('tmux is not available'); return; }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lectern-trust-'))), cwd = join(root, 'workspace'), config = join(root, 'config');
  await mkdir(cwd); await mkdir(config);
  const mock = join(root, 'trust.mjs'), socket = `lectern-trust-${randomUUID().slice(0, 8)}`;
  await writeFile(mock, `import fs from 'node:fs';import path from 'node:path';
const id=process.argv.at(-1), report=path.join(${JSON.stringify(root)},id+'.keys');
let focus='exit',closed=false;
const template=${JSON.stringify(trustScreen(cwd))};
function render(){process.stdout.write('\\x1b[2J\\x1b[H'+(closed?${JSON.stringify(composer)}:focus==='exit'?template:template.replace('❯ No, exit','  No, exit').replace('  Yes, I trust','❯ Yes, I trust')));}
process.stdin.setRawMode(true);process.stdin.resume();render();
process.stdin.on('data',data=>{const text=data.toString();fs.appendFileSync(report,JSON.stringify([...data])+'\\n');if(data.includes(3))process.exit(0);if(text.includes('B'))focus='trust';if(text.includes('A'))focus='exit';if(text.includes('\\r')){if(focus==='exit')process.exit(0);closed=true;}render();});
`);
  const workspace = { ...base, cwd, claudeDir: config };
  const backend = new Backend({ tmuxSocket: socket, claudeCommand: process.execPath, claudeArgs: [mock] });
  const waitTrust = async (id: string) => {
    for (let count = 0; count < 30; count++) { const read = await backend.readSession(workspace, id); if (read.directoryTrust) return read.directoryTrust; await new Promise(resolve => setTimeout(resolve, 30)); }
    assert.fail('Fixture trust dialog did not appear');
  };
  try {
    const session = await backend.createSession(workspace), initial = await waitTrust(session.id);
    const transport = (backend as any).transport, original = transport.run.bind(transport); let commands = 0;
    transport.run = (...args: unknown[]) => { commands++; return original(...args); };
    const poll = await backend.readSession(workspace, session.id);
    transport.run = original;
    assert.equal(commands, 2, 'combined transcript/pane poll and capture; trust adds no transport invocation');
    assert.equal(poll.directoryTrust?.token, initial.token);
    assert.equal(poll.jsonl.length, 0);
    await assert.rejects(readFile(join(root, `${session.id}.keys`)), { code: 'ENOENT' });
    const accepted = await backend.respondDirectoryTrust(workspace, session.id, initial.token, 'trust');
    assert.equal(accepted.closed, true);
    const ready = await backend.readSession(workspace, session.id);
    assert.equal(ready.directoryTrust, undefined); assert.equal(ready.active, true);
    const refused = await backend.createSession(workspace), refusal = await waitTrust(refused.id);
    // Reproduce a new UUID being launched immediately after native No receives
    // Enter, before the old transaction can verify that its Claude exited.
    let replacement: Awaited<ReturnType<Backend['createSession']>> | undefined;
    let launchedReplacement = false;
    transport.run = async (target: Workspace, script: string, options?: unknown) => {
      const result = await original(target, script, options);
      if (!launchedReplacement && sendsKey(script, refused.paneId!, 'Enter')) {
        launchedReplacement = true;
        replacement = await backend.createSession(workspace);
        await waitTrust(replacement.id);
      }
      return result;
    };
    try { assert.equal((await backend.respondDirectoryTrust(workspace, refused.id, refusal.token, 'exit')).closed, true); }
    finally { transport.run = original; }
    assert.ok(launchedReplacement && replacement, 'another UUID was really launched during the old No completion check');
    assert.equal((await backend.discover(workspace)).sessions.some(info => info.id === refused.id), false);
    assert.equal((await readFile(join(root, `${refused.id}.keys`), 'utf8')).trim(), '[13]');
    const stale = await waitTrust(replacement.id);
    backend.invalidateWorkspace(workspace.id);
    await assert.rejects(backend.respondDirectoryTrust(workspace, replacement.id, stale.token, 'trust'), /过期|配置已变化/);
    await assert.rejects(readFile(join(root, `${replacement.id}.keys`)), { code: 'ENOENT' });
    const refreshed = await waitTrust(replacement.id);
    let edited = false;
    transport.run = async (target: Workspace, script: string, options?: unknown) => {
      const result = await original(target, script, options);
      if (!edited && sendsKey(script, replacement!.paneId!, 'Down')) {
        edited = true;
        await backend.discover({ ...workspace, name: 'Edited workspace configuration' });
      }
      return result;
    };
    try { await assert.rejects(backend.respondDirectoryTrust(workspace, replacement.id, refreshed.token, 'trust'), /配置已变化/); }
    finally { transport.run = original; }
    assert.equal(edited, true);
    const keysAfterEdit = (await readFile(join(root, `${replacement.id}.keys`), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as number[]);
    assert.equal(keysAfterEdit.flat().includes(13), false, 'a real configuration change during navigation still blocks Enter');
  } finally {
    await backend.dispose();
    await runCommand(workspace, `tmux -L ${quoteShell(socket)} kill-server 2>/dev/null || true`);
    await rm(root, { recursive: true, force: true });
  }
});

test('declining permissions through No, continue requires the same live pane to reach a ready composer', async () => {
  const engine = new NativeDirectoryTrust(400, 120_000, 400);
  const frame = trustScreen('/example/project').replace('No, exit', 'No, continue without these permissions');
  for (const outcome of ['ready', 'exited', 'unknown'] as const) {
    let submitted = false;
    const keys: string[] = [];
    const driver: TrustDriver = {
      inspect: async () => ({ paneId: '%3', active: !submitted || outcome !== 'exited', cwdAliases: ['/example/project'],
        viewport: !submitted ? frame : outcome === 'ready' ? composer : 'Unknown continuation' }),
      key: async key => { keys.push(key); submitted = true; },
    };
    const prompt = await engine.get(driver, context);
    assert.equal(prompt?.cancelDecision, 'continue');
    await assert.rejects(engine.respond(driver, context, prompt!.token, 'exit'), /拒绝选项/);
    assert.deepEqual(keys, []);
    const decision = engine.respond(driver, context, prompt!.token, 'continue');
    if (outcome === 'ready') assert.equal((await decision).decision, 'continue');
    else await assert.rejects(decision, /未核验/);
    assert.deepEqual(keys, ['Enter']);
  }
});

// Remote targets: every observation is an SSH round trip and Claude repaints an
// animated logo after Yes. Root (/) and HOME used to time out right after Enter.
class SlowStartFixture extends TrustFixture {
  inspections = 0;
  submittedAt = 0;
  dropFirst = 0;
  constructor(readonly latencyMs: number, readonly blankMs = 0) { super(); }
  override async inspect(): Promise<TrustObservation> {
    this.inspections++;
    await new Promise(resolve => setTimeout(resolve, this.latencyMs));
    if (!this.closed) return super.inspect();
    if (Date.now() - this.submittedAt < this.blankMs) return { paneId: this.paneId, active: true, cwdAliases: this.cwdAliases, viewport: '\n\n' };
    const logo = ['▐▛███▛█', '▝▜██████▀', '▗▟▛███▛█▄'][this.inspections % 3];
    return { paneId: this.paneId, active: true, cwdAliases: this.cwdAliases, viewport: ` ${logo}  Claude Code v2.1.328\n  /\n${composer}` };
  }
  override async key(key: Parameters<TrustDriver['key']>[0], paneId: string): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, this.latencyMs));
    if (key !== 'Enter' && this.dropFirst > 0) { this.dropFirst--; this.keys.push(key); return; }
    await super.key(key, paneId);
    if (key === 'Enter') this.submittedAt = Date.now();
  }
}

test('slow round trips and an animated startup screen still confirm trust with few observations', { timeout: 20_000 }, async () => {
  const engine = new NativeDirectoryTrust(), fixture = new SlowStartFixture(250);
  fixture.cwd = '/'; fixture.cwdAliases = ['/'];
  const snapshot = await engine.get(fixture, context); assert.ok(snapshot);
  fixture.inspections = 0;
  const started = Date.now();
  const result = await engine.respond(fixture, context, snapshot.token, 'trust');
  assert.equal(result.closed, true);
  assert.deepEqual(fixture.keys, ['Down', 'Enter']);
  // before-decision, two settle frames, two closed frames: no repeated idle reads.
  assert.ok(fixture.inspections <= 5, `observations: ${fixture.inspections}`);
  assert.ok(Date.now() - started < 3000);
});

test('closure has its own budget after Enter: a slow first paint is not a failure', { timeout: 20_000 }, async () => {
  const engine = new NativeDirectoryTrust(1000, 120_000, 5000), fixture = new SlowStartFixture(40, 1800);
  const snapshot = await engine.get(fixture, context); assert.ok(snapshot);
  const result = await engine.respond(fixture, context, snapshot.token, 'trust');
  assert.equal(result.closed, true);
  assert.deepEqual(fixture.keys, ['Down', 'Enter']);
});

test('a navigation key dropped while the chooser mounts is repeated once; Enter never is', { timeout: 20_000 }, async () => {
  const engine = new NativeDirectoryTrust(3000, 120_000, 2000, 150), fixture = new SlowStartFixture(10);
  fixture.dropFirst = 1;
  const snapshot = await engine.get(fixture, context); assert.ok(snapshot);
  assert.equal((await engine.respond(fixture, context, snapshot.token, 'trust')).closed, true);
  assert.deepEqual(fixture.keys, ['Down', 'Down', 'Enter']);
  const stuck = new SlowStartFixture(10), strict = new NativeDirectoryTrust(800, 120_000, 2000, 150);
  stuck.dropFirst = 5;
  const prompt = await strict.get(stuck, context); assert.ok(prompt);
  await assert.rejects(strict.respond(stuck, context, prompt.token, 'trust'), /超时/);
  assert.deepEqual(stuck.keys, ['Down', 'Down'], 'at most one repeat, and no Enter while focus is unconfirmed');
});

test('a dialog frame during closure verification restarts the count instead of passing', { timeout: 20_000 }, async () => {
  const engine = new NativeDirectoryTrust(2000, 120_000, 1500), fixture = new TrustFixture(); fixture.focused = 'trust';
  const snapshot = await engine.get(fixture, context); assert.ok(snapshot);
  let after = 0;
  const inspect = fixture.inspect.bind(fixture);
  fixture.inspect = async () => {
    if (!fixture.closed) return inspect();
    after++;
    // closed, dialog again, then a frame where only the header is still painted.
    const frames = [composer, trustScreen(fixture.cwd, 'trust'), '\x1b[1mAccessing workspace:\x1b[0m\n'];
    return { paneId: fixture.paneId, active: true, cwdAliases: fixture.cwdAliases, viewport: frames[(after - 1) % frames.length] };
  };
  await assert.rejects(engine.respond(fixture, context, snapshot.token, 'trust'), /已发送.*未核验/);
  assert.deepEqual(fixture.keys, ['Enter']);
  assert.ok(after >= 3);
});
