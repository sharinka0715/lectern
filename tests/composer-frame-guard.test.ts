import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composerFrameGuard } from '../src/backend/composer-frame-guard';

// Cropped raw tmux captures from the same failed paste over SSH. The slot was
// occupied when Lectern observed the composer and empty at the dispatch check.
const { before, atDispatch } = JSON.parse(readFileSync(
  new URL('./fixtures/settings/ssh-composer-advisory.json', import.meta.url), 'utf8',
)) as { before: string; atDispatch: string };

function matches(previous: string, live: string, tailLines?: number) {
  const guard = composerFrameGuard(previous, tailLines);
  const source = guard.tailLines ? `tail -n ${guard.tailLines}` : 'cat';
  const expected = guard.tailLines
    ? guard.viewport.split('\n').slice(-guard.tailLines - 1).join('\n') : guard.viewport;
  return execFileSync('/bin/sh', ['-c', source + guard.filter], { input: live, encoding: 'utf8' }) === expected;
}

test('settings paste accepts the observed focus notice disappearing or reappearing in its exact slot',
  { skip: process.platform === 'win32' }, () => {
    for (const tail of [undefined, 5, 4]) {
      assert.ok(matches(before, atDispatch, tail));
      assert.ok(matches(atDispatch, before, tail));
    }
    assert.equal(composerFrameGuard(atDispatch, 4).tailLines, 5);
  });

test('changes to the composer, controls, completion or any other guarded row still reject a paste',
  { skip: process.platform === 'win32' }, () => {
    for (const changed of [
      before.replace('tmux focus-events off', 'tmux focus-events on'),
      before.replace('tmux focus-events off', 'Allow this tool? · tmux focus-events off'),
      before.replace('tmux focus-events off', '\x1b[8mtmux focus-events off'),
      before.replace('tmux focus-events off', '❯ /effort'),
      atDispatch.replace('❯', '❯ my draft'),
      atDispatch.replace('auto mode on', 'plan mode on'),
      atDispatch.replace('─────', '━━━━━'),
    ]) assert.equal(matches(before, changed, 4), false);
    assert.equal(matches(before, atDispatch.replace(/^ +/u, 'New upstream message')), false);
    assert.equal(composerFrameGuard(before.replace('❯', '❯ /effort')).filter, '');
  });
