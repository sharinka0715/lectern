import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachmentName, uploadAttachment } from '../src/backend/attachment-upload';
import { Transport } from '../src/backend/transport';
import { appendMentions, insertMentions, mentionFor, pasteAttaches } from '../src/shared/attachments';
import type { Workspace } from '../src/shared/types';

test('a path becomes an @-mention, quoted when it has spaces or symbols', () => {
  assert.equal(mentionFor('/tmp/lectern-attachments-501/a1/截图.png'), '@/tmp/lectern-attachments-501/a1/截图.png');
  assert.equal(mentionFor('/Users/me/My Files/report (1).pdf'), '@"/Users/me/My Files/report (1).pdf"');
});

test('mentions go where the caret is, separated from the words around them', () => {
  assert.deepEqual(insertMentions('', 0, 0, ['/a.png']), { text: '@/a.png ', caret: 8 });
  assert.deepEqual(insertMentions('看看这张图', 5, 5, ['/a.png', '/b c.txt']), { text: '看看这张图 @/a.png @"/b c.txt" ', caret: 26 });
  // Replaces a selection; existing whitespace after the caret is kept, not doubled.
  assert.deepEqual(insertMentions('比较 XX 和', 3, 5, ['/a.png']), { text: '比较 @/a.png 和', caret: 10 });
  assert.equal(appendMentions('先说明', ['/a.png']), '先说明 @/a.png ');
});

test('copied cells with a picture of themselves paste as text', () => {
  assert.equal(pasteAttaches(0, [], 'text'), false);
  // A screenshot: an image with no text.
  assert.equal(pasteAttaches(1, [''], ''), true);
  // Spreadsheet cells: text and an image rendering.
  assert.equal(pasteAttaches(1, [''], 'A1\tB1'), false);
  // A file copied in Finder carries its name as text too.
  assert.equal(pasteAttaches(1, ['/Users/me/a.pdf'], 'a.pdf'), true);
});

test('uploaded names keep only a safe last path part', () => {
  assert.equal(attachmentName('../../etc/passwd'), 'passwd');
  assert.equal(attachmentName('C:\\Users\\me\\图 1.png'), '图 1.png');
  assert.equal(attachmentName(`a'$(touch x)"\`.txt`), 'a(touch x).txt');
  assert.equal(attachmentName('..'), 'attachment');
  assert.equal(attachmentName('\u0000\n'), 'attachment');
  const long = attachmentName('长'.repeat(200) + '.markdown');
  assert.equal([...long].length, 120);
  assert.ok(long.endsWith('.markdown'));
});

test('a file is copied into a private directory under the target\'s TMPDIR', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lectern-upload-')));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = root + '/';
  const transport = new Transport();
  const workspace: Workspace = { id: 'local', name: 'Local', kind: 'local', cwd: root };
  try {
    const uid = process.getuid!();
    const base = join(root, `lectern-attachments-${uid}`);
    // A directory from more than a week ago is cleaned up by the next upload.
    await mkdir(join(base, 'old'), { recursive: true });
    const week = Date.now() / 1000 - 9 * 86400;
    await utimes(join(base, 'old'), week, week);
    const bytes = Buffer.from([0, 1, 2, 255, 10, 13, 0x5f]);
    const path = await uploadAttachment(transport, workspace, `截图 $(id)'.png`, bytes);
    assert.ok(path.startsWith(base + '/') && path.endsWith('/截图 (id).png'), path);
    assert.match(path.slice(base.length), /^\/[A-Za-z0-9]{8}\/[^/]+$/);
    assert.deepEqual(await readFile(path), bytes);
    assert.equal((await stat(base)).mode & 0o777, 0o700);
    assert.equal((await stat(join(path, '..'))).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(base)).filter(name => name === 'old'), []);
    // Two uploads of the same name never overwrite each other.
    const again = await uploadAttachment(transport, workspace, `截图 $(id)'.png`, Buffer.from('second'));
    assert.notEqual(again, path);
    assert.deepEqual(await readFile(path), bytes);

    // Another user's link in the place of the base directory is refused.
    await rm(base, { recursive: true });
    await mkdir(join(root, 'elsewhere'));
    await symlink(join(root, 'elsewhere'), base);
    await assert.rejects(uploadAttachment(transport, workspace, 'a.txt', Buffer.from('x')), /not private/);
    assert.ok((await lstat(base)).isSymbolicLink());
    assert.deepEqual(await readdir(join(root, 'elsewhere')), []);
    await assert.rejects(uploadAttachment(transport, workspace, 'empty.txt', Buffer.alloc(0)), /文件为空/);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    await transport.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
