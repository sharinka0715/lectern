import { fixtureClaudeConfig } from './helpers/claude-config';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { Backend } from '../src/backend';
import { THUMB_BYTES, THUMB_EDGE, THUMB_INPUT_BYTES, ThumbnailCache } from '../src/backend/image-thumbnail';
import { WorkspaceArtifacts } from '../src/backend/artifacts';
import { Transport, runCommand, quoteShell, type CommandOptions } from '../src/backend/transport';
import { ArtifactAccess } from '../src/main/artifact-access';
import type { ArtifactPreview, Workspace } from '../src/shared/types';

const posix = { skip: process.platform === 'win32' ? 'Shell host fixtures run on POSIX' : false };
const converter = process.platform === 'darwin' || spawnSync('python3', ['-I', '-c', 'import PIL.Image'], { cwd: '/', stdio: 'ignore' }).status === 0;

/** An RGB PNG whose pixels come from `color(x, y)`. */
function png(width: number, height: number, color: (x: number, y: number) => [number, number, number]) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]), length = Buffer.alloc(4), crc = Buffer.alloc(4);
    length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((1 + width * 3) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows.set(color(x, y), y * (1 + width * 3) + 1 + x * 3);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const size = (preview: ArtifactPreview) => {
  const bytes = Buffer.from(preview.data!);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};

test('the thumbnail cache keeps the most recently used files and one stamp per file', () => {
  const cache = new ThumbnailCache(2);
  const preview = (name: string): ArtifactPreview => ({ kind: 'binary', name, path: name, mime: 'application/octet-stream', size: 1, truncated: false });
  cache.set('a', '1', preview('a')); cache.set('b', '1', preview('b'));
  cache.set('a', '2', preview('a2'));
  cache.set('c', '1', preview('c'));
  assert.equal(cache.get('b'), undefined, 'the least recently stored file goes first');
  assert.deepEqual(cache.get('a'), { stamp: '2', preview: preview('a2') });
  assert.equal(cache.get('c')?.stamp, '1');
  cache.clear();
  assert.equal(cache.get('a'), undefined);
});

/** A local folder read through a transport that counts decoder runs (sips's signature probe, or python3)
 * and records how many body bytes each thumbnail reply carried after its header. */
async function counted(t: TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lectern-attached-')));
  const cwd = join(base, 'Project'), outside = join(base, 'Uploads'), counter = join(base, 'decodes');
  await mkdir(cwd); await mkdir(outside); await writeFile(counter, '');
  const workspace: Workspace = { id: 'attached', name: 'Project', kind: 'local', cwd };
  fixtureClaudeConfig(join(cwd, '.claude'));
  const bodies: number[] = [];
  const prefix = `lectern_count() { printf x >> ${quoteShell(counter)}; }
od() { lectern_count; command od "$@"; }
python3() { lectern_count; command python3 "$@"; }
`;
  const artifacts = new WorkspaceArtifacts(new class extends Transport {
    override async run(ws: Workspace, script: string, options?: CommandOptions) {
      const result = await runCommand(ws, prefix + script, options);
      if (options?.tag === 'artifact.thumbnail') {
        assert.ok(result.stdout.length <= THUMB_BYTES + 512);
        bodies.push(result.stdout.length - result.stdout.indexOf(0, 5) - 1);
      }
      return result;
    }
  }());
  let prompts = 0;
  const access = new ArtifactAccess(() => workspace, artifacts, { allowOutside: async () => { prompts++; return true; }, saveAs: async () => undefined });
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, cwd, outside, workspace, access, bodies, decodes: async () => (await readFile(counter, 'utf8')).length, prompts: () => prompts };
}

test('attached images outside the folder get bounded thumbnails, decoded once until the file changes', posix, async t => {
  const { cwd, outside, workspace, access, bodies, decodes, prompts } = await counted(t);
  // Wide, then replaced in place by a tall one: the stamp (size, inode, mtime, ctime) changes.
  const wide = png(1200, 300, x => x < 450 || x >= 750 ? [220, 40, 40] : [40, 180, 60]);
  const tall = png(300, 1200, (_, y) => y < 450 || y >= 750 ? [230, 200, 40] : [40, 90, 220]);
  const file = join(outside, 'shot.png');
  await writeFile(file, wide);
  const first = await access.attachmentThumbnail(workspace.id, file);
  assert.equal(first.path, file);
  assert.equal(await decodes(), 1);
  if (converter) {
    assert.equal(first.kind, 'image'); assert.equal(first.mime, 'image/png');
    assert.deepEqual(size(first), [THUMB_EDGE, THUMB_EDGE / 4]);
    assert.ok(!Buffer.from(first.data!).equals(wide) && first.data!.length < wide.length);
  } else assert.equal(first.kind, 'binary');
  assert.equal(await access.attachmentThumbnail(workspace.id, file), first, 'an unchanged file reuses the cached thumbnail');
  assert.equal(await decodes(), 1, 'and is not decoded again');
  assert.equal(bodies.at(-1), 0, 'nor sent again: only the header crosses the connection');
  await writeFile(file, tall);
  const changed = await access.attachmentThumbnail(workspace.id, file);
  assert.equal(await decodes(), 2);
  if (converter) assert.deepEqual(size(changed), [THUMB_EDGE / 4, THUMB_EDGE]);
  assert.equal(prompts(), 0, 'attachments never ask for outside access');
  // The chat's thumbnail of the same file inside the folder shares the entry.
  await writeFile(join(cwd, 'square.png'), png(400, 400, () => [120, 60, 160]));
  const inline = await access.previewInlineImageThumbnail(workspace.id, 'square.png');
  assert.equal(await access.attachmentThumbnail(workspace.id, join(cwd, 'square.png')), inline);
  assert.equal(await decodes(), 3);
});

test('attached thumbnails cache failures, skip oversized files and still refuse links and protected paths', posix, async t => {
  const { base, cwd, outside, workspace, access, bodies, decodes } = await counted(t);
  const text = join(outside, 'notes.png'), huge = join(outside, 'huge.png');
  await writeFile(text, 'not an image');
  await writeFile(huge, png(8, 8, () => [0, 0, 0])); await truncate(huge, THUMB_INPUT_BYTES + 1);
  for (const path of [text, text, huge, huge]) {
    const preview = await access.attachmentThumbnail(workspace.id, path);
    assert.equal(preview.kind, 'binary'); assert.equal(preview.data, undefined);
  }
  assert.ok(await decodes() <= 1, 'the unsupported file is probed at most once; the oversized one never');
  assert.deepEqual(bodies, [0, 0, 0, 0]);
  await writeFile(join(base, 'real.png'), png(4, 4, () => [1, 2, 3]));
  await symlink(join(base, 'real.png'), join(outside, 'link.png'));
  await mkdir(join(outside, '.ssh')); await writeFile(join(outside, '.ssh', 'key.png'), png(4, 4, () => [1, 2, 3]));
  for (const path of [join(outside, 'link.png'), join(outside, '.ssh', 'key.png'), join(cwd, '.claude', 'x.png'), '/etc/shadow']) {
    await assert.rejects(() => access.attachmentThumbnail(workspace.id, path));
  }
  // The chat's automatic thumbnails still read only inside the folder.
  await writeFile(join(outside, 'ok.png'), png(4, 4, () => [1, 2, 3]));
  await assert.rejects(() => access.previewInlineImageThumbnail(workspace.id, join(outside, 'ok.png')));
  assert.equal((await access.attachmentThumbnail(workspace.id, join(outside, 'ok.png'))).path, join(outside, 'ok.png'));
});

test('attached thumbnails stay out of macOS privacy folders unless the project folder is inside one', { skip: process.platform !== 'darwin' }, async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'lectern-home-')));
  const previous = process.env.HOME;
  process.env.HOME = home;
  const backend = new Backend();
  t.after(async () => { process.env.HOME = previous; await backend.dispose(); await rm(home, { recursive: true, force: true }); });
  for (const dir of ['Downloads', 'Documents/thesis', 'src']) await mkdir(join(home, dir), { recursive: true });
  const image = png(64, 32, () => [40, 120, 200]);
  for (const file of ['Downloads/shot.png', 'Documents/figure.png', 'src/plot.png']) await writeFile(join(home, file), image);
  const workspaces: Workspace[] = [
    { id: 'src', name: 'src', kind: 'local', cwd: join(home, 'src') },
    { id: 'thesis', name: 'thesis', kind: 'local', cwd: join(home, 'Documents/thesis') },
  ];
  const access = new ArtifactAccess(id => workspaces.find(ws => ws.id === id)!, backend.artifacts, { allowOutside: async () => true, saveAs: async () => undefined });
  await assert.rejects(() => access.attachmentThumbnail('src', join(home, 'Downloads/shot.png')), /隐私文件夹/);
  await assert.rejects(() => access.attachmentThumbnail('src', join(home, 'Documents/figure.png')), /隐私文件夹/);
  assert.equal((await access.attachmentThumbnail('src', join(home, 'src/plot.png'))).kind, 'image');
  assert.equal((await access.attachmentThumbnail('thesis', join(home, 'Documents/figure.png'))).kind, 'image', 'the folder is already in Documents');
  await assert.rejects(() => access.attachmentThumbnail('thesis', join(home, 'Downloads/shot.png')), /隐私文件夹/);
});
