import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePermissionScreen, permissionGuardLines } from '../src/core/permission-screen';
import { performPermissionAction, PermissionInputUnconfirmed } from '../src/backend/native-permission-actions';
import { NavigationKeyNotSent, TranscriptChangedNoKeys } from '../src/backend/native-settings';
import type { PermissionAction } from '../src/shared/native-permission';

// Claude Code 2.1.328 frames, captured with a loopback model (see permission-screen.test.ts).
const fixture = (name: string) => readFileSync(new URL(`./fixtures/permission-2.1.328/${name}`, import.meta.url), 'utf8');
const bash = fixture('bash.txt'), edit = fixture('edit.txt'), done = fixture('edit-rejected.txt'), interrupted = fixture('rm-interrupted.txt');
/** The Bash dialog with the focus on another row. */
const focused = (n: number) => bash.replace(' ❯ 1. Yes', '   1. Yes').replace(`   ${n}. `, ` ❯ ${n}. `);

type Step = string | ((keys: string[]) => string);
/** Frames returned in turn after each key; a key may also throw. */
function driver(frames: Step[], options: { notSentOnce?: string; recordChanged?: boolean } = {}) {
  const keys: string[] = [], attempts: string[] = [], guarded: (number | undefined)[] = [];
  let index = 0, failed = false;
  return {
    keys, attempts, guarded,
    frame: async () => {
      const step = frames[Math.min(index++, frames.length - 1)];
      return { paneId: '%3', panePid: 77, viewport: typeof step === 'function' ? step(keys) : step, nativeStatus: 'waiting', nativeWaitingFor: 'permission prompt' };
    },
    questionKey: async (key: string, tailLines?: number) => {
      guarded.push(tailLines);
      if (options.notSentOnce === key && !failed) { failed = true; throw new NavigationKeyNotSent(); }
      if (options.recordChanged) { attempts.push(key); throw new TranscriptChangedNoKeys(); }
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

test('each key is guarded on the dialog rows of the frame just read, not on the blinking call above', async () => {
  const blank = (text: string) => text.replace('⏺ Writing a greeting file', '  Writing a greeting file');
  const d = driver([bash, blank(bash), focused(2), blank(focused(2)), done]);
  await run(d, { kind: 'choose', number: 2 });
  assert.deepEqual(d.keys, ['Down', 'Enter']);
  const lines = permissionGuardLines(bash, parsePermissionScreen(bash)!);
  assert.ok(lines && lines < bash.split('\n').length - 10);
  assert.deepEqual(d.guarded, [lines, lines]);
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

// "Auto mode can't check actions in this session" (Claude Code 2.1.330): choices are keys.
const unavailable = readFileSync(new URL('./fixtures/auto-mode-unavailable-2.1.330/dialog.txt', import.meta.url), 'utf8');
const tooShort = unavailable.replace('and stop · Esc', 'and stop (needs a taller window) · Esc');
const keyed = (d: ReturnType<typeof driver>, action: PermissionAction, expected = parsePermissionScreen(unavailable)!) =>
  performPermissionAction(d, '%3', 77, expected, action, () => {});

test('staying in auto mode is Enter on the verified dialog; the tool\'s own permission dialog follows', async () => {
  const d = driver([unavailable, unavailable, bash]);
  await keyed(d, { kind: 'choose', number: 1 });
  assert.deepEqual(d.keys, ['Enter']);
});

test('leaving for accept edits mode is Shift+Tab; the input box coming back closes it', async () => {
  const d = driver([unavailable, unavailable, done]);
  await keyed(d, { kind: 'choose', number: 2 });
  assert.deepEqual(d.keys, ['BTab']);
  const stop = driver([unavailable, unavailable, done]);
  await keyed(stop, { kind: 'cancel' });
  assert.deepEqual(stop.keys, ['Escape']);
});

test('a choice Claude Code does not take now, or a changed dialog, sends nothing', async () => {
  const short = driver([tooShort]);
  await assert.rejects(keyed(short, { kind: 'choose', number: 2 }, parsePermissionScreen(tooShort)!), /不接受这个选项/);
  const grown = driver([unavailable]);
  await assert.rejects(keyed(grown, { kind: 'choose', number: 2 }, parsePermissionScreen(tooShort)!), /已变化/, 'the card was made from another frame');
  const other = driver([bash]);
  await assert.rejects(keyed(other, { kind: 'choose', number: 1 }), /已变化/);
  await assert.rejects(keyed(driver([unavailable]), { kind: 'choose', number: 3 }), /没有这个选项/);
  assert.deepEqual([...short.keys, ...grown.keys, ...other.keys], []);
});

test('a keyed choice waits out the dialog\'s input grace on the same, rechecked dialog', async () => {
  const started = Date.now(), d = driver([unavailable, unavailable, done]);
  await keyed(d, { kind: 'choose', number: 2 });
  assert.ok(Date.now() - started >= 1000, 'Claude Code ignores Shift+Tab in the dialog\'s first 700 ms');
  assert.deepEqual(d.keys, ['BTab']);
  const replaced = driver([unavailable, bash]);
  await assert.rejects(keyed(replaced, { kind: 'choose', number: 1 }), /已变化/);
  assert.deepEqual(replaced.keys, [], 'the dialog changed while waiting: nothing is pressed');
});

test('a key the dialog ignores (it was too soon, or refused) is reported unconfirmed, never pressed again', async () => {
  const ignored = driver([unavailable, unavailable]);
  await assert.rejects(keyed(ignored, { kind: 'choose', number: 1 }), PermissionInputUnconfirmed);
  assert.deepEqual(ignored.keys, ['Enter']);
  const retried = driver([unavailable, unavailable, unavailable, done], { notSentOnce: 'BTab' });
  await keyed(retried, { kind: 'choose', number: 2 });
  assert.deepEqual(retried.keys, ['BTab']);
});

test('the unnumbered "No / Yes" that follows staying in auto mode is answered by verified arrows too', async () => {
  const ask = readFileSync(new URL('./fixtures/auto-mode-unavailable-2.1.321/after-stay.txt', import.meta.url), 'utf8');
  const onYes = ask.replace(' ❯ No', '   No').replace('   Yes', ' ❯ Yes');
  const d = driver([ask, ask, onYes, onYes, done]);
  await performPermissionAction(d, '%3', 77, parsePermissionScreen(ask)!, { kind: 'choose', number: 2 }, () => {});
  assert.deepEqual(d.keys, ['Down', 'Enter']);
  const no = driver([ask, done]);
  await performPermissionAction(no, '%3', 77, parsePermissionScreen(ask)!, { kind: 'choose', number: 1 }, () => {});
  assert.deepEqual(no.keys, ['Enter']);
});

// The classifier billing notice (Claude Code 2.1.300/2.1.310): "Enter to continue · Esc to cancel".
const billingFixture = (name: string) => readFileSync(new URL(`./fixtures/auto-mode-unavailable-2.1.300/${name}.txt`, import.meta.url), 'utf8');
const billing = billingFixture('billing-notice'), continued = billingFixture('billing-continued'), cancelled = billingFixture('billing-cancelled');

test('continuing past the billing notice is one Enter after its input grace; the finished turn closes it', async () => {
  const started = Date.now(), d = driver([billing, billing, continued]);
  await performPermissionAction(d, '%3', 77, parsePermissionScreen(billing)!, { kind: 'choose', number: 1 }, () => {});
  assert.ok(Date.now() - started >= 1000, 'the notice is opened with an input grace too');
  assert.deepEqual(d.keys, ['Enter']);
  const stop = driver([billing, billing, cancelled]);
  await performPermissionAction(stop, '%3', 77, parsePermissionScreen(billing)!, { kind: 'cancel' }, () => {});
  assert.deepEqual(stop.keys, ['Escape']);
});

test('the billing notice is answered only as read: no other choice, no changed screen, no second key', async () => {
  await assert.rejects(performPermissionAction(driver([billing]), '%3', 77, parsePermissionScreen(billing)!, { kind: 'choose', number: 2 }, () => {}), /没有这个选项/);
  const other = driver([unavailable]);
  await assert.rejects(performPermissionAction(other, '%3', 77, parsePermissionScreen(billing)!, { kind: 'choose', number: 1 }, () => {}), /已变化/);
  assert.deepEqual(other.keys, []);
  const ignored = driver([billing, billing]);
  await assert.rejects(performPermissionAction(ignored, '%3', 77, parsePermissionScreen(billing)!, { kind: 'choose', number: 1 }, () => {}), PermissionInputUnconfirmed);
  assert.deepEqual(ignored.keys, ['Enter'], 'reported unconfirmed, never pressed again');
});

test('a transcript that changed after the card was read stops the answer as "not sent": never unconfirmed, never retried', async () => {
  // The record guard runs before the key (e.g. the card still belonged to the previous call).
  const d = driver([bash, bash], { recordChanged: true });
  await assert.rejects(run(d, { kind: 'choose', number: 1 }), (error: unknown) => error instanceof TranscriptChangedNoKeys && !(error instanceof PermissionInputUnconfirmed) && /未发送按键/.test((error as Error).message));
  assert.deepEqual(d.attempts, ['Enter'], 'tried once; the same guard would refuse again');
  assert.deepEqual(d.keys, []);
  const moving = driver([bash, bash, focused(2)], { recordChanged: true });
  await assert.rejects(run(moving, { kind: 'choose', number: 2 }), TranscriptChangedNoKeys);
  assert.deepEqual(moving.attempts, ['Down']);
  const keyedNotice = driver([unavailable, unavailable], { recordChanged: true });
  await assert.rejects(keyed(keyedNotice, { kind: 'choose', number: 1 }), TranscriptChangedNoKeys);
  assert.deepEqual(keyedNotice.attempts, ['Enter']);
});

// A dialog Lectern reads only by its common layout (Claude Code 2.1.330's MCP server approval;
// its 2.1.330 billing notice reworded): the same verified keys, the same input grace.
const mcp = readFileSync(new URL('./fixtures/native-dialog-2.1.330/mcp-server.txt', import.meta.url), 'utf8');
const mcpOn = (n: number) => mcp.replace('  ❯ Continue without', '    Continue without').replace(['    Use this MCP server', '    Use this and all', '    Continue without'][n - 1], ['  ❯ Use this MCP server', '  ❯ Use this and all', '  ❯ Continue without'][n - 1]);
const billing330 = readFileSync(new URL('./fixtures/auto-mode-billing-2.1.330/streamed.txt', import.meta.url), 'utf8');
const billing330Done = readFileSync(new URL('./fixtures/auto-mode-billing-2.1.330/cancelled.txt', import.meta.url), 'utf8');
const reworded = billing330.replace("We're changing auto mode to no longer charge for classifier requests in Claude Code.", 'Auto mode switched to its built-in safety check for this session');
const generic = (d: ReturnType<typeof driver>, screen: string, action: PermissionAction) =>
  performPermissionAction(d, '%3', 77, parsePermissionScreen(screen, { generic: true })!, action, () => {});

test('a choice in a dialog read generically: verified arrows, then Enter, after its input grace', async () => {
  assert.equal(parsePermissionScreen(mcp, { generic: true })?.kind, 'native-dialog');
  const started = Date.now(), d = driver([mcp, mcp, mcpOn(2), mcpOn(2), mcpOn(1), mcpOn(1), billing330Done]);
  await generic(d, mcp, { kind: 'choose', number: 1 });
  assert.ok(Date.now() - started >= 1000);
  assert.deepEqual(d.keys, ['Up', 'Up', 'Enter']);
  const esc = driver([mcp, mcp, billing330Done]);
  await generic(esc, mcp, { kind: 'cancel' });
  assert.deepEqual(esc.keys, ['Escape']);
});

test('a keyed dialog read generically gets Enter or Esc only where its key hints offer them', async () => {
  const enter = driver([reworded, reworded, billing330Done]);
  await generic(enter, reworded, { kind: 'choose', number: 1 });
  assert.deepEqual(enter.keys, ['Enter']);
  const esc = driver([reworded, reworded, billing330Done]);
  await generic(esc, reworded, { kind: 'cancel' });
  assert.deepEqual(esc.keys, ['Escape']);
  const noEsc = reworded.replace('Enter to continue · Esc to cancel', 'Enter to continue');
  const refused = driver([noEsc]);
  await assert.rejects(generic(refused, noEsc, { kind: 'cancel' }), /不接受这个选项/);
  assert.deepEqual(refused.keys, []);
});

test('a dialog read generically that changed, or turned into another, gets no key', async () => {
  const changed = driver([mcp.replace('demo-notes', 'other-server')]);
  await assert.rejects(generic(changed, mcp, { kind: 'choose', number: 1 }), /已变化/);
  const known = driver([billing330]);
  await assert.rejects(generic(known, reworded, { kind: 'choose', number: 1 }), /已变化/, 'now the known billing card, not this one');
  const moved = driver([mcp, mcpOn(2)]);
  await assert.rejects(generic(moved, mcp, { kind: 'choose', number: 1 }), /已变化/, 'the focus moved during the input grace');
  assert.deepEqual([...changed.keys, ...known.keys, ...moved.keys], []);
});
