import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitChanges, parseGitChanges, privacyGuarded } from '../src/backend/git-changes';
import { Transport } from '../src/backend/transport';
import type { Workspace } from '../src/shared/types';

test('status and numstat records merge into one list, renames and binaries included', () => {
  const out = ['LECTERN_GIT', '/work/repo', 'main', ' M src/a.ts', 'R  src/new name.ts', 'src/old.ts', '?? notes/', 'A  img.png', 'UU merge.txt',
    'LECTERN_GIT_NUMSTAT', '3\t1\tsrc/a.ts', '0\t0\t', 'src/old.ts', 'src/new name.ts', '-\t-\timg.png', '2\t2\tmerge.txt', ''].join('\0');
  const parsed = parseGitChanges(out)!;
  assert.equal(parsed.repo, 'repo'); assert.equal(parsed.branch, 'main');
  assert.deepEqual(parsed.files, [
    { path: 'img.png', status: 'added', binary: true },
    { path: 'merge.txt', status: 'conflict', added: 2, removed: 2 },
    { path: 'notes/', status: 'untracked' },
    { path: 'src/a.ts', status: 'modified', added: 3, removed: 1 },
    { path: 'src/new name.ts', status: 'renamed', from: 'src/old.ts', added: 0, removed: 0 },
  ]);
  assert.deepEqual([parsed.total, parsed.added, parsed.removed], [5, 5, 3]);
  assert.equal(parseGitChanges(''), undefined, 'outside a repository');
});

test('a local macOS folder in Desktop or Documents is only read when asked', () => {
  const folder = (cwd: string, kind: Workspace['kind'] = 'local'): Workspace => ({ id: 'w', name: 'w', kind, cwd, host: kind === 'ssh' ? 'h' : undefined });
  assert.equal(privacyGuarded(folder('/Users/me/Desktop/paper'), '/Users/me', 'darwin'), true);
  assert.equal(privacyGuarded(folder('/Users/me/Documents'), '/Users/me', 'darwin'), true);
  assert.equal(privacyGuarded(folder('/Users/me/work/app'), '/Users/me', 'darwin'), false);
  assert.equal(privacyGuarded(folder('/Users/me/Desktop/paper'), '/Users/me', 'linux'), false);
  assert.equal(privacyGuarded(folder('/Users/me/Desktop/paper', 'ssh'), '/Users/me', 'darwin'), false);
});

test('a real repository: changes against HEAD from a subfolder, nothing outside a repository', { skip: process.platform === 'win32' }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lectern-git-')));
  const transport = new Transport();
  try {
    const repo = join(root, 'my repo'), git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
    await mkdir(join(repo, 'sub'), { recursive: true }); await mkdir(join(repo, 'docs'), { recursive: true });
    git('init', '-q', '-b', 'trunk'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
    await writeFile(join(repo, 'a.txt'), 'one\ntwo\n'); await writeFile(join(repo, 'sub', 'b.txt'), 'b\n'); await writeFile(join(repo, 'docs', 'c.txt'), 'c\n');
    git('add', '.'); git('commit', '-q', '-m', 'init');
    await writeFile(join(repo, 'a.txt'), 'one\nTWO\nthree\n'); await writeFile(join(repo, '新文件.md'), 'x\n'); git('rm', '-q', 'sub/b.txt');
    const changes = await gitChanges(transport, { id: 'g', name: 'g', kind: 'local', cwd: join(repo, 'docs') });
    assert.equal(changes?.root, repo); assert.equal(changes?.repo, 'my repo'); assert.equal(changes?.branch, 'trunk');
    assert.deepEqual(changes?.files.map(f => [f.path, f.status, f.added, f.removed]), [
      ['a.txt', 'modified', 2, 1], ['sub/b.txt', 'deleted', 0, 1], ['新文件.md', 'untracked', undefined, undefined]]);
    assert.equal(await gitChanges(transport, { id: 'n', name: 'n', kind: 'local', cwd: root }), undefined);
  } finally { await transport.dispose(); await rm(root, { recursive: true, force: true }); }
});
