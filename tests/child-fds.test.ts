import assert from 'node:assert/strict';
import test from 'node:test';
import { extendedStdio, spawn, withoutInheritedDescriptors } from '../src/backend/child-fds';

test('stdio keeps the three streams and maps every higher descriptor to the filler', () => {
  assert.deepEqual(extendedStdio(['pipe', 'pipe', 'pipe'], 5, 9), ['pipe', 'pipe', 'pipe', 9, 9, 9]);
  assert.deepEqual(extendedStdio('ignore', 4, 7), ['ignore', 'ignore', 'ignore', 7, 7]);
  assert.deepEqual(extendedStdio(undefined, 3, 7), ['pipe', 'pipe', 'pipe', 7]);
  assert.deepEqual(extendedStdio(['ignore', 'pipe', 'ignore'], 2, 7), ['ignore', 'pipe', 'ignore']);
  const options = { stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], windowsHide: true };
  assert.equal(withoutInheritedDescriptors(options, 'darwin'), options, 'macOS and Windows spawn as before');
});

test('on Linux a child sees no descriptor of ours above stderr', { skip: process.platform !== 'linux' }, async () => {
  // `exec`: ls lists its own descriptors, as inherited (plus the directory it reads).
  const child = spawn('/bin/sh', ['-c', 'exec ls -l /proc/self/fd'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 0);
  const rows = [...output.matchAll(/ (\d+) -> (.+)$/gm)].map(match => [match[1], match[2]]).filter(([fd]) => Number(fd) > 2);
  assert.ok(rows.length > 0, output);
  const leaked = rows.filter(([, target]) => target !== '/dev/null' && !target.startsWith('/proc/'));
  assert.deepEqual(leaked, [], 'descriptors above stderr are /dev/null');
});
