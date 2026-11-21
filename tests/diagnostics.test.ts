import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configureDiagnostics, diagnostic, closeDiagnostics, flushDiagnostics, getDiagnosticsInfo, setDiagnosticContent, summarize } from '../src/diagnostics';
import { runCommand } from '../src/backend';

async function records(directory: string): Promise<any[]> {
  const files = (await readdir(directory)).filter(name => /^events\.\d+\.jsonl$/.test(name)).sort().reverse();
  const result: any[] = [];
  for (const name of files) result.push(...(await readFile(path.join(directory, name), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  return result;
}
async function fixture(run: (directory: string) => Promise<void>) {
  await closeDiagnostics();
  const directory = await mkdtemp(path.join(tmpdir(), 'lectern-logs-'));
  try { await run(directory); } finally { await closeDiagnostics(); configureDiagnostics(); await rm(directory, { recursive: true, force: true }); }
}

test('diagnostics are opt-in, content can be disabled, and byte captures replay split UTF-8 exactly', async () => fixture(async directory => {
  configureDiagnostics();
  assert.equal(diagnostic.capture('jsonl', Buffer.from('not logged')), undefined);
  configureDiagnostics({ directory, captureContent: false });
  assert.equal(diagnostic.capture('screen', 'hidden transcript'), undefined);
  setDiagnosticContent(true);
  const content = Buffer.from('你好🙂 second chunk\n');
  const first = diagnostic.capture('jsonl', content.subarray(0, 5), { sessionId: 'fixture' });
  const second = diagnostic.capture('jsonl', content.subarray(5), { sessionId: 'fixture' });
  assert.ok(first && second && first !== second);
  await flushDiagnostics();
  const lines = await records(directory), captures = lines.filter(r => r.event === 'capture.jsonl');
  assert.equal(captures.length, 2);
  assert.deepEqual(Buffer.concat(captures.map(r => Buffer.from(r.data.content, r.data.encoding))), content);
  assert.ok(captures.every(r => !r.data.redacted && !r.data.truncated));
  assert.equal(captures[0].data.sha256, summarize(content.subarray(0, 5)).sha256);
  assert.equal(JSON.stringify(lines).includes('hidden transcript'), false);
  if (process.platform !== 'win32') {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(directory, 'events.000.jsonl'))).mode & 0o777, 0o600);
  }
}));

test('redaction covers structured secrets, common token strings and private keys in text and byte captures', async () => fixture(async directory => {
  configureDiagnostics({ directory, captureContent: true });
  diagnostic.event('credentials.example', { password: 'supersecret', nested: { apiKey: 'structured-secret' }, message: 'Authorization: Bearer abc.secret.123' });
  diagnostic.capture('jsonl', Buffer.from('{"api_key":"key-to-redact","text":"sk-ant-api03-exampletoken-123456"}\n')); // private-info: allow (fake secrets that redaction must remove)
  diagnostic.capture('screen', '-----BEGIN OPENSSH PRIVATE KEY-----\nkey-data-secret\n-----END OPENSSH PRIVATE KEY-----'); // private-info: allow (fake secrets that redaction must remove)
  await flushDiagnostics();
  const lines = await records(directory);
  const decoded = lines.map(r => r.event.startsWith('capture.') ? Buffer.from(r.data.content, r.data.encoding).toString('utf8') : JSON.stringify(r)).join('\n');
  for (const secret of ['supersecret', 'structured-secret', 'abc.secret.123', 'key-to-redact', 'sk-ant-api03-exampletoken-123456', 'key-data-secret']) assert.equal(decoded.includes(secret), false, secret); // private-info: allow (fake secrets that redaction must remove)
  assert.ok(lines.filter(r => r.event.startsWith('capture.')).every(r => r.data.redacted));
}));

test('async operation correlation follows nested work and preserves the original thrown error', async () => fixture(async directory => {
  configureDiagnostics({ directory });
  const failure = new Error('sample failure');
  await assert.rejects(diagnostic.scope({ workspaceId: 'workspace', watchId: 'watch' }, () => diagnostic.operation('read', { sessionId: 'session' }, async () => {
    await new Promise(resolve => setTimeout(resolve, 1));
    await diagnostic.operation('nested.op', {}, async () => { diagnostic.event('nested', { bytes: 3 }); });
    throw failure;
  })), error => error === failure);
  await flushDiagnostics();
  const lines = (await records(directory)).filter(r => r.event.startsWith('read.') || r.event === 'nested');
  assert.deepEqual(lines.map(r => r.event), ['read.start', 'nested', 'read.error']);
  assert.ok(lines.every(r => r.context.workspaceId === 'workspace' && r.context.watchId === 'watch' && r.context.sessionId === 'session'));
  assert.equal(new Set(lines.map(r => r.context.traceId)).size, 1);
  assert.equal(new Set(lines.map(r => r.context.rootOperationId)).size, 1);
  assert.equal(lines[1].context.parentOperationId, lines[0].context.operationId);
  assert.notEqual(lines[1].context.operationId, lines[0].context.operationId);
  assert.equal(lines.at(-1).data.error.message, 'sample failure');
}));

test('transport diagnostics record lifecycle and hashes without raw command, input or stdout', { skip: process.platform === 'win32' ? 'POSIX shell fixture' : false }, async () => fixture(async directory => {
  configureDiagnostics({ directory, captureContent: true });
  const target = { id: 'transport-log', name: 'Transport log', kind: 'local' as const, cwd: directory };
  const stdoutSecret = 'unique-unlogged-stdout-97131', stdinSecret = 'unique-unlogged-stdin-38713';
  await runCommand(target, `printf '%s' '${stdoutSecret}'; printf '%s' 'Bearer abc-secret-123' >&2`, { input: stdinSecret, tag: 'fixture.command' });
  await flushDiagnostics();
  const lines = await records(directory), serialized = JSON.stringify(lines);
  for (const value of [stdoutSecret, stdinSecret, 'abc-secret-123', "printf '%s'"]) assert.equal(serialized.includes(value), false);
  assert.ok(lines.some(r => r.event === 'transport.command.request' && r.data.script.sha256));
  assert.ok(lines.some(r => r.event === 'transport.command.exited' && r.data.code === 0 && r.data.stdoutBytes > 0));
  assert.ok(lines.filter(r => r.event.startsWith('transport.')).every(r => r.context.commandTag === 'fixture.command'));
}));

test('rotation is bounded across runs and retained records stay in sequence', async () => fixture(async directory => {
  const options = { directory, maxFileBytes: 1024, maxFiles: 3 };
  configureDiagnostics(options);
  for (let i = 0; i < 40; i++) diagnostic.event('first', { i, text: 'x'.repeat(100) });
  await closeDiagnostics();
  configureDiagnostics(options);
  const runId = getDiagnosticsInfo().runId;
  for (let i = 0; i < 40; i++) diagnostic.event('second', { i, text: 'y'.repeat(100) });
  await flushDiagnostics();
  const files = await readdir(directory);
  assert.ok(files.length <= 3);
  for (const name of files) assert.ok((await stat(path.join(directory, name))).size <= 1024);
  const lines = (await records(directory)).filter(r => r.runId === runId);
  for (let i = 1; i < lines.length; i++) assert.ok(lines[i].seq > lines[i - 1].seq);
  assert.equal(lines.at(-1).data.i, 39);
}));

test('queue pressure and oversized captures are visible without unbounded memory or files', async () => fixture(async directory => {
  configureDiagnostics({ directory, captureContent: true, maxFileBytes: 1024 * 1024, maxFiles: 2 });
  const payload = Buffer.alloc(900_000, 65);
  for (let i = 0; i < 35; i++) diagnostic.capture('jsonl', payload, { i });
  await flushDiagnostics();
  assert.ok(getDiagnosticsInfo().droppedEvents > 0);
  const lines = await records(directory);
  assert.ok(lines.some(r => r.event === 'diagnostics.queue_dropped'));
  assert.ok(lines.some(r => r.event === 'capture.jsonl' && r.data.truncated));
  const files = await readdir(directory);
  assert.ok(files.length <= 2);
  for (const name of files) assert.ok((await stat(path.join(directory, name))).size <= 1024 * 1024);
}));

test('logging I/O failure is reported in info and never throws into the application', async () => fixture(async directory => {
  const blocked = path.join(directory, 'regular-file');
  await writeFile(blocked, 'not a directory');
  configureDiagnostics({ directory: blocked, captureContent: true });
  assert.doesNotThrow(() => diagnostic.event('still-working', { value: 1 }));
  await assert.doesNotReject(flushDiagnostics());
  assert.ok(getDiagnosticsInfo().lastError);
  assert.ok(getDiagnosticsInfo().droppedEvents > 0);
  assert.doesNotThrow(() => diagnostic.capture('jsonl', Buffer.from('ignored after failure')));
  await assert.doesNotReject(closeDiagnostics());
}));
