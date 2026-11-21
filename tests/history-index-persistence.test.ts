import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { Backend, projectSlug } from '../src/backend';
import { HistoryIndexDiskStore } from '../src/backend/history-index-disk-store';
import { statTime } from '../src/backend/history-index';
import { Transport } from '../src/backend/transport';
import { probeReply } from './helpers/host-probe';
import type { Workspace } from '../src/shared/types';

const posix = { skip: process.platform === 'win32' };
const line = (value: unknown) => JSON.stringify(value) + '\n';
const stamp = '2026-10-01T06:30:00.000Z';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ssh-history-cache-'));
  const cwd = '/work/a-b', config = join(root, 'config'), profile = join(root, 'profile');
  const project = join(config, 'projects', projectSlug(cwd)), directory = join(profile, 'history-index');
  await mkdir(project, { recursive: true });
  const ws: Workspace = { kind: 'ssh', id: 'added', host: 'test@invalid.example', name: 'project', cwd };
  const location = { cwd, claudeDir: config, projectDirs: [project], cwdAliases: [cwd] };
  const backends: Backend[] = [];
  function openBackend() {
    const disk = new HistoryIndexDiskStore(profile), backend = new Backend({ historyIndexStore: disk, claudeCommand: 'false' });
    backends.push(backend);
    const transport: Transport = (backend as any).transport, local = transport.run.bind(transport);
    const scriptReads: string[] = [], tags: string[] = [];
    // Exercise Backend.discover and the real POSIX stat/scan scripts using this
    // temporary tree. Never pass an SSH workspace to commandInvocation.
    transport.run = (_workspace, script, options) => {
      const tag = options?.tag;
      if (!tag) return Promise.resolve({ stdout: Buffer.from([cwd, config, cwd, 'tmux 3.5', 'Darwin', ''].join('\0')), stderr: '' });
      tags.push(tag);
      if (tag === 'host.tools') return Promise.resolve({ stdout: Buffer.from(probeReply()), stderr: '' });
      if (tag === 'tmux.probe') return Promise.resolve({ stdout: Buffer.alloc(0), stderr: '' });
      if (!tag.startsWith('history.')) throw new Error(`Unexpected target command: ${tag}`);
      if (tag === 'history.changed_metadata') scriptReads.push(...script.split('\n').filter(s => s.startsWith('read_metadata ')));
      return local({ ...ws, kind: 'local' }, script, options);
    };
    return { backend, disk, transport, tags, scriptReads, discover: () => backend.discover(ws) };
  }
  const transcript = (id: string) => join(project, `${id}.jsonl`);
  async function diskFile() {
    const files = await readdir(directory);
    assert.equal(files.length, 1, 'one atomically published snapshot, no staging files');
    return join(directory, files[0]);
  }
  function body(extra: string, dir = cwd) {
    return line({ type: 'user', cwd: dir, message: { content: 'SECRET_FIRST_PROMPT' } }) + extra +
      line({ type: 'assistant', timestamp: stamp, message: { content: 'SECRET_ASSISTANT_TOOL_CONTENT' } });
  }
  return { ws, project, profile, location, directory, diskFile, transcript, body, openBackend,
    close: async () => { await Promise.all(backends.map(b => b.dispose())); await rm(root, { recursive: true, force: true }); } };
}

test('SSH restart verifies file stamps, recovers navigation without chat content and reads only deltas', posix, async () => {
  const f = await fixture();
  const named = randomUUID(), unnamed = randomUUID(), summarized = randomUUID(), colliding = randomUUID(), added = randomUUID();
  try {
    await writeFile(f.transcript(named), f.body(''));
    await mkdir(join(f.project, named));
    await writeFile(join(f.project, named, 'custom-title.json'), line({ customTitle: '导航名称' }));
    await writeFile(f.transcript(unnamed), f.body(''));
    await writeFile(f.transcript(summarized), f.body(line({ type: 'summary', summary: 'SECRET_SUMMARY' })));
    await writeFile(f.transcript(colliding), f.body(line({ type: 'custom-title', customTitle: 'OTHER_PROJECT_TITLE' }), '/work/a.b'));
    const first = f.openBackend();
    assert.equal((await first.discover()).sessions.length, 3, 'slug collisions are not adopted');
    const file = await f.diskFile(), content = await readFile(file, 'utf8');
    assert.match(content, /导航名称/);
    assert.doesNotMatch(content, /SECRET_|OTHER_PROJECT_TITLE|"message"|"prompt"|"head"|"tail"/);
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
    assert.equal((await lstat(f.directory)).mode & 0o777, 0o700);

    const restart = f.openBackend(), warm = (await restart.discover()).sessions;
    assert.deepEqual([...restart.tags].sort(), ['history.file_stamps', 'host.tools', 'tmux.probe']);
    assert.deepEqual(warm.map(s => s.id).sort(), [named, unnamed, summarized].sort());
    assert.equal(warm.find(s => s.id === named)?.title, '导航名称');
    assert.equal(warm.find(s => s.id === unnamed)?.title, `历史会话 ${unnamed.slice(0, 8)}`);
    assert.ok(warm.every(s => s.updatedAt === stamp && s.path === f.transcript(s.id)));
    // Identical stat-only refreshes do not rewrite a snapshot.
    const before = await lstat(file);
    await restart.discover();
    assert.equal((await lstat(file)).ino, before.ino);

    await writeFile(join(f.project, named, 'custom-title.json'), line({ customTitle: 'sidecar' }));
    await appendFile(f.transcript(unnamed), line({ type: 'ai-title', aiTitle: '新增 AI 名称' }));
    await writeFile(f.transcript(added), f.body(line({ type: 'ai-title', aiTitle: '新会话名称' })));
    await rm(f.transcript(summarized));
    const after = f.openBackend(), changed = (await after.discover()).sessions;
    assert.equal(after.scriptReads.length, 3);
    for (const id of [named, unnamed, added]) assert.ok(after.scriptReads.some(call => call.includes(id)));
    assert.ok(!changed.some(s => s.id === summarized));
    assert.equal(changed.find(s => s.id === named)?.title, 'sidecar');
    assert.equal(changed.find(s => s.id === unnamed)?.title, '新增 AI 名称');
    const newContent = await readFile(file, 'utf8');
    assert.doesNotMatch(newContent, /SECRET_|OTHER_PROJECT_TITLE/);
    assert.ok(!newContent.includes(summarized));
    const latest = f.openBackend();
    await latest.discover();
    assert.deepEqual(latest.scriptReads, []);
    // A deletion alone (no changed_metadata call) must update the durable index.
    await rm(f.transcript(added));
    await latest.discover();
    assert.ok(!(await readFile(file, 'utf8')).includes(added));
  } finally { await f.close(); }
});

test('restart retains verified fork and complete cwd diagnostics, but retries a partial sample', posix, async () => {
  const f = await fixture();
  try {
    const named = randomUUID(), queued = randomUUID(), cost = randomUUID(), fork = randomUUID(), parent = randomUUID(), partial = randomUUID(), uuid = randomUUID();
    await writeFile(f.transcript(named), line({ type: 'custom-title', customTitle: '先命名后对话' }));
    await writeFile(f.transcript(queued), line({ type: 'queue-operation', content: 'PRIVATE_QUEUE_BODY' }));
    await writeFile(f.transcript(cost), line({ type: 'cost-state', data: 'PRIVATE_COST_DETAILS' }));
    await writeFile(f.transcript(fork), line({ type: 'user', cwd: f.ws.cwd, sessionId: fork, uuid,
      forkedFrom: { sessionId: parent, messageUuid: uuid }, message: { content: 'PRIVATE_FORK_BODY' } }));
    await writeFile(f.transcript(partial), line({ type: 'assistant', message: { content: 'x'.repeat(1100000) } }));
    await f.openBackend().discover();
    const app = f.openBackend(), result = await app.discover();
    assert.equal(result.sessions.find(s => s.id === fork)?.forkParentId, parent);
    assert.ok(!result.sessions.some(s => s.id === named || s.id === queued || s.id === partial), 'absence of a proven cwd is not membership');
    assert.deepEqual(app.scriptReads.map(call => call.includes(partial)), [true]);
    const entries = await app.disk.forWorkspace(f.ws, f.location)!.read();
    assert.equal(entries.get(f.transcript(named))?.metadata.missingCwd, 'name');
    assert.equal(entries.get(f.transcript(cost))?.metadata.missingCwd, 'cost');
    assert.equal(entries.get(f.transcript(named))?.metadata.title, '先命名后对话');
    assert.equal(entries.get(f.transcript(named))?.metadata.titleSource, 'custom');
    assert.equal(entries.get(f.transcript(queued))?.metadata.missingCwd, 'queue');
    assert.ok(!entries.has(f.transcript(partial)));
    assert.doesNotMatch(await readFile(await f.diskFile(), 'utf8'), /PRIVATE_/);

    // Invalid fields from an incompatible/corrupt cache never become navigation metadata.
    const file = await f.diskFile(), data = JSON.parse(await readFile(file, 'utf8'));
    data.files.find((entry: { id: string }) => entry.id === fork).forkParentId = 'not-a-session';
    data.files.find((entry: { id: string }) => entry.id === queued).missingCwd = '__proto__';
    await writeFile(file, JSON.stringify(data));
    const checked = await app.disk.forWorkspace(f.ws, f.location)!.read();
    assert.equal(checked.get(f.transcript(fork))?.metadata.forkParentId, undefined);
    assert.ok(!checked.has(f.transcript(queued)));
  } finally { await f.close(); }
});

test('SSH index distinguishes endpoint, effective config and cwd (even with a colliding slug)', posix, async () => {
  const f = await fixture();
  try {
    await writeFile(f.transcript(randomUUID()), f.body(''));
    const { disk, discover } = f.openBackend(); await discover();
    const read = (ws = f.ws, location = f.location) => disk.forWorkspace(ws, location)!.read();
    assert.equal((await read({ ...f.ws, name: 'new display name' })).size, 1);
    for (const change of [{ id: 'another' }, { host: 'other' }, { port: 22 }, { cwd: '/work/a.b' }, { claudeDir: f.location.claudeDir }]) {
      assert.equal((await read({ ...f.ws, ...change })).size, 0);
    }
    for (const change of [{ cwd: '/work/a.b' }, { claudeDir: '/other/config' }, { projectDirs: ['/another/slug'] }]) {
      assert.equal((await read(f.ws, { ...f.location, ...change })).size, 0);
    }
    // A local folder is kept too, never mixed with an SSH one.
    assert.equal((await read({ ...f.ws, kind: 'local' })).size, 0);

    // Only the verified grouping signature and integer order survive – never
    // the evidence (message/UUID lists or raw JSONL) used to compute them.
    const bound = disk.forWorkspace(f.ws, f.location)!, [row] = (await bound.read()).values(), hint = randomUUID();
    const proof = { key: 'f'.repeat(64), order: 2, evidence: 'SECRET_GROUP_EVIDENCE' };
    const continuation = { key: proof.key, before: row.size, evidence: 'SECRET_CONTINUATION' };
    await bound.write([{ ...row, nativeHint: hint, groupProof: proof, continuationProof: continuation, metadata: { ...row.metadata, continuedInSessionId: hint } }]);
    const restored = (await bound.read()).get(row.path)!;
    assert.equal(restored.nativeHint, hint);
    assert.equal(restored.metadata.continuedInSessionId, hint);
    assert.deepEqual(restored.groupProof, { key: proof.key, order: 2 });
    assert.deepEqual(restored.continuationProof, { key: proof.key, before: row.size });
    assert.doesNotMatch(await readFile(await f.diskFile(), 'utf8'), /SECRET_/);
    await bound.write([{ ...row, nativeHint: 'invalid', groupProof: { key: proof.key, order: 32 },
      continuationProof: { key: proof.key, before: row.size + 1 }, metadata: { ...row.metadata, continuedInSessionId: 'not a uuid' } }]);
    const rejected = (await bound.read()).get(row.path)!;
    assert.equal(rejected.groupProof, undefined); assert.equal(rejected.nativeHint, undefined);
    assert.equal(rejected.continuationProof, undefined); assert.equal(rejected.metadata.continuedInSessionId, undefined);
    await bound.write([{ ...row, nativeHint: hint, groupProof: proof, metadata: { cwd: '/work/a.b' } }]);
    const foreign = (await bound.read()).get(row.path)!;
    assert.equal(foreign.groupProof, undefined); assert.equal(foreign.nativeHint, undefined);
  } finally { await f.close(); }
});

test('old, corrupt, insecure or unavailable profile caches never prevent live SSH discovery', posix, async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    await writeFile(f.transcript(id), f.body(line({ type: 'ai-title', aiTitle: 'recovered' })));
    await f.openBackend().discover();
    const file = await f.diskFile();
    for (const text of ['{bad', '{"version":0,"files":[]}', 'null']) {
      await writeFile(file, text);
      const app = f.openBackend();
      assert.equal((await app.discover()).sessions[0].title, 'recovered');
      assert.equal(app.scriptReads.length, 1);
    }
    // A failed remote listing does not erase a valid snapshot or expose
    // unverified cached sessions as if the transport had succeeded.
    const offline = f.openBackend(), before = await readFile(file, 'utf8');
    const run = offline.transport.run.bind(offline.transport);
    offline.transport.run = (...args) => args[2]?.tag === 'history.file_stamps' ? Promise.reject(new Error('offline')) : run(...args);
    await assert.rejects(offline.discover(), /offline/);
    assert.equal(await readFile(file, 'utf8'), before);
    await chmod(file, 0o644);
    assert.equal((await f.openBackend().discover()).sessions[0].title, 'recovered');
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
    const outside = join(f.profile, 'outside');
    await mkdir(outside); await writeFile(join(outside, 'sentinel'), 'intact');
    await rm(f.directory, { recursive: true }); await symlink(outside, f.directory, 'dir');
    const app = f.openBackend();
    assert.equal((await app.discover()).sessions[0].id, id);
    await app.discover();
    assert.equal(app.scriptReads.length, 1, 'memory index still effective when persistence is unavailable');
    assert.deepEqual(await readdir(outside), ['sentinel']);
    assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'intact');
  } finally { await f.close(); }
});

test('a slower scan cannot overwrite a newer index or recreate a forgotten SSH folder', posix, async () => {
  const f = await fixture();
  try {
    const id = randomUUID(), file = f.transcript(id);
    await writeFile(file, f.body(line({ type: 'custom-title', customTitle: 'first' })));
    const app = f.openBackend(); await app.discover();
    const run = app.transport.run.bind(app.transport);
    function delayNextRead() {
      let release!: () => void, captured!: () => void, pending = true;
      const ready = new Promise<void>(resolve => { captured = resolve; }), pause = new Promise<void>(resolve => { release = resolve; });
      app.transport.run = async (...args) => {
        const response = await run(...args);
        if (pending && args[2]?.tag === 'history.changed_metadata') { pending = false; captured(); await pause; }
        return response;
      };
      return { ready, release };
    }
    const rename = (title: string) => appendFile(file, line({ type: 'custom-title', customTitle: title }));
    await rename('older');
    const delayed = delayNextRead(), older = app.discover(); await delayed.ready;
    await rename('newer'); await app.discover();
    delayed.release(); await older;
    const restarted = f.openBackend();
    assert.equal((await restarted.discover()).sessions[0].title, 'newer');
    assert.equal(restarted.scriptReads.length, 0);

    await rename('pending removal');
    const removing = delayNextRead(), stale = app.discover(); await removing.ready;
    app.backend.invalidateWorkspace(f.ws.id);
    removing.release(); await assert.rejects(stale, /Workspace changed/);
    assert.equal((await app.disk.forWorkspace(f.ws, f.location)!.read()).size, 0);
    assert.deepEqual(await readdir(f.directory), []);
  } finally { await f.close(); }
});

test('a long last record still sorts the conversation by its latest write, not by when it started', posix, async () => {
  const f = await fixture();
  const replying = randomUUID(), other = randomUUID();
  try {
    // The reply in progress started long ago and its newest record (a long tool
    // result) is larger than the tail window, so the tail holds no timestamp.
    await writeFile(f.transcript(replying), line({ type: 'user', cwd: f.ws.cwd, timestamp: '2026-09-01T00:00:00.000Z', message: { content: 'old start' } })
      + line({ type: 'assistant', timestamp: '2026-09-01T00:00:05.000Z', message: { content: 'reading' } })
      + line({ type: 'user', timestamp: '2026-10-02T08:00:00.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(40_000) }] } }));
    await writeFile(f.transcript(other), f.body(''));
    const written = new Date('2026-10-02T08:00:00.000Z');
    await utimes(f.transcript(replying), written, written);
    const sessions = (await f.openBackend().discover()).sessions;
    assert.equal(sessions.find(s => s.id === replying)?.updatedAt, written.toISOString());
    assert.deepEqual(sessions.map(s => s.id), [replying, other], 'the conversation being written stays on top');
  } finally { await f.close(); }
});

test('stat modification times become ISO timestamps on BSD and GNU', () => {
  assert.equal(statTime('1790000000.250000000'), new Date(1790000000250).toISOString());
  assert.equal(statTime('2026-11-20 15:09:01.123456789 +0800'), '2026-11-20T07:09:01.123Z');
  assert.equal(statTime('2026-11-20 15:09:01 -0130'), '2026-11-20T16:39:01.000Z');
  assert.equal(statTime('yesterday'), undefined);
  assert.equal(statTime(undefined), undefined);
});
