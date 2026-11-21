import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChannelUnavailable, CommandChannel, channelScript } from '../src/backend/command-channel';
import { Transport } from '../src/backend/transport';
import type { Workspace } from '../src/shared/types';

// The SSH channel protocol, exercised with the local /bin/sh: a channel request
// must behave exactly like the one-off command it replaces.
const workspace: Workspace = { id: 'channel', name: 'channel', kind: 'local', cwd: '/tmp' };
const viaChannel = () => new Transport(undefined, { channelKinds: ['local'] });
const oneOff = () => new Transport(undefined, { channelKinds: [] });
const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Wait until commands run on a warm channel: the request shell's parent is the loop, not this process. */
async function warm(transport: Transport) {
  for (let i = 0; i < 100; i++) {
    transport.warmChannels(workspace);
    const { stdout } = await transport.run(workspace, 'printf %s "$PPID"');
    if (stdout.toString() !== String(process.pid)) return stdout.toString();
    await settle(30);
  }
  throw new Error('channel never became ready');
}
const outcome = (transport: Transport, script: string, input?: string | Buffer, maxBytes?: number) =>
  transport.run(workspace, script, { input, maxBytes }).then(
    ({ stdout, stderr }) => ({ ok: true, stdout: stdout.toString('base64'), stderr }),
    (error: Error) => ({ ok: false, error: error.message }));

test('channel results are byte-identical to one-off commands', async () => {
  const channel = viaChannel(), plain = oneOff();
  try {
    await warm(channel);
    const binary = Buffer.from([0, 1, 2, 10, 13, 255, 0, 39, 34, 36]);
    const cases: [string, (string | Buffer)?][] = [
      ['printf "no trailing newline"'],
      ["printf '\\000\\001\\377end\\000'"],
      ['echo out; echo err >&2'],
      ['echo partial; echo "failure detail" >&2; exit 3'],
      ['exit 7'],
      ['echo "$(printf %s "$0" | wc -c)" >/dev/null; printf "%s|" "$1" "${HOME:+home}"'],
      ['cat', 'plain input'],
      ['cat', binary],
      ['wc -c', "'$(rm -rf /)' `id` \"quoted\" \\ back\nslash\n"],
      ['cat', Buffer.alloc(1024 * 1024, 'x')],
      ['head -c 3000000 /dev/zero | tr "\\000" a'],
      ['read line; printf "[%s]" "$line"'],
      ['printf "%s" "$(cat)"', 'ä 中文 🙂\n'],
      // Above the compression threshold: incompressible and compressible bytes.
      ['cat', randomBytes(300_000)],
      ['cat; echo tail >&2; exit 2', Buffer.alloc(100_000, 'y')],
    ];
    for (const [script, input] of cases) assert.deepEqual(await outcome(channel, script, input), await outcome(plain, script, input), script);
    // The same channel answered every request; nothing leaked between them.
    assert.notEqual((await channel.run(workspace, 'printf %s "$PPID"')).stdout.toString(), String(process.pid));
  } finally { await channel.dispose(); await plain.dispose(); }
});

test('an over-limit output is refused without breaking the channel', async () => {
  const transport = viaChannel();
  try {
    const loop = await warm(transport);
    await assert.rejects(transport.run(workspace, 'head -c 5000 /dev/zero', { maxBytes: 4096 }), /safety limit/);
    assert.equal((await transport.run(workspace, 'printf %s "$PPID"')).stdout.toString(), loop, 'the frame was consumed; the channel stays usable');
  } finally { await transport.dispose(); }
});

test('a timed-out command closes its channel and is never replayed', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lectern-channel-timeout-'));
  const transport = viaChannel();
  try {
    const loop = await warm(transport);
    const log = path.join(directory, 'ran');
    await assert.rejects(transport.run(workspace, `echo once >> '${log}'; sleep 5`, { timeoutMs: 300 }), /timed out; no input is retried/);
    assert.equal((await readFile(log, 'utf8')), 'once\n');
    // The next command still runs (one-off while a new channel warms up).
    assert.equal((await transport.run(workspace, 'echo next')).stdout.toString(), 'next\n');
    const replacement = await warm(transport);
    assert.notEqual(replacement, loop, 'the timed-out channel was replaced');
    await settle(100);
    assert.equal((await readFile(log, 'utf8')), 'once\n');
  } finally { await transport.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('parallel commands use separate channels and never mix their output', async () => {
  const transport = viaChannel();
  try {
    await warm(transport);
    // Let the pool reach its limit.
    for (let i = 0; i < 3; i++) await Promise.all([0, 1, 2].map(() => transport.run(workspace, 'sleep 0.05')));
    const started = Date.now();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      transport.run(workspace, `sleep 0.3; printf 'job-${i}-'; head -c 20000 /dev/zero | tr '\\000' ${i}`)));
    results.forEach(({ stdout }, i) => assert.equal(stdout.toString(), `job-${i}-` + String(i).repeat(20000)));
    assert.ok(Date.now() - started < 6 * 300, 'requests ran concurrently');
  } finally { await transport.dispose(); }
});

test('a background process outliving its command cannot corrupt the next frame', async () => {
  const transport = viaChannel();
  try {
    await warm(transport);
    assert.equal((await transport.run(workspace, '( sleep 0.2; echo late; echo late >&2 ) & echo now')).stdout.toString(), 'now\n');
    await settle(300);
    assert.equal((await transport.run(workspace, 'echo clean')).stdout.toString(), 'clean\n');
  } finally { await transport.dispose(); }
});

test('a channel lost mid-command rejects that command and later commands still run', async () => {
  const transport = viaChannel();
  try {
    await warm(transport);
    // The request shell kills the channel loop that is waiting for it.
    await assert.rejects(transport.run(workspace, 'kill -9 $PPID; sleep 0.2'));
    assert.equal((await transport.run(workspace, 'echo after')).stdout.toString(), 'after\n');
  } finally { await transport.dispose(); }
});

test('the ready line is found after login-script output, and only our nonce counts', async () => {
  const nonce = randomBytes(16).toString('hex');
  const child = spawn('/bin/sh', ['-c', `echo "Welcome to the target"; printf 'LECTERN_CHANNEL_READY 0000000000000000\\nno newline'\n${channelScript(nonce)}`], { stdio: ['pipe', 'pipe', 'pipe'] });
  const channel = await CommandChannel.open(child, nonce, 5000);
  try {
    const result = await channel.run("printf '%s' ok </dev/null\n", { timeoutMs: 5000, maxBytes: 1024, timeoutMessage: 'timeout' });
    assert.deepEqual({ ...result, stdout: result.stdout.toString() }, { code: 0, stdout: 'ok', stderr: '' });
    await assert.rejects(Promise.all([
      channel.run('sleep 0.1\n', { timeoutMs: 5000, maxBytes: 1024, timeoutMessage: 'timeout' }),
      channel.run('true\n', { timeoutMs: 5000, maxBytes: 1024, timeoutMessage: 'timeout' }),
    ]), ChannelUnavailable, 'a busy channel refuses a second request before sending anything');
  } finally { channel.close(); }
});

test('a target that cannot start the loop falls back to one-off commands and backs off', async () => {
  const transport = viaChannel();
  let attempts = 0;
  (transport as any).stream = async () => { attempts++; return spawn('/bin/sh', ['-c', 'echo "sh: base64: not found" >&2; exit 1'], { stdio: ['pipe', 'pipe', 'pipe'] }); };
  try {
    for (let i = 0; i < 5; i++) {
      assert.equal((await transport.run(workspace, 'printf %s "$PPID"')).stdout.toString(), String(process.pid));
      await settle(50);
    }
    assert.equal(attempts, 1, 'a failed start is retried only after a back-off');
  } finally { await transport.dispose(); }
});

test('disposing closes channels and removes their files on the target', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lectern-channel-files-'));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = directory;
  const transport = viaChannel();
  try {
    await warm(transport);
    assert.equal((await readdir(directory)).filter(name => name.startsWith('lectern-channel.')).length, 1);
    await transport.dispose();
    for (let i = 0; i < 50 && (await readdir(directory)).length; i++) await settle(20);
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(transport.run(workspace, 'true'), /disposed/);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    await transport.dispose(); await rm(directory, { recursive: true, force: true });
  }
});

test('idle channels are closed after the idle limit', async () => {
  const transport = new Transport(undefined, { channelKinds: ['local'], channelIdleMs: 200 });
  try {
    const loop = await warm(transport);
    await settle(500);
    (transport as any).closeIdleChannels();
    const pools = [...(transport as any).pools.values()];
    assert.equal(pools.reduce((n: number, pool: any) => n + pool.channels.size, 0), 0);
    assert.notEqual(await warm(transport), loop);
  } finally { await transport.dispose(); }
});

test('large outputs travel compressed and are limited by their decompressed size', async () => {
  const nonce = randomBytes(16).toString('hex');
  const child = spawn('/bin/sh', ['-c', channelScript(nonce)], { stdio: ['pipe', 'pipe', 'pipe'] });
  let wire = 0;
  child.stdout.on('data', (chunk: Buffer) => { wire += chunk.length; });
  const channel = await CommandChannel.open(child, nonce, 5000);
  const options = { timeoutMs: 5000, maxBytes: 8 * 1024 * 1024, timeoutMessage: 'timeout' };
  try {
    const before = wire;
    // The request shell's own stdin is already /dev/null.
    const big = await channel.run('head -c 4000000 /dev/zero | tr "\\000" "{"\n', options);
    assert.equal(big.stdout.length, 4_000_000);
    assert.ok(big.stdout.every(byte => byte === 123));
    assert.ok(wire - before < 100_000, `4 MB of text crossed as ${wire - before} bytes`);
    await assert.rejects(channel.run('head -c 300000 /dev/zero\n', { ...options, maxBytes: 200_000 }), /safety limit/);
    const small = await channel.run('printf small\n', options);
    assert.equal(small.stdout.toString(), 'small', 'the channel stays usable after a refused output');
  } finally { channel.close(); }
});
