import { setTimeout as delay } from 'node:timers/promises';
import { focusedPermission, parsePermissionScreen, permissionGuardLines, samePermission, type NativePermissionScreen } from '../core/permission-screen';
import { turnComposer } from '../core/turn-controls';
import { readHookPermission, type PermissionCall } from '../core/permission-hook';
import type { PermissionAction } from '../shared/native-permission';
import { NavigationKeyNotSent, TranscriptChangedNoKeys } from './native-settings';
import type { QuestionDriver } from './native-question-actions';
import { t } from '../shared/i18n';

/** A transport failure can occur after tmux accepted the key. Never replay it. */
export class PermissionInputUnconfirmed extends Error {
  constructor(cause?: unknown) { super(t('native.permissionUnconfirmed'), { cause }); }
}
const changed = () => new Error(t('native.permissionChanged'));
/** Claude Code ignores a keyed dialog's keys for a moment after it opens (Shift+Tab for 700 ms,
 * and a refused key holds off the next for a second); press only once it has been up this long. */
const KEYED_SETTLE_MS = 1000;
const equalScreen = (a: NativePermissionScreen, b: NativePermissionScreen) => samePermission(a, b) && focusedPermission(a) === focusedPermission(b);

/**
 * Answer Claude Code's tool permission dialog the way a user would: move the
 * focus with arrows, proving each step on a fresh frame, then press Enter
 * (or Esc to cancel), and confirm that this dialog has closed. A dialog whose
 * choices are keys (Enter, Shift+Tab) gets that one key on the verified frame.
 * Any dialog that is not a tool's own (keyed, or one Lectern only reads generically)
 * may ignore keys right after it opens: its first key waits until it has been up a second.
 */
export async function performPermissionAction(driver: Pick<QuestionDriver, 'frame' | 'questionKey'>, paneId: string, panePid: number,
  expected: NativePermissionScreen, action: PermissionAction, assertCurrent: () => void, call?: PermissionCall): Promise<void> {
  const deadline = Date.now() + 20_000, generic = expected.kind === 'native-dialog';
  const check = () => { assertCurrent(); if (Date.now() >= deadline) throw new Error(t('native.permissionTimeout')); };
  // Keys are guarded on the dialog's own rows in the last frame read (permissionGuardLines):
  // the waiting call's row above it blinks.
  let guardLines: number | undefined;
  const inspect = async () => {
    check();
    const frame = await driver.frame();
    check();
    if (frame.paneId !== paneId || frame.panePid !== panePid || frame.nativeStatus === 'shell') throw changed();
    // A card read with its PermissionRequest hook (core/permission-hook.ts) reads every frame so.
    const read = call ? (viewport: string) => readHookPermission(viewport, call) : (viewport: string) => parsePermissionScreen(viewport, { generic });
    const screen = read(frame.viewport);
    guardLines = screen && permissionGuardLines(frame.viewport, screen, { generic }, read);
    return { frame, screen };
  };
  const initial = (await inspect()).screen;
  if (!initial || !equalScreen(initial, expected)) throw changed();
  const seen = Date.now();
  let current = initial, awaitingEffect = false;
  const key = async (value: 'Up' | 'Down' | 'Enter' | 'Escape' | 'BTab') => {
    for (let attempt = 0; ; attempt++) {
      check();
      awaitingEffect = true;
      try { await driver.questionKey(value, guardLines); return; }
      catch (error) {
        // Only an explicit "not sent" receipt on an unchanged dialog may retry. A changed
        // transcript is not sent either, but the same guard would refuse it again.
        if (!(error instanceof NavigationKeyNotSent)) throw error;
        awaitingEffect = false;
        if (error instanceof TranscriptChangedNoKeys) throw error;
        if (attempt === 2) throw error;
        const again = (await inspect()).screen;
        if (!again || !equalScreen(again, current)) throw changed();
      }
    }
  };
  // A stale redraw can repeat the old frame; never repeat a key while waiting.
  const settle = async (test: (next: NativePermissionScreen) => boolean, closes = false) => {
    for (const ms of [0, 35, 65, 120, 200, 320, 500, 700, 1000, 1500]) {
      if (ms) await delay(ms);
      const { frame, screen } = await inspect();
      if (!screen) {
        // Closed: the input box is back (idle, or the approved tool running).
        if (closes && (turnComposer(frame.viewport) || frame.nativeStatus === 'busy' || frame.nativeStatus === 'idle')) { awaitingEffect = false; return; }
        if (!closes) throw changed();
        continue;
      }
      if (closes && !samePermission(screen, current)) { awaitingEffect = false; return; } // the next tool's dialog
      if (!closes && test(screen)) { current = screen; awaitingEffect = false; return; }
      if (!equalScreen(screen, current)) throw changed();
    }
    throw new Error(t('native.permissionNoResult'));
  };
  // A keyed dialog: wait out its input grace on the same dialog, checked again.
  const settleKeyed = async () => {
    if (Date.now() - seen >= KEYED_SETTLE_MS) return;
    await delay(KEYED_SETTLE_MS - (Date.now() - seen));
    const again = (await inspect()).screen;
    if (!again || !equalScreen(again, current)) throw changed();
  };
  try {
    if (action?.kind === 'cancel') {
      // A dialog read generically takes Esc only when its key hints say so.
      if (current.kind === 'native-dialog' && current.escape === undefined) throw new Error(t('native.permissionOptionUnavailable'));
      if (current.kind) await settleKeyed();
      await key('Escape'); await settle(() => false, true); return;
    }
    if (action?.kind !== 'choose' || !Number.isSafeInteger(action.number)) throw new Error(t('native.invalidPermissionChoice'));
    const index = current.options.findIndex(option => option.number === action.number);
    if (index < 0) throw new Error(t('native.permissionNoOption'));
    // A keyed choice ("Auto mode can't check actions …"): its own key, then the dialog must close.
    const keyed = current.options[index].key;
    if ((current.kind && current.kind !== 'native-dialog') || keyed) {
      if (!keyed || current.options[index].unavailable) throw new Error(t('native.permissionOptionUnavailable'));
      await settleKeyed();
      await key(keyed);
      await settle(() => false, true);
      return;
    }
    if (current.kind) await settleKeyed();
    let at = focusedPermission(current);
    if (at < 0) throw changed();
    while (at !== index) {
      const step = Math.sign(index - at);
      await key(step < 0 ? 'Up' : 'Down');
      await settle(next => samePermission(current, next) && focusedPermission(next) === at + step);
      at += step;
    }
    await key('Enter');
    await settle(() => false, true);
  } catch (error) {
    if (awaitingEffect && !(error instanceof NavigationKeyNotSent)) throw new PermissionInputUnconfirmed(error);
    throw error;
  }
}
