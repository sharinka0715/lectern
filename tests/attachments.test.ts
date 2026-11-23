import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachmentName, uploadAttachment } from '../src/backend/attachment-upload';
import { Transport } from '../src/backend/transport';
import { attachmentKind, confirmsMention, findMentions, generatedName, isUploadedAttachment, mentionFor, messageFileLayout, messageFileNames, needsName, pasteAttaches, samePath } from '../src/shared/attachments';
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

test('a user message keeps every known file in its place as a chip; the row above has its images and unnamed attachments', () => {
  const shot = '/tmp/lectern-attachments-0/aB3dE6gH/image1.png', notes = '/home/dev/project/notes.txt';
  const files = [{ id: 'f1', name: 'image1.png', path: shot, image: true as const }, { id: 'f2', name: 'notes.txt', path: notes },
    { id: 'f3', name: 'pasted.png', image: true as const }, { id: 'f4', name: 'report.pdf' }];
  const none = () => false;
  // As the composer sends it: the files after the text stay there as chips; the image (once) and the
  // attachment no mention names go in the row; embedded images keep their place in the text.
  let layout = messageFileLayout(`看看这两个\n @${shot} @notes.txt @${shot}`, files, none);
  assert.deepEqual(layout.chips.map(chip => [chip.mention, chip.attachment?.id]), [[`@${shot}`, 'f1'], ['@notes.txt', 'f2'], [`@${shot}`, 'f1']]);
  assert.deepEqual(layout.row.map(item => item.key), ['f1', 'f4']);
  // Named inside a sentence: a chip there, the image in the row.
  const text = `界面没兼容： @${shot} ，只能在终端操作。`;
  layout = messageFileLayout(text, files.slice(0, 1), none);
  assert.deepEqual(layout.chips.map(chip => [chip.start, chip.end, text.slice(chip.start, chip.end) === chip.mention]), [[7, 7 + shot.length + 1, true]]);
  assert.deepEqual(layout.row.map(item => item.key), ['f1']);
  // Before the transcript records the files (a message being sent), known paths count too; quoted ones copy with their quotes.
  layout = messageFileLayout(`看图 @${shot} 和 @"src/my notes.md"`, [], path => isUploadedAttachment(path) || path === 'src/my notes.md');
  assert.deepEqual(layout.chips.map(chip => [chip.path, chip.mention]), [[shot, `@${shot}`], ['src/my notes.md', '@"src/my notes.md"']]);
  assert.deepEqual(layout.row, [{ key: 'path:' + shot, path: shot, attachment: undefined }]);
  // Other mentions are ordinary text, and a message with no attachment is unchanged.
  layout = messageFileLayout('读一下 @src/app.ts ', files.slice(0, 1), none);
  assert.deepEqual([layout.chips.length, layout.row.map(item => item.key)], [0, ['f1']]);
  assert.deepEqual(messageFileLayout('只有文字', [], none), { chips: [], row: [] });
});

test("a user message's mentions are the files Claude Code read from its directory then", () => {
  const sub = '/home/dev/project/sub', root = '/home/dev/project';
  const located = (path: string) => path.startsWith('/') ? undefined : `${sub}/${path}`.replace(/\/[^/]+\/\.\.\//, '/');
  // Claude Code recorded both: the file at the prompt's directory is the mention's, not the first that ends the same way.
  const files = [{ id: 'root', name: 'notes.md', path: `${root}/notes.md` }, { id: 'sub', name: 'notes.md', path: `${sub}/notes.md` }];
  let layout = messageFileLayout('@notes.md 和 @../notes.md', files, () => false, located);
  assert.deepEqual(layout.chips.map(chip => [chip.mention, chip.attachment?.id]), [['@notes.md', 'sub'], ['@../notes.md', 'root']]);
  // Not recorded: found from the directory (the chip opens that path), else as before.
  layout = messageFileLayout('@a.png @b.md @c.md', [], path => path === 'a.png' ? `${sub}/a.png` : path === 'b.md', located);
  assert.deepEqual(layout.chips.map(chip => [chip.mention, chip.path]), [['@a.png', `${sub}/a.png`], ['@b.md', 'b.md']]);
  assert.deepEqual(layout.row, [{ key: `path:${sub}/a.png`, path: `${sub}/a.png`, attachment: undefined }]);
  // Sent after a cd as an absolute path, a mention put back in the box is still confirmed by the check.
  assert.ok(confirmsMention(`${sub}/notes.md`, { path: 'sub/notes.md' }));
});

test('a reference check confirms the very file a mention names, not one found elsewhere', () => {
  assert.ok(confirmsMention('src/app.ts', { path: 'src/app.ts' }));
  assert.ok(confirmsMention('./src/app.ts', { path: 'src/app.ts' }));
  assert.ok(confirmsMention('notes.md', { path: 'notes.md' }));
  // A bare name or a relative path found below the folder is not what Claude Code reads.
  assert.ok(!confirmsMention('app.ts', { path: 'src/app.ts' }));
  assert.ok(!confirmsMention('src/app.ts', { path: 'packages/web/src/app.ts' }));
  // Absolute and home paths inside the folder come back relative; outside, as the real path.
  assert.ok(confirmsMention('/home/dev/project/src/app.ts', { path: 'src/app.ts' }));
  assert.ok(confirmsMention('~/project/src/app.ts', { path: 'src/app.ts' }));
  assert.ok(confirmsMention('/tmp/lectern-attachments-0/aB3dE6gH/image1.png', { path: '/private/tmp/lectern-attachments-0/aB3dE6gH/image1.png' }));
  assert.ok(confirmsMention('~/notes.txt', { path: '/home/dev/notes.txt' }));
  assert.ok(confirmsMention('../other/x.ts', { path: '/home/dev/other/x.ts' }));
  // Not found, not checked, or a folder written as one.
  for (const found of [null, 'missing', 'outside', undefined] as const) assert.ok(!confirmsMention('src/app.ts', found));
  assert.ok(!confirmsMention('src/', { path: 'src' }));
});

test('clipboard data without a name is named image1, image2… or file1…, after every number the chat already uses', () => {
  assert.equal(needsName('image.png', false), true, "Chromium's name for pasted pixels");
  assert.equal(needsName('', false), true);
  assert.equal(needsName('image.png', true), false, 'a file from disk keeps its name');
  assert.equal(needsName('截图 2026-11-23.png', false), false);
  assert.deepEqual(generatedName('image/png', 'image.png', []), { name: 'image1.png', number: 1, kind: 'image' });
  assert.equal(generatedName('image/jpeg', 'image.png', []).name, 'image1.jpg');
  // Numbers in the text and messages (any extension, any case) and the last one given all count.
  assert.equal(generatedName('image/png', 'image.png', ['image1.png', 'IMAGE3.jpg', 'notes.md', 'file7.txt']).name, 'image4.png');
  assert.equal(generatedName('image/png', 'image.png', ['image1.png'], { image: 5, file: 9 }).name, 'image6.png');
  assert.equal(generatedName('image/png', 'image.png', ['image2.png/x', 'myimage9.png', 'image.png']).name, 'image1.png');
  // Other data: file1 with the extension its type or its own name suggests.
  assert.equal(generatedName('text/plain', '', ['file1.txt']).name, 'file2.txt');
  assert.equal(generatedName('application/octet-stream', '', [], { image: 3 }).name, 'file1');
  assert.equal(generatedName('', 'data.CSV', []).name, 'file1.csv');
  assert.equal(generatedName('application/pdf', '', []).kind, 'file');
  // What a conversation already uses: the files its user messages name and their attachments.
  assert.deepEqual(messageFileNames([
    { role: 'user', text: '看 @/tmp/lectern-attachments-0/aB3dE6gH/image2.png 和 @"a b/file1.txt"', attachments: [{ name: 'image3.png' }] },
    { role: 'assistant', text: '@image9.png' }]), ['image2.png', 'file1.txt', 'image3.png']);
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
