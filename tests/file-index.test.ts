import { fixtureClaudeConfig } from './helpers/claude-config';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { WorkspaceArtifacts } from '../src/backend/artifacts';
import { parseScan, type FileIndexLimits } from '../src/backend/file-index';
import { commandInvocation, Transport, type CommandOptions } from '../src/backend/transport';
import type { Workspace } from '../src/shared/types';

const posixOnly = { skip: process.platform === 'win32' };
const write = async (path: string, text = '') => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); };

/** Counts transport commands by tag; `remote` runs each one through the OpenSSH stdin envelope instead. */
class Counting extends Transport {
  tags: string[] = [];
  remote = false;
  /** The next index scan waits for this. */
  hold?: Promise<void>;
  count(tag: string) { return this.tags.filter(t => t === tag).length; }
  override async run(ws: Workspace, script: string, options: CommandOptions = {}) {
    this.tags.push(options.tag ?? '');
    const hold = options.tag === 'completion.index' ? this.hold : undefined;
    if (hold) { this.hold = undefined; await hold; }
    if (!this.remote) return super.run(ws, script, options);
    const invocation = commandInvocation(ws, script);
    assert.equal(invocation.file, 'ssh');
    const { stdout, stderr } = await promisify(execFile)('/bin/sh', ['-c', String(invocation.input)],
      { env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    return { stdout, stderr: stderr.toString() };
  }
}

async function fixture(t: TestContext, limits: Partial<FileIndexLimits> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lectern-file-index-')));
  const cwd = join(root, 'repo'), transport = new Counting();
  const clock = { now: 1_000_000 };
  const artifacts = new WorkspaceArtifacts(transport, { fanout: 20, ...limits, now: () => clock.now });
  const ws: Workspace = { id: 'files', name: 'repo', kind: 'local', cwd };
  fixtureClaudeConfig(join(cwd, 'profile-config'));
  t.after(async () => { await transport.dispose(); await rm(root, { recursive: true, force: true }); });
  for (const path of ['README.md', 'src/app.ts', 'src/lib/util.ts', 'deep/a/b/c/needle.txt', 'node_modules/pkg/index.js',
    'node_modules/pkg/lib/inner.js', '.env', '.git/HEAD', 'profile-config/settings.json', 'quote"name.txt']) await write(join(cwd, path));
  for (let i = 0; i < 25; i++) await write(join(cwd, 'big', `file-${String(i).padStart(2, '0')}.txt`));
  const index = artifacts.fileIndex;
  const signal = () => new AbortController().signal;
  const values = async (prefix: string) => (await index.query(ws, prefix, signal())).map(item => item.value + (item.kind === 'directory' ? '/' : ''));
  const updated = () => new Promise<string>(resolve => { const off = index.subscribe(id => { off(); resolve(id); }); });
  return { cwd, ws, transport, clock, index, values, updated, scans: () => transport.count('completion.index') };
}

test('a prefetched index answers the first @ and every keystroke without rescanning', posixOnly, async t => {
  const { ws, transport, index, values, updated, scans } = await fixture(t);
  const landed = updated();
  index.prefetch(ws);
  // Concurrent questions while the background scan runs share it.
  const answers = await Promise.all([values(''), values(''), values('ne')]);
  assert.equal(await landed, 'files');
  assert.equal(scans(), 1, 'one scan for the prefetch and three waiting queries');
  assert.equal(transport.count('artifact.workspace'), 1, 'the folder policy is read once');
  assert.deepEqual(answers[0], ['big/', 'deep/', 'node_modules/', 'src/', 'README.md']);
  assert.deepEqual(answers[2], ['deep/a/b/c/needle.txt']);
  // Credentials, Claude configuration and unmentionable names are never listed.
  for (const hidden of ['.env', '.git', 'profile', 'settings', 'quote']) assert.deepEqual(await values(hidden), [], hidden);
  assert.deepEqual(await values('util'), ['src/lib/util.ts']);
  assert.deepEqual(await values('src/'), ['src/lib/', 'src/app.ts']);
  assert.deepEqual(await values('src/u'), ['src/lib/util.ts']);
  assert.deepEqual(await values('nowhere/'), [], 'a folder the full listing lacks is not scanned');
  assert.deepEqual(await values('.git/'), []);
  assert.equal(scans(), 1);
});

test('heavy and crowded folders are listed but entered only when the user @s into them', posixOnly, async t => {
  const { ws, values, scans } = await fixture(t);
  assert.deepEqual(await values('index'), [], 'node_modules was not walked');
  assert.deepEqual(await values('file-0'), [], 'big (more than the fanout) was not walked');
  assert.equal(scans(), 1);
  assert.deepEqual(await values('node_modules/'), ['node_modules/pkg/']);
  assert.equal(scans(), 2, 'entering node_modules indexes it once');
  assert.deepEqual(await values('node_modules/pkg/'), ['node_modules/pkg/lib/', 'node_modules/pkg/index.js']);
  assert.deepEqual(await values('node_modules/inner'), ['node_modules/pkg/lib/inner.js']);
  const big = await values('big/');
  assert.equal(big.length, 25);
  assert.equal(big[0], 'big/file-00.txt');
  assert.deepEqual(await values('big/file-2'), ['big/file-20.txt', 'big/file-21.txt', 'big/file-22.txt', 'big/file-23.txt', 'big/file-24.txt']);
  assert.equal(scans(), 3, 'one scan per entered folder, then answers from memory');
});

test('an expired index answers at once, rescans in the background and shows new and deleted files', posixOnly, async t => {
  const { cwd, ws, clock, index, values, updated, scans } = await fixture(t);
  assert.ok((await values('')).includes('README.md'));
  await write(join(cwd, 'added.md'));
  await rm(join(cwd, 'README.md'));
  clock.now += index.limits.ttlMs - 1;
  assert.ok((await values('')).includes('README.md'), 'still fresh: served from memory');
  assert.equal(scans(), 1);
  clock.now += 1;
  const landed = updated();
  const stale = await values('');
  assert.ok(stale.includes('README.md') && !stale.includes('added.md'), 'expired: the old list is answered without waiting');
  // Another keystroke while the rescan runs does not start a second one.
  await values('a');
  await landed;
  assert.equal(scans(), 2);
  const fresh = await values('');
  assert.ok(fresh.includes('added.md') && !fresh.includes('README.md'), fresh.join());
  assert.equal(scans(), 2);
});

test('a miss rescans an index that is not brand new, so files Claude just wrote appear', posixOnly, async t => {
  const { cwd, clock, index, values, updated, scans } = await fixture(t);
  await values('');
  await write(join(cwd, 'report.md'));
  assert.deepEqual(await values('report'), []);
  assert.equal(scans(), 1, 'a miss right after a scan does not rescan');
  clock.now += index.limits.missMs;
  const landed = updated();
  assert.deepEqual(await values('report'), []);
  await landed;
  assert.deepEqual(await values('report'), ['report.md']);
  assert.equal(scans(), 2);
});

test('scans stop at the entry and time limits; the listing says what is complete', posixOnly, async t => {
  const { values, scans } = await fixture(t, { maxEntries: 8, fanout: 100 });
  const root = await values('');
  assert.deepEqual(root, ['big/', 'deep/', 'node_modules/', 'src/', 'README.md'], 'the first level fits');
  // big/ (25 entries) was cut by the entry limit: entering it scans it, again limited to 8.
  assert.equal((await values('big/')).length, 8);
  assert.equal(scans(), 2);
  const slow = await fixture(t, { scanSeconds: 0 });
  assert.deepEqual(await slow.values(''), [], 'a walk out of time returns what it has (here: nothing)');
  assert.equal(slow.scans(), 1);
});

test('a folder larger than one listing is searched by name on the endpoint, then from memory', posixOnly, async t => {
  const { values, updated, scans } = await fixture(t, { maxEntries: 10, fanout: 100 });
  await values('');
  assert.equal((await values('big/')).length, 10, 'the first 10 of 25 entries');
  assert.equal(scans(), 2);
  let landed = updated();
  assert.deepEqual(await values('big/FILE-24'), ['big/file-24.txt']);
  await landed;
  assert.equal(scans(), 3, 'one name-filtered listing');
  landed = updated();
  await values('big/file-2');
  await landed;
  assert.deepEqual(await values('big/file-2'), ['big/file-20.txt', 'big/file-21.txt', 'big/file-22.txt', 'big/file-23.txt', 'big/file-24.txt']);
  assert.deepEqual(await values('big/file-21'), ['big/file-21.txt']);
  assert.equal(scans(), 4, 'a complete listing for a shorter name answers longer ones');
});

test('a folder the user waits for does not queue behind background scans', posixOnly, async t => {
  const { ws, transport, index, values, scans } = await fixture(t, { concurrency: 1 });
  let release!: () => void;
  transport.hold = new Promise(resolve => { release = resolve; });
  const other = (id: string): Workspace => ({ ...ws, id });
  index.prefetch(other('first'));
  index.prefetch(other('second'));
  // Until the first one holds the transport: a fixed pause could let the user's scan get there
  // first on a loaded machine, take the hold and wait for a release that never comes.
  while (!scans()) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok((await values('')).includes('README.md'), 'answered while both background scans wait');
  assert.equal(scans(), 2, 'the held scan and this one; the second prefetch is still queued');
  release();
  const done = (id: string) => index.query(other(id), 'READ', new AbortController().signal);
  assert.equal((await done('first'))[0]?.value, 'README.md');
  assert.equal((await done('second'))[0]?.value, 'README.md');
  assert.equal(scans(), 3);
});

test('memory stays bounded: least recently used folders are dropped first', posixOnly, async t => {
  const { values, scans } = await fixture(t, { maxIndexes: 2 });
  await values('');
  await values('node_modules/');
  await values('src');
  await values('big/');
  assert.equal(scans(), 3);
  assert.equal((await values('node_modules/')).length, 1, 'evicted as least recently used');
  assert.equal(scans(), 4);
  await values('big/');
  assert.equal(scans(), 4, 'big/ was used after the root index');
  await values('');
  assert.equal(scans(), 5, 'the root index made room for node_modules');
  const crowded = await fixture(t, { maxCachedEntries: 30 });
  await crowded.values('');
  await crowded.values('big/');
  await crowded.values('');
  assert.equal(crowded.scans(), 3, 'the 25 entries of big/ pushed the root index out');
});

test('SSH: one bounded round trip per scan through the OpenSSH stdin envelope', posixOnly, async t => {
  const { ws, transport, scans } = await fixture(t);
  transport.remote = true;
  const remote: Workspace = { ...ws, id: 'remote', kind: 'ssh', host: 'files.example.com' };
  const artifacts = new WorkspaceArtifacts(transport, { fanout: 20 });
  const list = async (prefix: string) => (await artifacts.complete(remote, prefix, new AbortController().signal)).map(item => item.value);
  assert.deepEqual(await list(''), ['big', 'deep', 'node_modules', 'src', 'README.md']);
  assert.deepEqual(await list('needle'), ['deep/a/b/c/needle.txt']);
  assert.deepEqual(transport.tags, ['artifact.workspace', 'completion.index']);
  assert.equal((await list('node_modules/pkg/')).length, 2);
  assert.equal(scans(), 2);
});

test('a superseded keystroke stops waiting; the shared scan still lands in the cache', posixOnly, async t => {
  const { ws, index, values, updated, scans } = await fixture(t);
  const abort = new AbortController(), landed = updated();
  const first = index.query(ws, 'src/', abort.signal);
  while (!scans()) await new Promise(resolve => setTimeout(resolve, 2));
  abort.abort();
  await assert.rejects(first);
  await landed;
  assert.deepEqual(await values('src/'), ['src/lib/', 'src/app.ts']);
  assert.equal(scans(), 1);
});

test('ComposerCompletions prefetches, forwards updates and forgets an edited workspace', posixOnly, async t => {
  const { ws, transport, index, scans } = await fixture(t);
  const { ComposerCompletions } = await import('../src/backend/composer-completions');
  const completions = new ComposerCompletions(transport, { complete: (w, p, s) => index.query(w, p, s), fileIndex: index });
  const heard: string[] = [];
  const off = completions.onFilesUpdated(id => heard.push(id));
  const landed = new Promise<void>(resolve => { const stop = index.subscribe(() => { stop(); resolve(); }); });
  completions.prefetchFiles(ws);
  await landed;
  assert.deepEqual(heard, ['files']);
  const items = await completions.query(ws, 'primary', 'r1', { kind: 'mention', prefix: 'READ' });
  assert.deepEqual(items.map(i => i.value), ['README.md']);
  assert.equal(scans(), 1);
  completions.reset(ws.id);
  await completions.query(ws, 'primary', 'r2', { kind: 'mention', prefix: '' });
  assert.equal(scans(), 2, 'a reset workspace is indexed again');
  off();
});

test('scan output: entered folders count as complete only up to the reported limit', () => {
  const finished = parseScan('D./a\nf./x\nD./b\nd./a/node_modules\nf./b/y\nP./b\nE\n');
  assert.deepEqual(finished.paths, ['a', 'x', 'b', 'a/node_modules', 'b/y']);
  assert.deepEqual([...finished.listed], ['', 'a'], 'b had too many entries');
  assert.equal(finished.truncated, false);
  const cut = parseScan('D./a\nD./b\nf./a/z\nT2\n');
  assert.deepEqual([...cut.listed], ['', 'a']);
  assert.equal(cut.truncated, true);
  assert.deepEqual([...parseScan('D./a\n').listed], [], 'no end marker: nothing is known to be complete');
  assert.deepEqual(parseScan('f./ok\nf./bad"name\nf./../up\nf.//x\nD./�\nf./�/c\nT9\n').paths, ['ok']);
});
