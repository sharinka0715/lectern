import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPrivateTmux, privateTmux } from '../scripts/fixtures/private-tmux.mjs';

test('only the private tmux fixture shuts down tmux servers', () => {
  const shutdown = ['kill', 'server'].join('-');
  const hits: string[] = [];
  for (const [dir, extension] of [['scripts', /\.[mc]js$/], ['tests', /\.ts$/]] as const) {
    const root = new URL(`../${dir}/`, import.meta.url);
    for (const file of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
      if (!extension.test(file) || `${dir}/${file.replaceAll('\\', '/')}` === 'scripts/fixtures/private-tmux.mjs') continue;
      readFileSync(new URL(file.replaceAll('\\', '/'), root), 'utf8').split('\n').forEach((line, index) => {
        if (line.includes(shutdown)) hits.push(`${dir}/${file}:${index + 1}`);
      });
    }
  }
  assert.deepEqual(hits, []);
});

test('a deleted private tmux directory rejects commands and skips shutdown', { skip: process.platform === 'win32' }, t => {
  const root = mkdtempSync(path.join(tmpdir(), 'lt-socket-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, 'tmux-spy');
  const marker = path.join(root, 'called');
  writeFileSync(executable, '#!/bin/sh\ntouch "$TMUX_SPY_MARKER"\n', { mode: 0o700 });
  const dir = path.join(root, 'private');
  createPrivateTmux(dir, { executable });
  rmSync(dir, { recursive: true }); // No server was started.
  const fixture = privateTmux(dir, { executable, env: { ...process.env, TMUX_SPY_MARKER: marker } });
  fixture.kill();
  fixture.killAll();
  assert.throws(() => fixture.tmux('display-message', '-p', '#{pid}'), /Private tmux directory is missing/);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(dir), false);
});

test('explicit private socket can start and stop a tmux server', { skip: process.platform === 'win32' }, t => {
  const dir = mkdtempSync('/tmp/lt-socket-test-');
  const fixture = createPrivateTmux(dir, { env: { ...process.env, TMUX: 'fixture', TMUX_PANE: '%1' } });
  t.after(() => fixture.cleanup());
  assert.equal(fixture.env.TMUX_TMPDIR, dir);
  assert.equal(fixture.env.TMUX, undefined);
  assert.equal(fixture.env.TMUX_PANE, undefined);
  assert.equal(fixture.socket, path.join(dir, `tmux-${process.getuid!()}`, 'default'));
  try { fixture.tmux('-V'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    t.skip('tmux is unavailable'); return;
  }

  fixture.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'fixture', 'sleep 30');
  assert.equal(fixture.tmux('list-sessions', '-F', '#{session_name}').trim(), 'fixture');
  fixture.kill();
  assert.throws(() => fixture.tmux('list-sessions'), /no server running|error connecting/);
  fixture.cleanup();
  assert.equal(existsSync(dir), false);
});
