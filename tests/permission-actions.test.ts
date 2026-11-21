import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePermissionScreen } from '../src/core/permission-screen';
import { performPermissionAction, PermissionInputUnconfirmed } from '../src/backend/native-permission-actions';
import { NavigationKeyNotSent } from '../src/backend/native-settings';
import type { PermissionAction } from '../src/shared/native-permission';

// Claude Code 2.1.328 frames, captured with a loopback model (see permission-screen.test.ts).
const fixture = (name: string) => readFileSync(new URL(`./fixtures/permission-2.1.328/${name}`, import.meta.url), 'utf8');
const bash = fixture('bash.txt'), edit = fixture('edit.txt'), done = fixture('edit-rejected.txt'), interrupted = fixture('rm-interrupted.txt');
/** The Bash dialog with the focus on another row. */
const focused = (n: number) => bash.replace(' ❯ 1. Yes', '   1. Yes').replace(`   ${n}. `, ` ❯ ${n}. `);

type Step = string | ((keys: string[]) => string);
/** Frames returned in turn after each key; a key may also throw. */
function driver(frames: Step[], options: { notSentOnce?: string } = {}) {
  const keys: string[] = [];
  let index = 0, failed = false;
  return {
    keys,
    frame: async () => {
      const step = frames[Math.min(index++, frames.length - 1)];
      return { paneId: '%3', panePid: 77, viewport: typeof step === 'function' ? step(keys) : step, nativeStatus: 'waiting', nativeWaitingFor: 'permission prompt' };
    },
    questionKey: async (key: string) => {
      if (options.notSentOnce === key && !failed) { failed = true; throw new NavigationKeyNotSent(); }
      keys.push(key);
    },
  };
}
const run = (d: ReturnType<typeof driver>, action: PermissionAction, expected = parsePermissionScreen(bash)!) =>
  performPermissionAction(d, '%3', 77, expected, action, () => {});

test('Yes on the focused row is one Enter, confirmed by the dialog closing', async () => {
  const d = driver([bash, bash, done]);
  await run(d, { kind: 'choose', number: 1 });
  assert.deepEqual(d.keys, ['Enter']);
});

test('another row is reached one verified arrow at a time, through stale redraws', async () => {
  const d = driver([bash, bash, focused(2), focused(2), focused(3), focused(3), done]);
  await run(d, { kind: 'choose', number: 3 });
  assert.deepEqual(d.keys, ['Down', 'Down', 'Enter']);
  const up = driver([focused(3), focused(2), focused(1), done]);
  await run(up, { kind: 'choose', number: 1 }, parsePermissionScreen(focused(3))!);
  assert.deepEqual(up.keys, ['Up', 'Up', 'Enter']);
});

test('cancel is Esc; the next tool\'s dialog also counts as closed', async () => {
  const d = driver([bash, interrupted]);
  await run(d, { kind: 'cancel' });
  assert.deepEqual(d.keys, ['Escape']);
  const next = driver([bash, edit]);
  await run(next, { kind: 'choose', number: 1 });
  assert.deepEqual(next.keys, ['Enter']);
});

test('a changed dialog before any key sends nothing', async () => {
  const d = driver([edit]);
  await assert.rejects(run(d, { kind: 'choose', number: 1 }), /已变化/);
  const moved = driver([focused(2)]);
  await assert.rejects(run(moved, { kind: 'choose', number: 1 }), /已变化/, 'the focus moved since the card was shown');
  assert.deepEqual([...d.keys, ...moved.keys], []);
  await assert.rejects(run(driver([bash]), { kind: 'choose', number: 9 }), /没有这个选项/);
});

test('an explicit "not sent" receipt on an unchanged dialog is retried; an unverified key never is', async () => {
  const retried = driver([bash, bash, bash, done], { notSentOnce: 'Enter' });
  await run(retried, { kind: 'choose', number: 1 });
  assert.deepEqual(retried.keys, ['Enter']);
  // After Down the dialog is replaced by an unrelated one: the outcome is unknown.
  const replaced = driver([bash, edit]);
  await assert.rejects(run(replaced, { kind: 'choose', number: 2 }), PermissionInputUnconfirmed);
  assert.deepEqual(replaced.keys, ['Down']);
  // Enter that never closes the dialog is reported, not repeated.
  const stuck = driver([bash, bash]);
  await assert.rejects(run(stuck, { kind: 'choose', number: 1 }), PermissionInputUnconfirmed);
  assert.deepEqual(stuck.keys, ['Enter']);
});
