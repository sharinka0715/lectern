import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shellEnvironment } from '../src/backend/transport';
const exec = promisify(execFile);

test('non-interactive PATH uses a unique nvm installation and refuses ambiguity without sourcing profiles', { skip: process.platform === 'win32' ? 'POSIX shell fixture; Windows runs no local commands' : false }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'lectern-nvm-')), nvm = join(root, 'nvm with spaces');
  const first = join(nvm, 'versions/node/v1.2.3/bin'), second = join(nvm, 'versions/node/v2.3.4/bin');
  try {
    await mkdir(first, { recursive: true });
    await writeFile(join(first, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    // Model command discovery explicitly, so a machine-wide Claude installed on
    // the test host cannot change which fallback branch this fixture exercises.
    const inspect = async (existing: boolean) => {
      const { stdout } = await exec('/bin/sh', ['-c', `command() { return ${existing ? '0' : '1'}; }\n${shellEnvironment()}printf '%s\\0%s' "$PATH" "$lectern_claude_path_error"`], { env: { HOME: root, NVM_DIR: nvm, PATH: '/usr/bin:/bin' } });
      return stdout.split('\0');
    };
    const [uniquePath, noError] = await inspect(false);
    assert.equal(uniquePath.split(':')[0], first); assert.equal(noError, '');
    await mkdir(second, { recursive: true });
    await writeFile(join(second, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const [ambiguousPath, error] = await inspect(false);
    assert.equal(ambiguousPath.includes(nvm), false); assert.match(error, /Multiple nvm Claude installations/);
    const [existingPath, existingError] = await inspect(true);
    assert.equal(existingPath.includes(nvm), false); assert.equal(existingError, '');
    assert.equal(shellEnvironment().includes('.zshrc'), false);
    assert.equal(shellEnvironment().includes('source '), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
