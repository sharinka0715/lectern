import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HistoryIndex } from '../src/backend/history-index';
import { Transport, type CommandOptions } from '../src/backend/transport';
import type { Workspace } from '../src/shared/types';

test('workspace refresh transfers only changed metadata, including same-size rewrites and deleted histories', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'metadata-test-'));
  const transport = new Transport();
  const run = transport.run.bind(transport);
  let transfers = 0;
  transport.run = (ws: Workspace, script: string, options?: CommandOptions) => {
    if (options?.tag === 'history.changed_metadata') transfers++;
    return run(ws, script, options);
  };
  const ws: Workspace = { id: 'index', name: 'index', kind: 'local', cwd: dir };
  const path = join(dir, randomUUID() + '.jsonl');
  const records = (title: string) => [ { type:'user', cwd:dir, isMeta:true, message:{content:'Context Usage'} },
    {type:'user', cwd:dir, message:{content:title}} ].map(row=>JSON.stringify(row)).join('\n')+'\n';
  const index = new HistoryIndex();
  try {
    await writeFile(path, records('Real prompt A'));
    assert.equal((await index.scan(transport, ws, [dir])).files[0].metadata.title, 'Real prompt A');
    await index.scan(transport, ws, [dir]);
    assert.equal(transfers, 1);
    await writeFile(path, records('Real prompt B'));
    assert.equal((await index.scan(transport, ws, [dir])).files[0].metadata.title, 'Real prompt B');
    assert.equal(transfers, 2);
    await rm(path);
    assert.equal((await index.scan(transport, ws, [dir])).files.length, 0);
  } finally { await transport.dispose(); await rm(dir, {recursive:true,force:true}); }
});

test('native picker titles survive middle-of-file renames and update incrementally', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'native-title-'));
  const transport = new Transport();
  const run = transport.run.bind(transport);
  const reports: { bytes: number; offset: number }[] = [];
  transport.run = async (ws, script, options) => {
    const result = await run(ws, script, options);
    if (options?.tag === 'history.title_records') {
      const fields = result.stdout.toString().split('\0');
      reports.push({ bytes: result.stdout.length, offset: Number(fields[1]) });
      assert.doesNotMatch(fields[2], /unrelated tool body/);
    }
    return result;
  };
  const ws: Workspace = { id: 'index', name: 'index', kind: 'local', cwd: dir };
  const id = randomUUID(), path = join(dir, id + '.jsonl');
  const line = (value: unknown) => JSON.stringify(value) + '\n';
  const prompt = line({ type: 'user', cwd: dir, message: { content: '真实的第一问' } });
  const padding = line({ type: 'assistant', message: { content: 'unrelated tool body'.repeat(6000) } });
  const ai = line({ type: 'ai-title', sessionId: id, aiTitle: '自动标题' });
  const summary = line({ summary: '原生摘要', type: 'summary', leafUuid: randomUUID() });
  const named = (title: string) => line({ sessionId: id, customTitle: title, type: 'custom-title' });
  const name = '原生「标题」/ "B" \\C';
  const index = new HistoryIndex();
  const verify = async (title: string, source: string) => {
    const metadata = (await index.scan(transport, ws, [dir])).files[0].metadata;
    assert.deepEqual([metadata.title, metadata.titleSource], [title, source]);
  };
  try {
    await writeFile(path, prompt + padding + ai + summary + named('A') + named(name) +
      line({ type: 'custom-title', sessionId: randomUUID(), customTitle: '另一会话' }) +
      line({ type: 'assistant', message: { type: 'custom-title', customTitle: '工具内嵌数据' } }) + padding);
    await verify(name, 'custom');
    assert.equal(reports[0].offset, 0);
    assert.ok(reports[0].bytes < 512);
    await verify(name, 'custom');
    assert.equal(reports.length, 1);
    await appendFile(path, ai + padding);
    await verify(name, 'custom');
    assert.ok(reports.at(-1)!.offset > 0);
    const partial = named('追加的改名');
    await appendFile(path, partial.slice(0, -4));
    await verify(name, 'custom');
    await appendFile(path, partial.slice(-4) + padding);
    await verify('追加的改名', 'custom');
    assert.ok(reports.at(-1)!.offset > 0);
    await appendFile(path, named('') + padding);
    await verify('自动标题', 'ai');
    await writeFile(path, prompt + padding + summary + padding);
    await verify('原生摘要', 'summary');
    assert.equal(reports.at(-1)?.offset, 0);
    await writeFile(path, prompt + padding.split('unrelated tool body').join('other content'));
    await verify('真实的第一问', 'prompt');
  } finally { await transport.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('continued-in survives trailing bookkeeping and expires if the source resumes or a copy only quotes a marker', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lectern-continued-in-'));
  const index = new HistoryIndex(), transport = new Transport();
  const ws: Workspace = { id: 'continued', name: 'continued', kind: 'local', cwd: dir };
  const id = randomUUID(), next = randomUUID(), file = join(dir, `${id}.jsonl`);
  const line = (row: object) => JSON.stringify(row) + '\n';
  const first = line({ type: 'user', sessionId: id, cwd: dir, message: { content: 'first' } });
  const marker = { type: 'continued-in', continuedInSessionId: next, sessionId: id, timestamp: new Date().toISOString() };
  const bookkeeping = line({ type: 'cost-state', padding: 'x'.repeat(18000) });
  const target = async () => (await index.scan(transport, ws, [dir])).files[0].metadata.continuedInSessionId;
  try {
    await writeFile(file, first + line(marker) + bookkeeping);
    assert.equal(await target(), next);
    await appendFile(file, line({ type: 'assistant', sessionId: id, message: { content: 'new reply' } }) + bookkeeping);
    assert.equal(await target(), undefined);
    await writeFile(file, first + line({ type: 'attachment', attachment: marker }) + bookkeeping);
    assert.equal(await target(), undefined);
    for (const invalid of [{ ...marker, sessionId: next }, { ...marker, continuedInSessionId: id }, { ...marker, continuedInSessionId: '../file' }]) {
      await writeFile(file, first + line(invalid));
      assert.equal(await target(), undefined);
    }
  } finally { await transport.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('native custom-title sidecar changes are discovered independently of transcript appends', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'title-sidecar-'));
  const transport = new Transport(), index = new HistoryIndex();
  const run = transport.run.bind(transport);
  let titlePasses = 0;
  transport.run = (ws, script, options) => {
    if (options?.tag === 'history.title_records') titlePasses++;
    return run(ws, script, options);
  };
  const ws: Workspace = { id: 'sidecar', name: 'sidecar', kind: 'local', cwd: dir };
  const id = randomUUID(), path = join(dir, id + '.jsonl'), subdir = join(dir, id), side = join(subdir, 'custom-title.json');
  const row = (value: unknown) => JSON.stringify(value) + '\n';
  const prompt = row({ type: 'user', cwd: dir, message: { content: 'opening text' } });
  const padding = row({ type: 'assistant', message: { content: 'x'.repeat(20000) } });
  const named = (customTitle: string) => row({ type: 'custom-title', sessionId: id, customTitle });
  const verify = async (title: string, source: string) => {
    const metadata = (await index.scan(transport, ws, [dir])).files[0].metadata;
    assert.deepEqual([metadata.title, metadata.titleSource], [title, source]);
  };
  try {
    await mkdir(subdir);
    await writeFile(path, prompt + named('early') + padding);
    await verify('early', 'custom');
    await writeFile(side, row({ customTitle: 'sideA' }));
    await verify('sideA', 'custom');
    assert.equal(titlePasses, 1, 'a valid sidecar avoids any transcript middle read');
    const cold = await new HistoryIndex().scan(transport, ws, [dir]);
    assert.equal(cold.files[0].metadata.title, 'sideA');
    assert.equal(titlePasses, 1, 'a fresh application can use the native sidecar immediately');
    await writeFile(side, row({ customTitle: 'sideB' }));
    await verify('sideB', 'custom');
    await writeFile(side, '{broken');
    await verify('early', 'custom');
    await rm(side);
    const external = join(dir, 'outside');
    await writeFile(external, row({ customTitle: 'linked file' }));
    await symlink(external, side);
    await verify('early', 'custom');
    await rm(side);
    await writeFile(side, row({ customTitle: 'sideC' }));
    await appendFile(path, named('latest in transcript'));
    await verify('latest in transcript', 'custom');
    const priorPasses = titlePasses;
    await rm(side);
    assert.equal((await new HistoryIndex().scan(transport, ws, [dir])).files[0].metadata.title, 'latest in transcript');
    assert.equal(titlePasses, priorPasses, 'a custom title in the tail avoids a cold full-file read');
    await appendFile(path, named(''));
    await verify('opening text', 'prompt');
  } finally { await transport.dispose(); await rm(dir, { recursive: true, force: true }); }
});
