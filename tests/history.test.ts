import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Backend, projectSlug } from '../src/backend';
import { historyMetadata, metadataFromPrefix, missingCwdNotice, missingCwdReason, scanHistoryProjects } from '../src/backend/history';
import { Transport } from '../src/backend/transport';

test('metadata parsing keeps the original root cwd and ignores nested fields/corrupt complete lines', () => {
  const root = '/tmp/original';
  assert.equal(metadataFromPrefix(JSON.stringify({ cwd: root }) + '\n' + JSON.stringify({ cwd: '/tmp/later' }) + '\n').cwd, root);
  assert.equal(metadataFromPrefix('{"type":"user","cwd":"/tmp/partial","message":').cwd, '/tmp/partial');
  assert.equal(metadataFromPrefix('{"message":{"cwd":"/tmp/nested"},"text":"unfinished').cwd, undefined);
  assert.equal(metadataFromPrefix('{"cwd":"/tmp/corrupt"}\0\n').cwd, undefined);
  assert.equal(metadataFromPrefix('{"cwd":"relative"}\n').cwd, undefined);
});

test("a file whose head has no cwd belongs to the directory its project folder is named after, not a subdirectory it ended in", () => {
  const root = '/work/my.project', file = `/config/projects/${projectSlug(root)}/${randomUUID()}.jsonl`;
  const head = JSON.stringify({ type: 'file-history-snapshot', snapshot: {} }) + '\n';
  const tail = (cwd: string) => JSON.stringify({ type: 'assistant', cwd, timestamp: '2026-01-02T00:00:00.000Z' }) + '\n';
  assert.deepEqual(historyMetadata({ path: file, head, tail: tail(root + '/sub/deeper') }), { cwd: root, cwdSource: 'tail', latestAt: '2026-01-02T00:00:00.000Z' });
  assert.equal(historyMetadata({ path: file, head, tail: tail(root) }).cwd, root);
  // Older Claude Code named the folder with only / and . replaced.
  assert.equal(historyMetadata({ path: `/config/projects/${root.replace(/[/.]/g, '-')}/x.jsonl`, head, tail: tail(root + '/sub') }).cwd, root);
  // The head's cwd still comes first; a directory outside the project (an added one) is kept as before.
  assert.equal(historyMetadata({ path: file, head: tail(root), tail: tail('/elsewhere') }).cwd, root);
  assert.equal(historyMetadata({ path: file, head, tail: tail('/elsewhere/sub') }).cwd, '/elsewhere/sub');
});

test('缺少 cwd 的提示区分完整文件与采样窗口，输出只含文件短 ID 与原因', () => {
  const id = randomUUID();
  const classify = (text: string, size = Buffer.byteLength(text)) => missingCwdReason({ path: id, head: text, tail: text }, size);
  assert.equal(classify(''), 'empty');
  assert.equal(classify('{"type":"queue-operation","content":"私有草稿"}\n'), 'queue');
  assert.equal(classify('{"type":"file-history-snapshot"}\n'), 'snapshot');
  assert.equal(classify('{"type":"ai-title"}\n{"type":"agent-name"}\n'), 'name');
  assert.equal(classify('{"type":"cost-state","totalCostUSD":1}\n'), 'cost');
  assert.equal(classify('{"type":"summary"}\n'), 'title');
  assert.equal(classify('{"type":"last-prompt"}\n{"type":"mode"}\n'), 'metadata');
  assert.equal(classify('{"type":"assistant","message":{"cwd":"/nested"}}\n'), 'conversation');
  assert.equal(classify('{"type":"queue-operation"}\n{broken'), 'unrecognized');
  assert.equal(classify('{"type":"queue-operation"}\n', 2000000), 'partial');
  // Files with no conversation (cost records, metadata, an unused chat) need no notice.
  for (const missingCwd of ['empty', 'queue', 'snapshot', 'name', 'cost', 'title', 'metadata'] as const)
    assert.equal(missingCwdNotice([{ id, metadata: { missingCwd } }]), undefined, missingCwd);
  const note = missingCwdNotice([{ id, metadata: { missingCwd: 'conversation' } }, { id: randomUUID(), metadata: { cwd: '/project' } }]);
  assert.ok(note?.includes(`${id.slice(0, 8)}（含有对话记录，但没有有效的顶层 cwd）`));
  assert.doesNotMatch(note!, /私有草稿|\/project/);
});

test('history project discovery handles deleted cwd, aliases, large prefixes, corruption, and file boundaries', { timeout: 30_000, skip: process.platform === 'win32' ? 'POSIX fixture; Windows runs no local commands' : false }, async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lectern-history-')));
  const config = path.join(root, 'config'), cwd = path.join(root, "current directory's"), deleted = path.join(root, 'deleted'), alias = path.join(root, 'logical-alias');
  await mkdir(cwd); await symlink(cwd, alias);
  const projectDir = path.join(config, 'projects', projectSlug(cwd));
  await mkdir(projectDir, { recursive: true });
  const record = (directory: string, timestamp = '2026-01-02T00:00:00.000Z') => JSON.stringify({ type: 'user', cwd: directory, timestamp, message: { content: 'PRIVATE MESSAGE MUST NOT BE RETURNED' } }) + '\n';
  const historyFile = async (directory: string, contents: string) => {
    const parent = path.join(config, 'projects', projectSlug(directory));
    await mkdir(parent, { recursive: true });
    const filename = path.join(parent, `${randomUUID()}.jsonl`); await writeFile(filename, contents); return filename;
  };
  await historyFile(cwd, record(cwd));
  await historyFile(cwd, JSON.stringify({ type: 'file-history-snapshot', data: 'x'.repeat(20_000) }) + '\n' + record(cwd) + JSON.stringify({ type: 'queue-operation', data: 'y'.repeat(30_000) }) + '\n' + record('/tmp/later-cwd', '2026-01-03T00:00:00.000Z'));
  await historyFile(cwd, JSON.stringify({ type: 'queue-operation', data: 'x'.repeat(300_000) }) + '\n' + record(cwd));
  await historyFile(cwd, '{"type":"user","cwd":' + JSON.stringify(cwd) + ',"message":');
  await historyFile(deleted, record(deleted));
  await historyFile(alias, record(alias));
  await historyFile(cwd, '{bad\0json\n');
  await writeFile(path.join(projectDir, 'not-a-session.jsonl'), record('/tmp/never-read'));
  const outside = path.join(root, 'outside.jsonl'); await writeFile(outside, record('/tmp/never-followed'));
  await symlink(outside, path.join(projectDir, `${randomUUID()}.jsonl`));
  const linkedDirectory = path.join(root, 'outside-directory'); await mkdir(linkedDirectory); await writeFile(path.join(linkedDirectory, `${randomUUID()}.jsonl`), record('/tmp/never-followed-dir'));
  await symlink(linkedDirectory, path.join(config, 'projects', 'linked-project'));
  const subagents = path.join(projectDir, randomUUID(), 'subagents'); await mkdir(subagents, { recursive: true }); await writeFile(path.join(subagents, `${randomUUID()}.jsonl`), record('/tmp/subagent'));
  const backend = new Backend();
  const transport = new Transport();
  try {
    const scan = await backend.discoverHistoryProjects({ kind: 'local', claudeDir: config });
    assert.equal(scan.scannedFiles, 9);
    assert.equal(scan.skippedFiles, 3);
    assert.equal(scan.truncated, false);
    assert.equal(scan.projects.length, 3);
    assert.deepEqual(scan.projects.find(p => p.cwd === cwd), { cwd, sessionCount: 4, latestAt: '2026-01-03T00:00:00.000Z', exists: true });
    assert.equal(scan.projects.find(p => p.cwd === deleted)?.exists, false);
    assert.equal(scan.projects.find(p => p.cwd === alias)?.exists, true, 'original symlink cwd is retained for import');
    assert.equal(JSON.stringify(scan).includes('PRIVATE MESSAGE'), false);
    assert.equal(scan.projects.some(p => p.cwd === '/tmp/later-cwd'), false, 'expanded prefix wins over later tail cwd');
    assert.match(scan.diagnostic!, /符号链接目录/);
    const limited = await scanHistoryProjects({ kind: 'local', claudeDir: config }, transport, { maxFiles: 2 });
    assert.equal(limited.scannedFiles, 2);
    assert.equal(limited.truncated, true);
    const budgetLimited = await scanHistoryProjects({ kind: 'local', claudeDir: config }, transport, { expansionBytes: 0 });
    assert.equal(budgetLimited.truncated, true);
    // Only the tail has a cwd, a subdirectory Claude Code went to: the session is still the project's.
    await historyFile(cwd, JSON.stringify({ type: 'file-history-snapshot', data: 'x'.repeat(20_000) }) + '\n' + record(path.join(cwd, 'sub')));
    const subdirectory = await scanHistoryProjects({ kind: 'local', claudeDir: config }, transport, { expansionBytes: 0 });
    assert.equal(subdirectory.projects.some(p => p.cwd === path.join(cwd, 'sub')), false);
    assert.equal(subdirectory.projects.find(p => p.cwd === cwd)?.sessionCount, budgetLimited.projects.find(p => p.cwd === cwd)!.sessionCount + 1);
    assert.match(budgetLimited.diagnostic!, /预算/);
    const symlinkRoot = path.join(root, 'linked-config'); await mkdir(symlinkRoot); await symlink(path.join(config, 'projects'), path.join(symlinkRoot, 'projects'));
    assert.equal((await backend.discoverHistoryProjects({ kind: 'local', claudeDir: symlinkRoot })).scannedFiles, 0);
    await assert.rejects(() => backend.discoverHistoryProjects({ kind: 'ssh', host: '-oProxyCommand=bad' }), /SSH config alias/);
    await assert.rejects(() => backend.discoverHistoryProjects({ kind: 'local', claudeDir: 'relative' }), /absolute POSIX/);
  } finally { await backend.dispose(); await transport.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('history discovery honors inherited CLAUDE_CONFIG_DIR without a selected working directory', { skip: process.platform === 'win32' ? 'POSIX fixture' : false }, async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lectern-history-env-')));
  const cwd = path.join(root, 'workspace'), config = path.join(root, 'config');
  await mkdir(cwd);
  const project = path.join(config, 'projects', projectSlug(cwd)); await mkdir(project, { recursive: true });
  await writeFile(path.join(project, `${randomUUID()}.jsonl`), JSON.stringify({ type: 'user', cwd, message: { content: 'fixture' } }) + '\n');
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const backend = new Backend();
  try {
    process.env.CLAUDE_CONFIG_DIR = config;
    const result = await backend.discoverHistoryProjects({ kind: 'local' });
    assert.equal(result.claudeDir, config);
    assert.deepEqual(result.projects, [{ cwd, sessionCount: 1, exists: true }]);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    await backend.dispose(); await rm(root, { recursive: true, force: true });
  }
});
