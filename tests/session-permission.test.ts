import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { earlyPermission, observePermission, permissionDialog } from '../src/main/session-permission';
import { permissionLayout } from '../src/core/permission-screen';
import type { SessionSettingsHandle } from '../src/main/session-settings-cache';

const fixture = (path: string) => readFileSync(new URL(`./fixtures/${path}`, import.meta.url), 'utf8');

test('before the transcript has the call: a tool\'s dialog for a permission prompt, a keyed one for a dialog, a generic one whenever Claude Code waits', () => {
  const bash = permissionDialog(fixture('permission-2.1.328/bash.txt'), 'waiting')!;
  const billing = permissionDialog(fixture('auto-mode-billing-2.1.330/streamed.txt'), 'waiting')!;
  const mcp = permissionDialog(fixture('native-dialog-2.1.330/mcp-server.txt'), 'waiting')!;
  assert.deepEqual([bash.kind, billing.kind, mcp.kind], [undefined, 'auto-mode-billing', 'native-dialog']);
  const early = (screen: typeof bash, waitingFor?: string, status: 'waiting' | 'busy' | 'none' = 'waiting', owned?: string) =>
    earlyPermission(screen, status === 'none' ? undefined : status, waitingFor, owned);
  assert.deepEqual([early(bash, 'permission prompt'), early(bash, 'dialog open'), early(bash, undefined)], [true, false, false]);
  assert.deepEqual([early(billing, 'dialog open'), early(billing, 'permission prompt'), early(billing, 'input needed')], [true, true, false]);
  // Claude Code's own "waiting" is what vouches for a dialog read only by its layout.
  assert.deepEqual([early(mcp, 'dialog open'), early(mcp, 'sandbox request'), early(mcp, undefined)], [true, true, true]);
  for (const screen of [bash, billing, mcp]) {
    for (const status of ['busy', 'none'] as const) assert.equal(early(screen, 'permission prompt', status), false);
    // Seen with its call: still on screen after the call's result, it is a late frame.
    assert.equal(early(screen, 'dialog open', 'waiting', permissionLayout(screen)), false);
  }
});

test('known dialogs are always read; any other native dialog only while Claude Code waits', () => {
  const billing = fixture('auto-mode-billing-2.1.330/streamed.txt'), mcp = fixture('native-dialog-2.1.330/mcp-server.txt');
  for (const status of [undefined, 'waiting'] as const) assert.equal(permissionDialog(billing, status)?.kind, 'auto-mode-billing');
  assert.equal(permissionDialog(fixture('permission-2.1.328/bash.txt'), undefined)?.title, 'Bash command');
  assert.equal(permissionDialog(mcp, 'waiting')?.kind, 'native-dialog');
  for (const status of [undefined, 'busy', 'idle'] as const) assert.equal(permissionDialog(mcp, status), undefined, String(status));
  // Never the dialogs Lectern answers or drives itself, nor an input box.
  const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/gu, '');
  for (const [name, text] of [
    ['AskUserQuestion', fixture('question-2.1.329/short.txt')],
    ['the rewind menu', strip(fixture('rewind-2.1.329/rewind-menu.ansi'))],
    ['"Make auto mode your default"', fixture('auto-mode/nudge-2.1.330.txt')],
    ['an idle input box', fixture('auto-mode-billing-2.1.330/continued.txt')],
  ] as const) assert.equal(permissionDialog(text, 'waiting'), undefined, name);
});

test('a generic card read off the screen alone keeps its token and identity when its call shows up', () => {
  const handle = {} as SessionSettingsHandle;
  const screen = permissionDialog(fixture('native-dialog-2.1.330/mcp-server.txt'), 'waiting')!;
  const first = observePermission(undefined, screen, handle, undefined);
  assert.equal(first.snapshot.toolUseId, undefined);
  assert.equal(observePermission(first, screen, handle, undefined), first);
  const owned = observePermission(first, screen, handle, 'toolu_wait');
  assert.deepEqual([owned.snapshot.token, owned.snapshot.cardId, owned.snapshot.toolUseId], [first.snapshot.token, first.snapshot.cardId, 'toolu_wait']);
});
