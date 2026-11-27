import { fixtureClaudeConfig } from './helpers/claude-config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { completeUtf8, defaultOutputSource, outputTrailer, shownOutputSource, terminalText, windowStart } from '../src/shared/task-output';
import { decodeTaskOutput, taskOutputScript, type TaskOutputWindow } from '../src/backend/task-output-files';
import type { RedirectFile } from '../src/shared/shell-redirects';

const posix = process.platform !== 'win32';

test('the native trailer: exit code or killed, only at the very end', () => {
  // Shapes Claude Code 2.1.300–2.1.330 write (see the task column notes in CLAUDE.md).
  assert.deepEqual(outputTrailer('plain-1\nplain-done\n\n[exited with code 0]\n'), { body: 'plain-1\nplain-done\n', exitCode: 0 });
  assert.deepEqual(outputTrailer('failing-out\nfailing-err\n\n[exited with code 3]\n'), { body: 'failing-out\nfailing-err\n', exitCode: 3 });
  assert.deepEqual(outputTrailer('\n[exited with code 0]\n'), { body: '', exitCode: 0 });
  assert.deepEqual(outputTrailer('tick\ntick\n\n[killed]\n'), { body: 'tick\ntick\n', killed: true });
  assert.deepEqual(outputTrailer('[exited with code 1]\n'), { body: '', exitCode: 1 });
  assert.deepEqual(outputTrailer('still running\n'), { body: 'still running\n' });
  assert.deepEqual(outputTrailer('say [exited with code 2] here\n'), { body: 'say [exited with code 2] here\n' });
  assert.deepEqual(outputTrailer(''), { body: '' });
});

test('terminal text: colours dropped, carriage returns overwrite, backspaces apply', () => {
  assert.equal(terminalText('\x1b[32mok\x1b[0m done\n'), 'ok done\n');
  assert.equal(terminalText('\x1b]0;title\x07after'), 'after');
  assert.equal(terminalText('10%\r55%\r100%\nnext\n'), '100%\nnext\n');
  assert.equal(terminalText('abcdef\rxy'), 'xycdef');
  assert.equal(terminalText('line\r\nnext\r\n'), 'line\nnext\n');
  assert.equal(terminalText('progress\r'), 'progress');
  assert.equal(terminalText('ab\x08c'), 'ac');
  assert.equal(terminalText('tab\tkeeps\x00\x07'), 'tab\tkeeps');
  assert.equal(terminalText('中文\r\x1b[K完成'), '完成');
});

test('UTF-8 windows: a cut start skips the broken sequence and line; an unfinished end waits', () => {
  const bytes = Buffer.from('ä-first part\nsecond\n');
  assert.equal(windowStart(bytes.subarray(1), true), bytes.indexOf(10));
  assert.equal(windowStart(bytes, false), 0);
  const long = Buffer.concat([Buffer.from([0x80, 0x80]), Buffer.alloc(5000, 0x61)]);
  assert.equal(windowStart(long, true), 2, 'no newline nearby: only the broken sequence goes');
  const word = Buffer.from('ok 中');
  assert.equal(completeUtf8(word.subarray(0, word.length - 1)), 3);
  assert.equal(completeUtf8(word.subarray(0, word.length - 2)), 3);
  assert.equal(completeUtf8(word), word.length);
  assert.equal(completeUtf8(Buffer.from('plain')), 5);
  assert.equal(completeUtf8(Buffer.from('😀').subarray(0, 3)), 0);
});

test('the shown source: own output, else the redirect file, else the transcript; a valid choice wins', () => {
  const files: RedirectFile[] = [{ path: '/w/out.log', stream: 'both', append: false }, { path: '/w/err.log', stream: 'stderr', append: false }];
  assert.equal(defaultOutputSource({ found: true, empty: false }, files, true), 'task');
  assert.equal(defaultOutputSource({ found: true, empty: true }, files, true), 'file:0');
  assert.equal(defaultOutputSource({ found: false, empty: true }, files, true), 'file:0');
  assert.equal(defaultOutputSource({ found: false, empty: true }, [], true), 'transcript');
  assert.equal(defaultOutputSource({ found: true, empty: true }, [], true), 'task');
  assert.equal(defaultOutputSource({ found: false, empty: true }, [], false), 'task');
  assert.equal(shownOutputSource('file:1', { found: true, empty: false }, files, false), 'file:1');
  assert.equal(shownOutputSource('file:2', { found: true, empty: true }, files, false), 'file:0');
  assert.equal(shownOutputSource('task', { found: true, empty: true }, files, false), 'task');
  assert.equal(shownOutputSource('transcript', { found: true, empty: false }, files, false), 'task');
  assert.equal(shownOutputSource('../x', { found: true, empty: true }, [], false), 'task');
});

const sid = '00000000-0000-4011-8011-0000000000aa';
async function taskRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'lectern-task-output-'));
  const tasks = path.join(root, 'claude-1000', '-home-dev-proj', sid, 'tasks');
  await mkdir(tasks, { recursive: true });
  const read = (taskId: string, window: TaskOutputWindow, roots = [path.join(root, 'claude-1000')]) =>
    decodeTaskOutput(execFileSync('sh', ['-c', taskOutputScript(['/home/dev/.claude/projects/-home-dev-proj'], sid, taskId, window, roots)]));
  return { root, tasks, read };
}

test('task output file: tail, unchanged, appended and older windows', { skip: !posix && 'posix shell' }, async () => {
  const { root, tasks, read } = await taskRoot();
  try {
    const file = path.join(tasks, 'b1a2c3d4e.output');
    await writeFile(file, 'line-1\nline-2\nline-3\n');
    const first = read('b1a2c3d4e', { limit: 10 });
    assert.ok(first.found && !first.unchanged);
    assert.equal(first.mode, 'tail');
    assert.equal(first.size, 21);
    assert.equal(first.start, 11);
    assert.equal(first.bytes.toString(), '-2\nline-3\n');
    assert.deepEqual(read('b1a2c3d4e', { limit: 10, known: first.stamp }), { found: true, stamp: first.stamp, inode: first.inode, size: 21, unchanged: true });
    await appendFile(file, 'line-4\n\n[exited with code 0]\n');
    const appended = read('b1a2c3d4e', { limit: 10, known: first.stamp, from: 21, appendLimit: 1024 });
    assert.ok(appended.found && !appended.unchanged);
    assert.equal(appended.mode, 'from');
    assert.equal(appended.bytes.toString(), 'line-4\n\n[exited with code 0]\n');
    // Too much new output at once: the tail again.
    const jump = read('b1a2c3d4e', { limit: 10, from: 0, appendLimit: 8 });
    assert.ok(jump.found && !jump.unchanged && jump.mode === 'tail' && jump.bytes.length === 10);
    const older = read('b1a2c3d4e', { limit: 8, before: 11 });
    assert.ok(older.found && !older.unchanged);
    assert.equal(older.mode, 'before');
    assert.equal(older.start, 3);
    assert.equal(older.bytes.toString(), 'e-1\nline');
    const empty = read('b1a2c3d4e', { limit: 8, before: 0 });
    assert.ok(empty.found && !empty.unchanged && empty.bytes.length === 0);
    assert.deepEqual(read('bmissing00', { limit: 10 }), { found: false });
    // The second root is used when the first has no such file.
    const second = read('b1a2c3d4e', { limit: 4 }, [path.join(root, 'nowhere'), path.join(root, 'claude-1000')]);
    assert.ok(second.found);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('task output file: links anywhere below the root are refused; IDs are checked', { skip: !posix && 'posix shell' }, async () => {
  const { root, tasks, read } = await taskRoot();
  try {
    const secret = path.join(root, 'secret.txt');
    await writeFile(secret, 'private\n');
    await symlink(secret, path.join(tasks, 'blinked00.output'));
    assert.deepEqual(read('blinked00', { limit: 100 }), { found: false });
    // A linked session directory (or tasks directory) leads elsewhere: refused.
    const other = path.join(root, 'other', 'tasks');
    await mkdir(other, { recursive: true });
    await writeFile(path.join(other, 'bother000.output'), 'elsewhere\n');
    const sessionDir = path.join(root, 'claude-1000', '-home-dev-proj', sid);
    await rm(sessionDir, { recursive: true });
    await symlink(path.join(root, 'other'), sessionDir);
    assert.deepEqual(read('bother000', { limit: 100 }), { found: false });
    // A linked root is refused too.
    await symlink(path.join(root, 'claude-1000'), path.join(root, 'linked-root'));
    assert.deepEqual(read('bother000', { limit: 100 }, [path.join(root, 'linked-root')]), { found: false });
    assert.throws(() => taskOutputScript(['/p/x'], sid, '../etc/passwd', { limit: 1 }));
    assert.throws(() => taskOutputScript(['/p/x'], 'not-a-session', 'b1', { limit: 1 }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('redirect files: read windows of a growing file under the attachment rules', { skip: !posix && 'posix shell' }, async t => {
  const { realpath } = await import('node:fs/promises');
  const { Backend } = await import('../src/backend');
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'lectern-redirect-')));
  const cwd = path.join(base, 'proj'), outside = path.join(base, 'elsewhere'), config = path.join(cwd, 'cfg');
  await mkdir(config, { recursive: true }); await mkdir(outside);
  const backend = new Backend();
  t.after(async () => { await backend.dispose(); await rm(base, { recursive: true, force: true }); });
  const workspace = { id: 'redirect', name: 'proj', kind: 'local' as const, cwd };
  fixtureClaudeConfig(config);
  const log = path.join(cwd, 'logs', 'train.log');
  await mkdir(path.dirname(log)); await writeFile(log, 'epoch 1\nepoch 2\n');
  const first = await backend.artifacts.readWindow(workspace, log, { limit: 9 });
  assert.ok(!first.unchanged);
  assert.equal(first.path, log);
  assert.equal(first.mode, 'tail');
  assert.equal(first.bytes.toString(), 'h 1\nepoch 2\n'.slice(-9));
  assert.ok((await backend.artifacts.readWindow(workspace, log, { limit: 9, known: first.stamp })).unchanged);
  await appendFile(log, 'epoch 3\n');
  const more = await backend.artifacts.readWindow(workspace, 'logs/train.log', { limit: 9, known: first.stamp, from: first.size, appendLimit: 100 });
  assert.ok(!more.unchanged && more.mode === 'from' && more.bytes.toString() === 'epoch 3\n' && more.identity === first.identity);
  const older = await backend.artifacts.readWindow(workspace, log, { limit: 4, before: 8 });
  assert.ok(!older.unchanged && older.start === 4 && older.bytes.toString() === 'h 1\n');
  // Outside the folder: read without asking, like an attachment.
  await writeFile(path.join(outside, 'out.log'), 'outside\n');
  const away = await backend.artifacts.readWindow(workspace, path.join(outside, 'out.log'), { limit: 100 });
  assert.ok(!away.unchanged && away.bytes.toString() === 'outside\n');
  // Any file reads like the others, links, dotfiles and the Claude configuration included; a folder is refused.
  await symlink(log, path.join(cwd, 'link.log'));
  await writeFile(path.join(cwd, '.env'), 'SECRET=1\n');
  await writeFile(path.join(config, 'settings.json'), '{}');
  for (const [file, text] of [[path.join(cwd, 'link.log'), 'epoch 1\nepoch 2\nepoch 3\n'], [path.join(cwd, '.env'), 'SECRET=1\n'], [path.join(config, 'settings.json'), '{}']]) {
    const window = await backend.artifacts.readWindow(workspace, file, { limit: 100 });
    assert.ok(!window.unchanged && window.bytes.toString() === text, file);
  }
  await assert.rejects(() => backend.artifacts.readWindow(workspace, path.join(cwd, 'logs'), { limit: 100 }));
});
