import assert from 'node:assert/strict';
import test from 'node:test';
import { isUnsupportedTarget, sshOnly, targetSystem, unsupportedTargetMessage, windowsShellFailure } from '../src/shared/supported-targets';

test('macOS and Linux targets are supported; Windows (Git Bash, MSYS, Cygwin) and others are not', () => {
  for (const name of ['Linux', 'Darwin', 'Linux\n']) assert.deepEqual(targetSystem(name), { supported: true }, name);
  for (const name of ['MINGW64_NT-10.0-19045', 'MSYS_NT-10.0', 'CYGWIN_NT-10.0-22631', 'Windows_NT'])
    assert.deepEqual(targetSystem(name), { supported: false, system: 'Windows' }, name);
  assert.deepEqual(targetSystem('FreeBSD'), { supported: false, system: 'FreeBSD' });
  assert.deepEqual(targetSystem(''), { supported: false, system: '未知系统' });
});

test('cmd.exe and PowerShell refusing the POSIX command read as a Windows target', () => {
  assert.equal(windowsShellFailure("'exec' is not recognized as an internal or external command,\r\noperable program or batch file."), true);
  assert.equal(windowsShellFailure("exec : The term 'exec' is not recognized as the name of a cmdlet, function, script file"), true);
  assert.equal(windowsShellFailure("'exec' 不是内部或外部命令，也不是可运行的程序\r\n或批处理文件。"), true);
  assert.equal(windowsShellFailure('exec : 无法将“exec”项识别为 cmdlet、函数、脚本文件或可运行程序的名称。'), true);
  assert.equal(windowsShellFailure('ssh: connect to host box port 22: Connection refused'), false);
  assert.equal(windowsShellFailure('sh: tmux: command not found'), false);
});

test('only Windows is limited to SSH machines; the refusal is recognisable', () => {
  assert.equal(sshOnly('win32'), true);
  assert.equal(sshOnly('darwin'), false);
  assert.equal(sshOnly('linux'), false);
  assert.equal(isUnsupportedTarget(unsupportedTargetMessage('box', 'Windows')), true);
  assert.equal(isUnsupportedTarget('Permission denied (publickey).'), false);
});
