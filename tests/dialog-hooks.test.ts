import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, constants, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { DialogHookStore, decodeDialogHookFile, decodeDialogHookFrame, dialogHookCommand, dialogHookDir, dialogHookPrefix,
  dialogHookSettings, readDialogHooks, removeDialogHookDir, HOOK_READ_FILES } from '../src/backend/dialog-hooks';
import { launchSettings } from '../src/backend/launch-settings';

const posix = { skip: process.platform === 'win32' ? 'POSIX shells; Windows runs no local commands' : false };
const NONCE = '0123456789abcdef0123456789abcdef';
const SESSION = '8b4adc37-7d87-4da7-906b-6f4914519dbb';
// Linux CI has dash as sh; bash in POSIX mode stands in for macOS's /bin/sh (bash 3.2), whose
// `case` inside $( ) tests/shell-case-parens.test.ts checks statically.
const SHELLS = [['sh', ['-c']], ['bash', ['--posix', '-c']]] as const;
function run(shell: readonly [string, readonly string[]], script: string, home: string, env: Record<string, string> = {}, input = '') {
  // Shell launchers can need HOME at startup. Give them a private one.
  const result = spawnSync(shell[0], [...shell[1], script], { env: { PATH: process.env.PATH!, ...env, HOME: home }, input, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
async function findBashOnPath() {
  for (const dir of (process.env.PATH ?? '/usr/bin:/bin').split(delimiter)) {
    const file = resolve(dir, 'bash');
    try {
      await access(file, constants.X_OK);
      if ((await stat(file)).isFile()) return file;
    } catch { /* Try the next PATH entry. */ }
  }
}
const payload = (event: string, extra: object = {}) => JSON.stringify({ session_id: SESSION, hook_event_name: event, ...extra });

test('the hooks: PreToolUse for AskUserQuestion only, PermissionRequest and SessionStart for all, synchronous, 5 s', () => {
  const hooks = dialogHookSettings(NONCE);
  assert.deepEqual(Object.keys(hooks), ['PreToolUse', 'PermissionRequest', 'SessionStart']);
  assert.equal(hooks.PreToolUse[0].matcher, 'AskUserQuestion');
  assert.equal('matcher' in hooks.PermissionRequest[0], false);
  for (const [event, [group]] of Object.entries(hooks)) {
    assert.deepEqual(group.hooks, [{ type: 'command', command: dialogHookCommand(NONCE, event as never), timeout: 5 }]);
    assert.ok(group.hooks[0].command.includes(NONCE) && group.hooks[0].command.endsWith('exit 0'), event);
  }
  for (const nonce of ['', 'ABCDEF0123456789abcdef0123456789', NONCE + '0', NONCE.slice(1) + ';', '../' + NONCE.slice(3)]) {
    assert.throws(() => dialogHookCommand(nonce, 'PreToolUse'), /Invalid/, nonce);
    assert.throws(() => dialogHookPrefix(nonce), /Invalid/, nonce);
  }
  assert.throws(() => dialogHookCommand(NONCE, 'Stop' as never), /Invalid/);
});

test('with the setting off the launch settings are byte for byte as before; on, only `hooks` is added', () => {
  const statusLine = { statusLine: { type: 'command', command: 'true' } };
  const before = '{"statusLine":{"type":"command","command":"true"},"promptSuggestionEnabled":false,"enableWorkflows":true,"permissions":{"defaultMode":"auto"}}';
  assert.equal(JSON.stringify(launchSettings({ statusLine, enableWorkflows: true })), before);
  assert.equal(JSON.stringify(launchSettings({ statusLine, enableWorkflows: true, hooks: undefined })), before);
  const on = launchSettings({ statusLine, enableWorkflows: true, hooks: dialogHookSettings(NONCE) });
  assert.equal(JSON.stringify({ ...on, hooks: undefined }), before);
  assert.deepEqual(on.hooks, dialogHookSettings(NONCE));
});

test('in dash and POSIX bash: the prefix makes the private folder, a hook leaves one silent file, the poll reads it back', posix, async () => {
  for (const shell of SHELLS) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lectern-hooks-')));
    try {
      const shellLabel = shell[0] === 'bash' ? `bash (${await findBashOnPath() ?? 'not found on PATH'})` : shell[0];
      // Outside tmux (no TMUX): the prefix names no pane option on any server.
      const env = { TMPDIR: root + '/', TMUX_TMPDIR: root };
      const base = join(root, `lectern-hooks-${process.getuid!()}`), dir = join(base, NONCE);
      // A folder from more than a week ago is swept by the next launch.
      await mkdir(join(base, 'old'), { recursive: true });
      const week = Date.now() / 1000 - 9 * 86400;
      await utimes(join(base, 'old'), week, week);
      // The prefix runs before `exec claude`: whatever happens, the launch goes on (tmux is out of reach here).
      const prefix = run(shell, dialogHookPrefix(NONCE) + 'echo launched "$lectern_hooks"', root, env);
      assert.equal(prefix.status, 0, shellLabel);
      assert.equal(prefix.stdout, `launched ${dir}\n`, shellLabel);
      assert.equal((await stat(base)).mode & 0o777, 0o700);
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
      assert.deepEqual(await readdir(base), [NONCE]);
      // Each hook: no output at all, exit 0, one private file named by time, pid and event.
      const pre = payload('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'toolu_1', tool_input: { questions: [] } });
      for (const [event, input] of [['PreToolUse', pre], ['PermissionRequest', payload('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } })],
        ['SessionStart', payload('SessionStart', { source: 'startup' })]] as const) {
        const hook = run(shell, dialogHookCommand(NONCE, event), root, env, input);
        assert.deepEqual(hook, { status: 0, stdout: '', stderr: '' }, `${shellLabel} ${event}`);
      }
      const files = (await readdir(dir)).sort();
      assert.equal(files.length, 3);
      for (const file of files) {
        assert.match(file, /^\d+-\d+-(PreToolUse|PermissionRequest|SessionStart)\.json$/);
        assert.equal((await stat(join(dir, file))).mode & 0o777, 0o600);
      }
      assert.equal(await readFile(join(dir, files.find(file => file.endsWith('-PreToolUse.json'))!), 'utf8'), pre);
      // The poll: oldest first, deleted once read; SessionStart kept as .started.
      const read = run(shell, readDialogHooks(dir, false), root);
      assert.equal(read.status, 0, read.stderr);
      const frame = decodeDialogHookFrame(read.stdout);
      assert.equal(frame.folder, true);
      assert.deepEqual(frame.files.map(file => file.name).sort(), files);
      assert.equal(frame.files.find(file => file.name.endsWith('-PreToolUse.json'))!.data.toString(), pre);
      assert.deepEqual(await readdir(dir), ['.started']);
      // After a restart Lectern asks for the kept SessionStart again.
      const again = decodeDialogHookFrame(run(shell, readDialogHooks(dir, true), root).stdout);
      assert.deepEqual(again.files.map(file => file.name), ['.started']);
      assert.deepEqual(decodeDialogHookFrame(run(shell, readDialogHooks(dir, false), root).stdout).files, []);
      // Removed once its process is gone; a missing folder reads as such.
      assert.equal(run(shell, removeDialogHookDir(dir), root).status, 0);
      await assert.rejects(lstat(dir));
      assert.deepEqual(decodeDialogHookFrame(run(shell, readDialogHooks(dir, true), root).stdout), { folder: false, files: [] });
      // No folder: the hook reads its input and drops it, silently.
      assert.deepEqual(run(shell, dialogHookCommand(NONCE, 'PreToolUse'), root, env, pre), { status: 0, stdout: '', stderr: '' }, `${shellLabel} PreToolUse with no folder`);
      await assert.rejects(lstat(dir));
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
