import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachmentName, uploadAttachment } from '../src/backend/attachment-upload';
import { Transport } from '../src/backend/transport';
import { attachmentKind, findMentions, isUploadedAttachment, mentionFor, messageAttachmentLayout, pasteAttaches, samePath } from '../src/shared/attachments';
import type { Workspace } from '../src/shared/types';

test('a path becomes an @-mention, quoted when it has spaces or symbols', () => {
  assert.equal(mentionFor('/tmp/lectern-attachments-501/a1/截图.png'), '@/tmp/lectern-attachments-501/a1/截图.png');
  assert.equal(mentionFor('/Users/me/My Files/report (1).pdf'), '@"/Users/me/My Files/report (1).pdf"');
});

test('mentions are found as Claude Code reads them: at the start or after whitespace, quoted when needed', () => {
  assert.deepEqual(findMentions('看 @/a/b.png 和 @"/c d/e.txt"，邮件 dev@example.com'), [
    { start: 2, end: 11, path: '/a/b.png' }, { start: 14, end: 27, path: '/c d/e.txt' }]);
  assert.equal(isUploadedAttachment('/tmp/lectern-attachments-501/aB3dE6gH/image.png'), true);
  assert.equal(isUploadedAttachment('/home/dev/lectern-attachments-501/image.png'), false);
  assert.ok(samePath('/home/dev/project/src/a.png', 'src/a.png'));
  assert.ok(samePath('/home/dev/project/src/a.png', './src/a.png'));
  assert.ok(samePath('/private/var/folders/zz/T/x.png', '/var/folders/zz/T/x.png'));
  assert.ok(samePath('/home/dev/a.png', '~/a.png'));
  assert.ok(!samePath('/home/dev/project/xsrc/a.png', 'src/a.png'));
  assert.deepEqual(['shot.PNG', 'paper.pdf', 'main.ts', 'notes.md', 'data.csv', 'deck.pptx', 'a.tar.gz', 'clip.mov', 'song.mp3', 'src/', 'blob'].map(attachmentKind),
    ['image', 'pdf', 'code', 'text', 'sheet', 'slides', 'archive', 'video', 'audio', 'folder', 'file']);
});

test('a user message shows each attachment once: trailing mentions become cards, mentions inside the text chips', () => {
  const shot = '/tmp/lectern-attachments-0/aB3dE6gH/image.png', notes = '/home/dev/project/notes.txt';
  const files = [{ id: 'f1', name: 'image.png', path: shot, image: true as const }, { id: 'f2', name: 'notes.txt', path: notes },
    { id: 'f3', name: 'pasted.png', image: true as const }, { id: 'f4', name: 'report.pdf' }];
  const none = () => false;
  // As the composer sends it: the files after the text leave it and become cards; embedded images keep their place.
  let layout = messageAttachmentLayout(`看看这两个\n @${shot} @notes.txt `, files, none);
  assert.equal(layout.text, '看看这两个');
  assert.deepEqual(layout.chips, []);
  assert.deepEqual(layout.cards.map(card => card.key), ['f1', 'f2', 'f4']);
  // Named inside a sentence: a chip there, and no second card for the same file.
  layout = messageAttachmentLayout(`界面没兼容： @${shot} ，只能在终端操作。`, files.slice(0, 1), none);
  assert.equal(layout.text, `界面没兼容： @${shot} ，只能在终端操作。`);
  assert.deepEqual(layout.chips.map(chip => [chip.start, chip.attachment?.id]), [[7, 'f1']]);
  assert.deepEqual(layout.cards, []);
  // Before the transcript records the files (a message being sent), known paths count too.
  layout = messageAttachmentLayout(`看图 @${shot} `, [], isUploadedAttachment);
  assert.deepEqual([layout.text, layout.cards], ['看图', [{ key: 'path:' + shot, path: shot, attachment: undefined }]]);
  // Other mentions are ordinary text, and a message with no attachment is unchanged.
  layout = messageAttachmentLayout('读一下 @src/app.ts ', files.slice(0, 1), none);
  assert.deepEqual([layout.text, layout.chips.length, layout.cards.map(card => card.key)], ['读一下 @src/app.ts ', 0, ['f1']]);
  // Only files: no text left.
  assert.equal(messageAttachmentLayout(`@${shot}`, files.slice(0, 1), none).text, '');
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

test('a file is copied into a private directory under the target\'s TMPDIR', { skip: process.platform === 'win32' ? 'POSIX shell target; Windows runs no local commands' : false }, async () => {
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
