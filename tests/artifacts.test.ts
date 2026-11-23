import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, truncate, writeFile, rename } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { Backend } from '../src/backend';
import { THUMB_BYTES, THUMB_EDGE, THUMB_INPUT_BYTES, thumbnailPreview } from '../src/backend/image-thumbnail';
import { transcriptAttachments } from '../src/core/transcript-attachments';
import { AttachmentThumbnails, attachmentPreview } from '../src/main/message-attachment';
import { WorkspaceArtifacts } from '../src/backend/artifacts';
import { Transport, runCommand, quoteShell, type CommandOptions } from '../src/backend/transport';
import { ArtifactAccess } from '../src/main/artifact-access';
import type { Workspace } from '../src/shared/types';

const posix = { skip: process.platform === 'win32' ? 'Shell host fixtures run on POSIX' : false };
async function fixture(t: TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lectern-files-')));
  const cwd = join(base, 'Project with spaces'), config = join(cwd, 'custom config');
  await mkdir(config, { recursive: true });
  const workspace: Workspace = { id: 'artifact', name: '目录', kind: 'local', cwd, claudeDir: config };
  const backend = new Backend();
  t.after(async () => { await backend.dispose(); await rm(base, { recursive: true, force: true }); });
  return { base, cwd, config, workspace, artifacts: backend.artifacts };
}

test('project paths, bytes, directories and unsupported files use the same scoped reader', posix, async t => {
  const { cwd, config, workspace, artifacts } = await fixture(t);
  const folder = "报告 ' $资料", path = folder + '/说明.md';
  await mkdir(join(cwd, folder));
  await writeFile(join(cwd, path), '# 中文\n');
  await writeFile(join(cwd, 'demo.ts'), 'export const ok = true;\n');
  await writeFile(join(cwd, 'empty.txt'), '');
  await writeFile(join(cwd, 'unknown.bin'), Buffer.from([0, 0xff, 10, 0, 0x81]));
  await writeFile(join(cwd, 'fake.png'), '<script>active-markup</script>');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+paWQAAAAASUVORK5CYII=', 'base64');
  await writeFile(join(cwd, 'tiny-image'), png);
  await writeFile(join(cwd, 'file.pdf'), '%PDF-1.4\nsample');
  await mkdir(join(cwd, '.ssh')); await writeFile(join(cwd, '.env'), 'secret');
  await writeFile(join(config, 'hidden.txt'), 'secret'); await symlink('demo.ts', join(cwd, 'link'));
  await symlink(folder, join(cwd, 'dirlink'));
  const listing = await artifacts.list(workspace);
  assert.deepEqual(new Set(listing.entries.map(entry => entry.name)), new Set([folder, 'demo.ts', 'empty.txt', 'unknown.bin', 'tiny-image', 'file.pdf', 'fake.png']));
  assert.equal((await artifacts.preview(workspace, './' + folder)).kind, 'directory');
  const markdown = await artifacts.preview(workspace, join(cwd, path));
  assert.deepEqual([markdown.path, markdown.kind, markdown.text], [path, 'markdown', '# 中文\n']);
  assert.equal((await artifacts.preview(workspace, 'demo.ts')).kind, 'code');
  assert.equal((await artifacts.preview(workspace, 'empty.txt')).text, '');
  for (const opaque of ['unknown.bin', 'fake.png']) assert.equal((await artifacts.preview(workspace, opaque)).kind, 'binary');
  const image = await artifacts.preview(workspace, 'tiny-image');
  assert.equal(image.mime, 'image/png'); assert.deepEqual(Buffer.from(image.data!), png);
  assert.equal((await artifacts.preview(workspace, 'file.pdf')).kind, 'pdf');
  for (const bad of ['.ssh/xyz', '.ENV', 'custom config/hidden.txt', 'file:///etc/passwd', 'https://host/test', 'test\0x', 'link', 'dirlink/说明.md']) {
    await assert.rejects(() => artifacts.preview(workspace, bad));
    await assert.rejects(() => artifacts.prepareDownload(workspace, bad));
  }
  await assert.rejects(() => artifacts.list(workspace, 'demo.ts'), /文件夹/);
  await assert.rejects(() => artifacts.prepareDownload(workspace, folder), /文件/);
});

test('workspace reference lookup returns only unique readable targets and checks explicit outside paths without searching there', posix, async t => {
  const { base, cwd, config, workspace, artifacts } = await fixture(t);
  const sibling = join(base, 'another project');
  for (const folder of ['src/panel', 'app', '.ssh', sibling]) await mkdir(folder === sibling ? folder : join(cwd, folder), { recursive: true });
  await Promise.all(['src/panel/ProxyPanel.tsx', 'index.ts', 'app/index.ts', '.ssh/ProxyPanel.tsx', '.ssh/only.ts',
    'custom config/private.ts', 'app/id_rsa.pem', 'src/panel/a[*].txt', 'app/sp ace.md'].map(file => writeFile(join(cwd, file), file)));
  await writeFile(join(sibling, 'index.ts'), 'other workspace');
  await symlink(sibling, join(cwd, 'link-out'));
  await symlink('src/panel/ProxyPanel.tsx', join(cwd, 'linked.ts'));
  const calls: string[] = [];
  const access = new ArtifactAccess(id => id === workspace.id ? workspace : { ...workspace, id, cwd: sibling }, artifacts, {
    allowOutside: async (_, path) => { calls.push(path); return false; }, saveAs: async () => undefined,
  });
  const refs = ['ProxyPanel.tsx', 'index.ts', './index.ts', 'missing.ts', 'only.ts', 'private.ts', 'id_rsa.pem', 'linked.ts',
    'link-out/index.ts', '../another project/index.ts', '../absent/also-absent.ts', '.ssh/only.ts', join(config, 'private.ts'),
    'a[*].txt', 'app/sp ace.md', join(cwd, 'app/index.ts'), 'app'];
  assert.deepEqual(await access.resolve(workspace.id, refs), [
    { path: 'src/panel/ProxyPanel.tsx' }, null, { path: 'index.ts' }, 'missing', 'missing', 'missing', null, 'missing',
    null, { path: join(sibling, 'index.ts') }, null, null, null, { path: 'src/panel/a[*].txt' }, { path: 'app/sp ace.md' }, { path: 'app/index.ts' }, { path: 'app' },
  ]);
  assert.deepEqual(calls, []);
  // Written from a subfolder: a relative path that is not at the root is found below it when unique.
  await mkdir(join(cwd, 'tools/video/build'), { recursive: true });
  await writeFile(join(cwd, 'tools/video/build/clip_v10.mp4'), 'mp4'); await writeFile(join(cwd, 'tools/video/build/clip_v10.srt'), 'srt');
  assert.deepEqual(await access.resolve(workspace.id, ['build/clip_v10.mp4', 'clip_v10.srt', 'panel/ProxyPanel.tsx', 'video/missing.mp4']), [
    { path: 'tools/video/build/clip_v10.mp4' }, { path: 'tools/video/build/clip_v10.srt' }, { path: 'src/panel/ProxyPanel.tsx' }, null,
  ], 'a build folder the batch names is searched for its bare names too');
  assert.deepEqual(await access.resolve(workspace.id, ['clip_v10.srt']), ['missing'], 'build output stays out of a plain name search');
  await mkdir(join(cwd, 'tools/other/build'), { recursive: true }); await writeFile(join(cwd, 'tools/other/build/clip_v10.mp4'), 'other');
  assert.deepEqual(await access.resolve(workspace.id, ['build/clip_v10.mp4', 'video/build/clip_v10.mp4']), [null, { path: 'tools/video/build/clip_v10.mp4' }],
    'two candidates are ambiguous; a longer path settles it');
  await rm(join(cwd, 'index.ts'));
  for (const generated of ['node_modules/pkg', 'dist', '.venv', 'target/debug']) {
    await mkdir(join(cwd, generated), { recursive: true }); await writeFile(join(cwd, generated, 'index.ts'), 'not project source');
  }
  assert.deepEqual(await access.resolve(workspace.id, ['index.ts', 'node_modules/pkg/index.ts']), [
    { path: 'app/index.ts' }, { path: 'node_modules/pkg/index.ts' },
  ]);
  assert.deepEqual(await access.resolve('second', ['ProxyPanel.tsx', 'index.ts']), ['missing', { path: 'index.ts' }]);
  await assert.rejects(() => access.resolve(workspace.id, Array(33).fill('x')), /批次/);
});

test("a reply's relative paths are resolved from the directory Claude Code was in when it wrote them", posix, async t => {
  const { base, cwd, config, workspace, artifacts } = await fixture(t);
  const sub = join(cwd, 'sub'), outside = join(base, 'added dir');
  for (const folder of [join(sub, 'deep'), join(cwd, 'other'), outside]) await mkdir(folder, { recursive: true });
  await Promise.all([join(cwd, 'notes.md'), join(sub, 'notes.md'), join(sub, 'deep/x.md'), join(cwd, 'other/unique.md'), join(cwd, 'root-only.md'),
    join(outside, 'data.csv'), join(sub, '.env')].map(file => writeFile(file, file)));
  const access = new ArtifactAccess(() => workspace, artifacts, { allowOutside: async () => false, saveAs: async () => undefined });
  const at = (dir: string, ...paths: string[]) => paths.map(path => ({ path, cwd: dir }));
  // Without a directory (or written at the root) a name in two places is as before; at the root, the root's file is the one meant.
  assert.deepEqual(await access.resolve(workspace.id, ['notes.md', ...at(cwd, 'notes.md', 'sub/notes.md', 'unique.md', '../added dir/data.csv')]), [
    null, { path: 'notes.md' }, { path: 'sub/notes.md' }, { path: 'other/unique.md' }, { path: join(outside, 'data.csv') },
  ]);
  // In a subfolder: exact there first; not there, the folder's rules; never above it for `../`.
  assert.deepEqual(await access.resolve(workspace.id, at(sub, 'notes.md', './notes.md', '../notes.md', 'deep/x.md', 'x.md', 'unique.md', 'root-only.md',
    '../unique.md', '../absent.md', 'absent.md', '.env', '../../added dir/data.csv')), [
    { path: 'sub/notes.md' }, { path: 'sub/notes.md' }, { path: 'notes.md' }, { path: 'sub/deep/x.md' }, { path: 'sub/deep/x.md' },
    { path: 'other/unique.md' }, { path: 'root-only.md' }, null, null, 'missing', null, { path: join(outside, 'data.csv') },
  ]);
  // Outside the folder (an --add-dir directory): only that path is checked there, nothing is searched.
  assert.deepEqual(await access.resolve(workspace.id, at(outside, 'data.csv', './data.csv', 'notes.md', 'unique.md', 'sub/notes.md')), [
    { path: join(outside, 'data.csv') }, { path: join(outside, 'data.csv') }, null, null, null,
  ]);
  // Protected places stay closed from any directory; a directory that is not absolute is ignored.
  assert.deepEqual(await access.resolve(workspace.id, [...at(config, 'private.ts'), ...at('sub', 'notes.md'), ...at(base, 'Project with spaces/notes.md')]),
    [null, null, { path: 'notes.md' }]);
  await assert.rejects(() => access.resolve(workspace.id, [{ path: 'x', cwd: 1 } as never]), /批次/);
});

test('reference searches use the selected transport and discard a changed workspace while in flight', posix, async t => {
  const { base, workspace } = await fixture(t);
  const ssh: Workspace = { id: 'ssh', name: 'same folder', kind: 'ssh', host: 'fixture-host', cwd: '~/project' };
  const other: Workspace = { id: 'other', name: 'same folder', kind: 'ssh', host: 'other-host', cwd: '~/project' };
  // An isolated target home per machine, with the same logical cwd and basename. No actual sshd required.
  for (const ws of [ssh, other]) {
    const parent = join(base, ws.id, 'project', ws.id + '-source');
    await mkdir(parent, { recursive: true }); await writeFile(join(parent, 'index.ts'), ws.id);
  }
  const calls: string[] = [];
  const host = new class extends Transport {
    override run(ws: Workspace, script: string, options?: CommandOptions) {
      assert.ok(ws === ssh || ws === other);
      calls.push(ws.id + ':' + options?.tag);
      return runCommand(workspace, `export HOME=${quoteShell(join(base, ws.id))}\n${script}`, options);
    }
  }();
  const files = new WorkspaceArtifacts(host);
  let selected = ssh;
  const access = new ArtifactAccess(() => selected, files, { allowOutside: async () => false, saveAs: async () => undefined });
  assert.deepEqual(await access.resolve(ssh.id, ['index.ts']), [{ path: 'ssh-source/index.ts' }]);
  const old = access.resolve(ssh.id, ['index.ts']);
  selected = other;
  await assert.rejects(old, /变化/);
  assert.deepEqual(await access.resolve(other.id, ['index.ts']), [{ path: 'other-source/index.ts' }]);
  assert.equal(calls.filter(call => call === 'ssh:artifact.resolve').length, 2);
  assert.equal(calls.filter(call => call === 'other:artifact.resolve').length, 1);
});

test('paged directory browsing reaches all children including a file named more', posix, async t => {
  const { cwd, workspace, artifacts } = await fixture(t);
  await mkdir(join(cwd, 'dir'));
  await writeFile(join(cwd, 'dir/more'), '');
  assert.equal((await artifacts.list(workspace, 'dir')).entries[0].name, 'more');
  for (let start = 0; start < 252; start += 32) {
    await Promise.all(Array.from({ length: Math.min(32, 252 - start) }, (_, i) => writeFile(join(cwd, 'dir', 'item-' + (start + i)), '')));
  }
  const first = await artifacts.preview(workspace, 'dir');
  assert.equal(first.kind, 'directory');
  if (first.kind !== 'directory') throw new Error('expected directory');
  assert.equal(first.nextOffset, 250);
  const second = await artifacts.list(workspace, 'dir', first.nextOffset);
  assert.equal(second.nextOffset, undefined);
  assert.equal(new Set([...first.entries, ...second.entries].map(entry => entry.name)).size, 253);
});

test('text and media previews have separate bounds and full downloads preserve arbitrary bytes', posix, async t => {
  const { cwd, base, workspace, artifacts } = await fixture(t);
  const text = Buffer.from('👍'.repeat(70_000));
  await writeFile(join(cwd, 'text.log'), Buffer.concat([Buffer.from('X'), text]));
  const preview = await artifacts.preview(workspace, 'text.log');
  assert.equal(preview.truncated, true); assert.equal(preview.kind, 'text'); assert.ok(!preview.text!.includes('\ufffd'));
  const file = Buffer.alloc(13 * 1024 * 1024, 0x80);
  file.write('%PDF-1.4'); file[file.length - 1] = 0xff;
  const filename = join(cwd, 'large.pdf'), saved = join(base, 'saved copy.pdf');
  await writeFile(filename, file);
  const large = await artifacts.preview(workspace, 'large.pdf');
  assert.equal(large.kind, 'binary'); assert.equal(large.data, undefined); assert.equal(large.truncated, true);
  const download = await artifacts.prepareDownload(workspace, 'large.pdf');
  await download.saveTo(saved);
  assert.deepEqual(await readFile(saved), file);
  await rename(filename, filename + '.before');
  await writeFile(filename, 'changed');
  await assert.rejects(() => download.saveTo(saved), /已变更/);
  assert.deepEqual(await readFile(saved), file);
  assert.equal((await readdir(base)).some(name => name.startsWith('.lectern-download-')), false);
});

test('audio and video are recognised from their headers and read whole under their own bound', posix, async t => {
  const { cwd, workspace, artifacts } = await fixture(t);
  const box = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp' + brand + '\0\0\0\0isomiso2'), Buffer.alloc(64, 7)]);
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(32)]);
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from('webm'), Buffer.alloc(40)]);
  const mp3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(400)]);
  const cases: [string, Buffer, string, string][] = [
    ['clip.mp4', box('isom'), 'video', 'video/mp4'], ['phone.mov', box('qt  '), 'video', 'video/quicktime'],
    ['screen.webm', webm, 'video', 'video/webm'], ['voice.m4a', box('M4A '), 'audio', 'audio/mp4'],
    ['tone.wav', wav, 'audio', 'audio/wav'], ['song.mp3', mp3, 'audio', 'audio/mpeg'],
    // Content decides: a video under another name still plays.
    ['recording.bin', box('mp42'), 'video', 'video/mp4'],
  ];
  for (const [name, bytes] of cases) await writeFile(join(cwd, name), bytes);
  for (const [name, bytes, kind, mime] of cases) {
    const preview = await artifacts.preview(workspace, name);
    assert.equal(preview.kind, kind, name); assert.equal(preview.mime, mime, name);
    assert.deepEqual(Buffer.from(preview.data!), bytes, name);
  }
  await writeFile(join(cwd, 'notes.mp4'), 'plain words, not a container');
  const fake = await artifacts.preview(workspace, 'notes.mp4');
  assert.equal(fake.kind, 'binary'); assert.equal(fake.data, undefined); assert.equal(fake.text, undefined);
  // Past 64 MiB nothing is sent; the sparse file is never read.
  await writeFile(join(cwd, 'long.mp4'), box('isom'));
  await truncate(join(cwd, 'long.mp4'), 64 * 1024 * 1024 + 1);
  const long = await artifacts.preview(workspace, 'long.mp4');
  assert.equal(long.kind, 'binary'); assert.equal(long.truncated, true); assert.match(long.notice!, /64 MiB/);
  // Images keep the 12 MiB bound even under a video name.
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await writeFile(join(cwd, 'still.mp4'), Buffer.concat([png, Buffer.alloc(13 * 1024 * 1024)]));
  const still = await artifacts.preview(workspace, 'still.mp4');
  assert.equal(still.kind, 'binary'); assert.match(still.notice!, /12 MiB/);
});

test('automatic name searches from a home-folder workspace never walk into macOS privacy folders', { skip: process.platform !== 'darwin' }, async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'lectern-home-')));
  const previous = process.env.HOME;
  process.env.HOME = home;
  const backend = new Backend();
  t.after(async () => { process.env.HOME = previous; await backend.dispose(); await rm(home, { recursive: true, force: true }); });
  for (const dir of ['Desktop/thesis', 'Documents', 'Downloads', 'src']) await mkdir(join(home, dir), { recursive: true });
  await Promise.all([
    writeFile(join(home, 'Desktop/thesis/draft-notes.md'), 'on the desktop'),
    writeFile(join(home, 'Documents/plan-notes.md'), 'in documents'),
    writeFile(join(home, 'src/code-notes.md'), 'in the project'),
  ]);
  const workspace: Workspace = { id: 'home', name: 'home', kind: 'local', cwd: home, claudeDir: join(home, '.claude') };
  const found = await backend.artifacts.resolveReferences(workspace, ['draft-notes.md', 'plan-notes.md', 'code-notes.md', 'Desktop/thesis/draft-notes.md']);
  assert.deepEqual(found, ['missing', 'missing', { path: 'src/code-notes.md' }, { path: 'Desktop/thesis/draft-notes.md' }],
    'bare names are searched outside the privacy folders; an explicit path still resolves');
  const complete = (prefix: string) => backend.artifacts.complete(workspace, prefix, new AbortController().signal).then(items => items.map(item => item.value));
  assert.deepEqual(await complete('notes'), ['src/code-notes.md']);
  assert.deepEqual(await complete('Desk'), ['Desktop'], 'the folder itself is still offered by name');
  assert.deepEqual(await complete('Desktop/thesis/dr'), ['Desktop/thesis/draft-notes.md'], 'typing into it is an explicit choice');
});

test('outside access requires explicit consent, grants only the selected path, expires with the window, and saves only on confirmation', posix, async t => {
  const { base, workspace, artifacts } = await fixture(t);
  const outside = join(base, 'outside'), sibling = join(base, 'sibling.txt');
  await mkdir(outside); await writeFile(join(outside, 'ok.txt'), 'ok'); await writeFile(sibling, 'sibling');
  await assert.rejects(() => artifacts.preview(workspace, '../outside/ok.txt'), /工作目录之外/);
  const prompts: string[] = [], saves: string[] = [];
  let accept = false, destination: string | undefined;
  const access = new ArtifactAccess(() => workspace, artifacts, {
    allowOutside: async (_, path) => { prompts.push(path); return accept; },
    saveAs: async name => { saves.push(name); return destination; },
  });
  await assert.rejects(() => access.previewInlineImage(workspace.id, outside + '/plot.png'), /工作目录之外/);
  assert.equal(prompts.length, 0);
  await assert.rejects(() => access.preview(workspace.id, outside), /取消/);
  accept = true;
  const dir = await access.preview(workspace.id, outside); assert.equal(dir.path, outside); assert.equal(dir.kind, 'directory');
  accept = false;
  assert.equal((await access.preview(workspace.id, outside + '/ok.txt')).text, 'ok');
  await assert.rejects(() => access.preview(workspace.id, sibling), /取消/);
  await assert.rejects(() => access.preview(workspace.id, join(outside, '.ssh/config')), /凭据/);
  assert.deepEqual(prompts, [outside, outside, sibling]);
  assert.equal(await access.download(workspace.id, outside + '/ok.txt'), false);
  destination = join(base, 'saved');
  assert.equal(await access.download(workspace.id, outside + '/ok.txt'), true);
  assert.deepEqual(saves, ['ok.txt', 'ok.txt']);
  assert.equal(await readFile(destination, 'utf8'), 'ok');
  access.reset();
  await assert.rejects(() => access.preview(workspace.id, outside + '/ok.txt'), /取消/);
});

test('static SVG renders as an image and SVG with active content or off-file dependencies renders as escaped code', posix, async t => {
  const { cwd, workspace, artifacts } = await fixture(t);
  const safe = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><linearGradient id="tone"><stop offset="1" stop-color="#ffcc00"/></linearGradient></defs><path fill="url(#tone)" d="M0 0 L2 2"/></svg>';
  await writeFile(join(cwd, 'diagram.svg'), safe);
  assert.equal((await artifacts.preview(workspace, 'diagram.svg')).mime, 'image/svg+xml');
  for (const fragment of ['<script/>', '<foreignObject/>', '<a href="https://test.invalid"/>', '<image href="file:///other"/>', '<rect fill="url(https://test.invalid)"/>', '<g onload="alert(1)"/>', '<rect style="fill:red"/>']) {
    const source = safe.replace('</svg>', fragment + '</svg>');
    await writeFile(join(cwd, 'diagram.svg'), source);
    const preview = await artifacts.preview(workspace, 'diagram.svg');
    assert.equal(preview.kind, 'code'); assert.equal(preview.text, source); assert.equal(preview.data, undefined);
  }
});

test('download detects an in-place change of the same length', posix, async t => {
  const { cwd, base, workspace, artifacts } = await fixture(t);
  const file = join(cwd, 'data');
  await writeFile(file, 'before');
  const download = await artifacts.prepareDownload(workspace, 'data');
  await writeFile(file, 'after!');
  await assert.rejects(() => download.saveTo(join(base, 'save.txt')), /已变更/);
});

test('native plan, skill and command Markdown can be browsed without exposing private profile files', posix, async t => {
  const { cwd, config, workspace, artifacts } = await fixture(t);
  const skill = join(config, 'skills/helper'), command = join(cwd, '.claude/commands/team'), plans = join(config, 'plans');
  for (const dir of [skill, command, plans]) await mkdir(dir, { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '# Skill');
  await writeFile(join(skill, 'raw.jsonl'), '{"private":true}');
  await writeFile(join(command, 'run.md'), '# Run');
  await writeFile(join(plans, 'current.md'), '# Plan');
  await writeFile(join(plans, 'raw.jsonl'), 'private');
  assert.deepEqual((await artifacts.list(workspace, plans)).entries.map(e => e.name), ['current.md']);
  assert.deepEqual((await artifacts.list(workspace, skill)).entries.map(e => e.name), ['SKILL.md']);
  for (const path of [join(skill, 'SKILL.md'), join(command, 'run.md'), join(plans, 'current.md')]) {
    assert.equal((await artifacts.preview(workspace, path)).kind, 'markdown');
  }
  for (const path of [config, join(config, 'settings.json'), join(config, 'projects/old/history.jsonl'), join(plans, 'raw.jsonl'), join(skill, 'raw.jsonl'), join(skill, '.env')]) {
    await assert.rejects(() => artifacts.preview(workspace, path));
    await assert.rejects(() => artifacts.prepareDownload(workspace, path));
  }
});

// High-entropy raster: neither the original dimensions nor the compressed bytes fit a thumbnail.
function samplePng() {
  const width = 960, height = 480;
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]), length = Buffer.alloc(4), crc = Buffer.alloc(4);
    length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((1 + width * 3) * height);
  let seed = 23;
  for (let i = 0; i < pixels.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    if (i % (1 + width * 3)) pixels[i] = seed >>> 24;
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
function sampleGif() {
  // Two 480×4 frames: red, then blue.
  return Buffer.from('R0lGODdh4AEEAIEAAP8AAAAAAAAAAAAAACwAAAAA4AEEAAAISAABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzhz6tzJs2fHgAAh+QQBAAABACwAAAAA4AEEAIEAAP8AAAAAAAAAAAAISAABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzhz6tzJs2fHgAA7', 'base64');
}
const hostConverter = process.platform === 'darwin' || spawnSync('python3', ['-I', '-c', 'import PIL.Image'], { cwd: '/', stdio: 'ignore' }).status === 0;

test('workspace thumbnails send only bounded target-encoded frames over the selected SSH machine', posix, async t => {
  const { cwd, workspace } = await fixture(t);
  const png = samplePng(), gif = sampleGif();
  assert.ok(png.length > THUMB_BYTES);
  await writeFile(join(cwd, 'unusual name'), png); await writeFile(join(cwd, 'anim.gif'), gif);
  const tags: string[] = [];
  const transport = new class extends Transport {
    override async run(ws: Workspace, script: string, options?: CommandOptions) {
      assert.equal(ws.kind, 'ssh');
      tags.push(ws.host + ':' + options?.tag);
      const result = await runCommand(workspace, script, options); // Simulate the target; no real SSH connection.
      if (options?.tag === 'artifact.thumbnail') {
        assert.ok(options.maxBytes! <= THUMB_BYTES + 512);
        assert.ok(result.stdout.length <= options.maxBytes!);
        assert.ok(!result.stdout.includes(png) && !result.stdout.includes(gif));
      }
      return result;
    }
  }();
  const files = new WorkspaceArtifacts(transport);
  for (const host of ['png-host', 'gif-host']) {
    const ws: Workspace = { ...workspace, kind: 'ssh', host }, still = host === 'png-host';
    const name = still ? 'unusual name' : 'anim.gif';
    const preview = await files.thumbnail(ws, name);
    assert.equal(preview.path, name); assert.equal(preview.size, (still ? png : gif).length);
    if (hostConverter) {
      assert.equal(preview.mime, 'image/png'); assert.equal(preview.kind, 'image');
      const bytes = Buffer.from(preview.data!);
      assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [THUMB_EDGE, still ? THUMB_EDGE / 2 : 2]);
    } else { assert.equal(preview.kind, 'binary'); assert.equal(preview.data, undefined); }
  }
  assert.deepEqual(tags, ['png-host:artifact.workspace', 'png-host:artifact.thumbnail', 'gif-host:artifact.workspace', 'gif-host:artifact.thumbnail']);
});

test('automatic thumbnails never use outside grants, links, credential paths or original-byte fallbacks', posix, async t => {
  const { base, cwd, workspace, artifacts } = await fixture(t);
  const gif = sampleGif(), outside = join(base, 'outside.gif');
  await writeFile(outside, gif); await symlink(outside, join(cwd, 'link.gif')); await writeFile(join(cwd, 'allowed.gif'), gif);
  await writeFile(join(cwd, 'not.png'), '<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///private"/></svg>');
  await writeFile(join(cwd, 'huge.gif'), gif); await truncate(join(cwd, 'huge.gif'), THUMB_INPUT_BYTES + 1);
  let prompts = 0;
  const access = new ArtifactAccess(() => workspace, artifacts, { allowOutside: async () => { prompts++; return true; }, saveAs: async () => undefined });
  assert.equal((await access.preview(workspace.id, outside)).kind, 'image');
  for (const path of [outside, 'link.gif', '.ssh/private.png', '.claude/skills/hidden.png', 'custom config/private.gif', '.']) {
    await assert.rejects(() => access.previewInlineImageThumbnail(workspace.id, path));
  }
  assert.equal(prompts, 1);
  for (const path of ['not.png', 'huge.gif']) {
    const preview = await access.previewInlineImageThumbnail(workspace.id, path);
    assert.equal(preview.kind, 'binary'); assert.equal(preview.data, undefined);
  }
  const noTools = new WorkspaceArtifacts(new class extends Transport {
    override run(ws: Workspace, script: string, options?: CommandOptions) {
      return runCommand(ws, 'uname() { printf Linux; }; python3() { return 127; };\n' + script, options);
    }
  }());
  const placeholder = await noTools.thumbnail(workspace, 'allowed.gif');
  assert.equal(placeholder.kind, 'binary'); assert.equal(placeholder.data, undefined);
  assert.deepEqual(Buffer.from((await artifacts.preview(workspace, 'allowed.gif')).data!), gif);
});

test('embedded thumbnails decode once per revision, share in-flight work, and leave the original intact', posix, async () => {
  const [gif, png] = [sampleGif(), samplePng()].map((bytes, i) => transcriptAttachments('same-record', [
    { type: 'image', title: 'same name', source: { type: 'base64', media_type: i ? 'image/png' : 'image/gif', data: bytes.toString('base64') } },
  ])[0]);
  assert.equal(gif.ref.id, png.ref.id);
  const thumbnails = new AttachmentThumbnails();
  const a = thumbnails.preview(gif);
  assert.equal(thumbnails.preview({ ...gif }), a);
  const b = thumbnails.preview(png);
  assert.notEqual(a, b);
  for (const promise of [a, b]) {
    const preview = await promise;
    if (hostConverter) {
      assert.equal(preview.kind, 'image'); assert.equal(preview.mime, 'image/png');
      const data = Buffer.from(preview.data!);
      assert.ok(data.length <= THUMB_BYTES);
      assert.deepEqual([data.readUInt32BE(16), data.readUInt32BE(20)], [THUMB_EDGE, promise === a ? 2 : THUMB_EDGE / 2]);
    } else { assert.equal(preview.kind, 'binary'); assert.equal(preview.data, undefined); }
  }
  assert.equal(thumbnails.preview(gif), a);
  assert.deepEqual(Buffer.from((await attachmentPreview(gif)).data!), sampleGif());
  assert.deepEqual(Buffer.from((await attachmentPreview(png)).data!), samplePng());
});

test('thumbnail IPC rejects invalid, oversized or non-raster converter output', async () => {
  const png = samplePng();
  assert.equal(thumbnailPreview('x', 'x', png.length, png).kind, 'binary');
  const smallBody = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+paWQAAAAASUVORK5CYII=', 'base64');
  smallBody.writeUInt32BE(90000, 16);
  assert.equal(thumbnailPreview('x', 'x', 0, smallBody).data, undefined);
  const unsupported = transcriptAttachments('row', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('<svg/>').toString('base64') } }])[0];
  let calls = 0;
  const result = await new AttachmentThumbnails(async () => { calls++; return smallBody; }).preview(unsupported);
  assert.equal(calls, 0); assert.equal(result.kind, 'binary'); assert.equal(result.data, undefined);
});

test('macOS built-in temp-directory alias works for an explicitly approved external file', { skip: process.platform !== 'darwin' }, async t => {
  const { workspace, artifacts } = await fixture(t);
  const dir = await mkdtemp('/tmp/lectern-external-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'a.txt');
  await writeFile(path, 'temp');
  const requested: string[] = [];
  const preview = await artifacts.preview(workspace, path, async value => { requested.push(value); });
  assert.equal(preview.text, 'temp'); assert.deepEqual(requested, [await realpath(path)]);
});
