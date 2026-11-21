import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandInvocation, runCommand, Transport } from '../src/backend/transport';
import type { Workspace } from '../src/shared/types';

const posix = { skip: process.platform === 'win32' };
const target: Workspace = { id: 'jump', name: 'Jump', kind: 'ssh', cwd: '/tmp', host: 'jump-target' };

/** Runs `body` with a fake `ssh` first on PATH. `-O check` always succeeds. */
async function withFakeSsh(body: string, run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'lectern-fake-ssh-')), previous = process.env.PATH;
  await mkdir(join(dir, 'live'));
  await writeFile(join(dir, 'ssh'), `#!/bin/sh\ncase " $* " in *" -O "*) exit 0;; esac\ndir="$(dirname "$0")"\n${body}\n`, { mode: 0o700 });
  process.env.PATH = `${dir}:${previous}`;
  try { await run(dir); } finally {
    process.env.PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test('a one-off SSH request reports the status of its command, even one that exits', posix, () => {
  const marker = '__LECTERN_STATUS_test__:';
  const execute = (script: string, stdin?: string) => {
    const invocation = commandInvocation(target, script, undefined, undefined, true, stdin, marker);
    return execFileSync('/bin/sh', ['-c', invocation.args.at(-1)!], { input: invocation.input }).toString();
  };
  assert.equal(execute('printf ok'), `ok\n${marker}0\n`);
  assert.equal(execute('printf partial; exit 3'), `partial\n${marker}3\n`);
  assert.equal(execute('cat', 'stdin\n'), `stdin\n\n${marker}0\n`);
});

test('a session the jump host refused is an error, not an empty result', posix, async () => {
  // A jump host that cannot reach the target: the command never runs, the session still "succeeds".
  await withFakeSsh(`cat >/dev/null\necho 'jump proxy failed, 无法连接目标机器 ssh: rejected: connect failed (open failed)' >&2\nexit 0`, async () => {
    await assert.rejects(runCommand(target, 'printf listing'), /jump proxy failed/);
  });
  // A jump host that swallows the remote exit status.
  await withFakeSsh('sh -s\nexit 0', async () => {
    assert.equal((await runCommand(target, 'printf ok')).stdout.toString(), 'ok');
    assert.equal((await runCommand(target, "printf 'a\\n'")).stdout.toString(), 'a\n');
    await assert.rejects(runCommand(target, 'echo boom >&2; exit 3'), /boom/);
  });
});

test('a read sized to the exact byte fits a one-off session: its status line is not counted', posix, async () => {
  // Reply progress asks for exactly n bytes with maxBytes n + 1. Over a one-off
  // session the appended status line used to push it past the limit.
  await withFakeSsh('sh -s', async () => {
    const exact = 'x'.repeat(4096);
    assert.equal((await runCommand(target, `printf ${exact}`, { maxBytes: exact.length + 1 })).stdout.toString(), exact);
    assert.equal((await runCommand(target, `printf ${exact}`, { maxBytes: exact.length })).stdout.toString(), exact);
    await assert.rejects(runCommand(target, `printf ${exact}y`, { maxBytes: exact.length }), /safety limit/);
    await assert.rejects(runCommand(target, `printf ${exact}; printf '%0200d' 0`, { maxBytes: exact.length }), /safety limit/);
  });
});

test('one-off SSH sessions per host wait for a free slot', posix, async () => {
  await withFakeSsh(`touch "$dir/live/$$"\nls "$dir/live" | wc -l >> "$dir/counts"\nsleep 0.3\nsh -s\ncode=$?\nrm -f "$dir/live/$$"\nexit $code`, async dir => {
    const transport = new Transport(undefined, { channelKinds: [] });
    try {
      const runs = Array.from({ length: 8 }, (_, i) => transport.run(target, `printf ${i}`));
      const abort = new AbortController(), waiting = transport.run(target, 'printf never', { signal: abort.signal });
      abort.abort();
      await assert.rejects(waiting);
      assert.deepEqual((await Promise.all(runs)).map(r => r.stdout.toString()), ['0', '1', '2', '3', '4', '5', '6', '7']);
      const counts = (await readFile(join(dir, 'counts'), 'utf8')).trim().split('\n').map(Number);
      assert.equal(counts.length, 9, 'the host is asked for its system once, then eight commands');
      assert.ok(Math.max(...counts) <= 5, `at most five at once: ${counts}`);
    } finally { await transport.dispose(); }
  });
});

test('an SSH machine running Windows is refused once with a clear message; macOS and Linux pass', posix, async () => {
  const run = async (fakeSsh: string, body: (transport: Transport, dir: string) => Promise<void>) =>
    withFakeSsh(fakeSsh, async dir => {
      const transport = new Transport(undefined, { channelKinds: [] });
      try { await body(transport, dir); } finally { await transport.dispose(); }
    });
  // Git Bash as the server's shell: POSIX enough to run, but uname names Windows.
  await run(`echo x >> "$dir/calls"\nPATH="$dir/bin:$PATH" sh -s`, async (transport, dir) => {
    await mkdir(join(dir, 'bin'));
    await writeFile(join(dir, 'bin', 'uname'), '#!/bin/sh\necho MINGW64_NT-10.0-19045\n', { mode: 0o700 });
    for (let i = 0; i < 2; i++) await assert.rejects(transport.run(target, 'printf never'), /jump-target 运行的是 Windows。Lectern 只能连接 macOS 或 Linux 的 SSH 机器/);
    await assert.rejects(transport.stream(target, 'cat'), /Windows/);
    assert.equal((await readFile(join(dir, 'calls'), 'utf8')).trim().split('\n').length, 1, 'asked once, then refused without connecting');
  });
  // cmd.exe as the server's shell cannot start sh at all.
  await run(`cat >/dev/null\necho "'exec' is not recognized as an internal or external command," >&2\necho 'operable program or batch file.' >&2\nexit 1`, async transport => {
    await assert.rejects(transport.run(target, 'printf never'), /运行的是 Windows/);
  });
  // A connection failure is not an answer: the next command asks again.
  await run(`if [ ! -e "$dir/up" ]; then touch "$dir/up"; cat >/dev/null; echo 'ssh: connect to host jump-target port 22: Connection refused' >&2; exit 255; fi\nsh -s`, async transport => {
    await assert.rejects(transport.run(target, 'printf ok'), /Connection refused/);
    assert.equal((await transport.run(target, 'printf ok')).stdout.toString(), 'ok');
  });
});

test('Windows runs no local commands: SSH machines only', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    assert.throws(() => commandInvocation({ ...target, kind: 'local', host: undefined }, 'true'), /Windows 版 Lectern 只能通过 SSH 连接 macOS 或 Linux 机器/);
    assert.equal(commandInvocation(target, 'true').file, 'ssh');
  } finally { Object.defineProperty(process, 'platform', platform); }
});
