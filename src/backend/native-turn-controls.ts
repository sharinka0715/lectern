import { classifySessionScreen } from '../core/screen';
import { canInterruptTurn, turnComposer, readRewind, focusedTurnCommandDescription } from '../core/turn-controls';
import { isIdleEmptyComposer } from '../core/settings-screen';
import { parseTurnProgress } from '../core/turn-progress';
import type { RewindMenu, TurnAction } from '../shared/turn-controls';
import { t } from '../shared/i18n';
import { keysNotSent } from './native-settings';

interface TurnFrame { paneId: string; panePid: number; viewport: string; nativeStatus?: string }
export interface TurnDriver {
  frame(): Promise<TurnFrame>;
  keyForTurn(key: 'queue' | 'steer' | 'stop' | 'up' | 'down' | 'accept' | 'cancel' | 'submit' | 'clear' | 'erase' | 'switchSession', footerOnly?: boolean): Promise<void>;
  pasteForTurn(text: string, footerOnly: boolean): Promise<void>;
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const changed = () => new Error(t('native.screenChanged'));
const validText = (text: unknown): text is string => typeof text === 'string' && !!text.trim() && text.length <= 100000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
// The native editor soft-wraps long drafts (CJK by display width) and indents
// continuation rows, so a pasted single line comes back as several. The editor was
// verified empty before the paste: its visible characters identify the draft.
const visible = (s: string) => s.replace(/\s+/gu, '');
export function sameDraft(rendered: string, text: string) { return visible(rendered) === visible(text); }

export interface RewindTarget { index: number; prompts: string[] }
const mismatch = () => new Error(t('native.rewindMismatch'));
// Compare the actual native list offsets, not text lookup or a GUI page index.
// Native list labels have one line; the confirmation quote has up to three.
// A truncated label is usable only if its visible prefix identifies one distinct
// prompt text on this branch. Exact duplicates are distinguished by the ordinal.
const promptText = (s: string) => s.trim().replace(/\s+/gu, ' ');
function checkpointText(rendered: string, original: string, prompts: string[]) {
  const label = promptText(rendered), text = promptText(original);
  if (label === text) return true;
  const shortened = /(?:…|\.\.\.)$/u.test(label);
  const prefix = shortened ? label.replace(/(?:…|\.\.\.)$/u,'').trimEnd() : label;
  if (!prefix || !text.startsWith(prefix) || !shortened && prefix !== promptText(original.split(/\r?\n/,1)[0])) return false;
  return !prompts.some(p => promptText(p) !== text && promptText(p).startsWith(prefix));
}
export function checkpointPosition(menu: RewindMenu, target: RewindTarget) {
  const before = menu.before ?? 0, after = menu.after ?? 0, { prompts, index } = target;
  if (menu.stage !== 'checkpoint' || index < 0 || index >= prompts.length || before + menu.rows.length + after !== prompts.length + 1) throw mismatch();
  for (const [i, row] of menu.rows.entries()) {
    const at = before + i;
    if (at === prompts.length ? row.label !== '(current)' : row.label === '(current)' ||
        !checkpointText(row.label, prompts[at], prompts)) throw mismatch();
  }
  return before + menu.focused;
}

export async function performTurnAction(driver: TurnDriver, pane: string, pid: number, action: TurnAction, target?: RewindTarget, assertCurrent?: () => void): Promise<{ restoredDraft?: string; message?: string } | undefined> {
  const inspect = async () => {
    const frame = await driver.frame();
    if (frame.paneId !== pane || frame.panePid !== pid) throw new Error(t('native.terminalChanged'));
    return frame;
  };
  const waitFor = async (test: (frame: TurnFrame) => boolean) => {
    for (const ms of [30, 60, 100, 160, 250, 400, 600]) {
      await delay(ms);
      const frame = await inspect();
      if (test(frame)) return frame;
    }
    throw new Error(t('native.commandUnconfirmed'));
  };
  // While a reply streams the frame can repaint between the read and the key. The
  // dispatch guard then refuses before sending anything, so one retry is safe once
  // a fresh frame still satisfies the same precondition.
  // A streaming reply redraws constantly; under load the guard can catch
  // a half-drawn frame more than once. Only an explicit "not sent" receipt,
  // on a frame that still allows the key, may be pressed again (at most 3 times).
  const press = async (key: Parameters<TurnDriver['keyForTurn']>[0], footerOnly: boolean, still: (frame: TurnFrame) => boolean) => {
    for (let attempt = 1; ; attempt++) {
      try { return await driver.keyForTurn(key, footerOnly); }
      catch (error) {
        if (attempt >= 3 || !keysNotSent(error)) throw error;
        await waitFor(still);
      }
    }
  };
  if (action?.kind === 'rewindTo' || action?.kind === 'restore' && target) {
    if (!target) throw mismatch();
    const text = target.prompts[target.index];
    if (!text) throw mismatch();
    const confirmation = (menu?: RewindMenu) => menu?.stage === 'confirm' && checkpointText(menu.message ?? '', text, target.prompts);
    let frame = await inspect();
    if (action.kind === 'rewindTo') {
      await performTurnAction(driver, pane, pid, {kind:'openRewind'});
      frame = await inspect();
    } else {
      const opened = readRewind(frame.viewport);
      if (!confirmation(opened) || opened!.signature !== action.signature) throw mismatch();
      // Even identical prompts produce identical confirmation pages. Return to
      // the list and verify the actual focused ordinal before any restore.
      await driver.keyForTurn('cancel');
      frame = await waitFor(f => readRewind(f.viewport)?.stage === 'checkpoint');
    }
    let menu = readRewind(frame.viewport);
    if (!menu) throw mismatch();
    let position = checkpointPosition(menu, target);
    if (action.kind === 'restore' && position !== target.index) throw mismatch();
    while (position !== target.index) {
      assertCurrent?.();
      const delta = Math.sign(target.index - position);
      await driver.keyForTurn(delta < 0 ? 'up' : 'down');
      const old = menu;
      frame = await waitFor(f => readRewind(f.viewport)?.signature !== old.signature);
      menu = readRewind(frame.viewport);
      if (!menu || checkpointPosition(menu, target) !== position + delta) throw mismatch();
      position += delta;
    }
    assertCurrent?.();
    await driver.keyForTurn('accept');
    frame = await waitFor(f => readRewind(f.viewport)?.stage === 'confirm');
    menu = readRewind(frame.viewport);
    if (!confirmation(menu)) throw mismatch();
    if (action.kind === 'rewindTo') return;
    assertCurrent?.();
    return performTurnAction(driver, pane, pid, {kind:'restore',signature:menu!.signature}, undefined, assertCurrent);
  }
  const initial = await inspect();
  const editor = turnComposer(initial.viewport);
  // Once a draft is pasted Claude hides its interrupt hint; the boxed editor,
  // native busy record and current working frame prove the same chat still owns it.
  const running = (frame: TurnFrame) => {
    const current = turnComposer(frame.viewport);
    const status = classifySessionScreen(frame.viewport).status;
    return !!current && frame.nativeStatus !== 'waiting' && status !== 'waiting' &&
      (current.running || frame.nativeStatus === 'busy' && status === 'working');
  };
  const available = (frame: TurnFrame) => frame.nativeStatus !== 'waiting' && frame.nativeStatus !== 'busy'
    && classifySessionScreen(frame.viewport).status !== 'waiting' && !readRewind(frame.viewport);
  if (!action || typeof action !== 'object') throw changed();
  if (action.kind === 'stop') {
    if (!canInterruptTurn(initial.viewport, initial.nativeStatus, editor)) throw changed();
    await press('stop', true, frame => canInterruptTurn(frame.viewport, frame.nativeStatus, turnComposer(frame.viewport)));
    // 只有原先为空的输入框才可能包含原生中断刚刚恢复的提示词。
    if (editor?.empty && !editor.queued.length) {
      for (const ms of [40, 90, 160, 300]) {
        await delay(ms);
        const frame = await inspect(), current = turnComposer(frame.viewport);
        if (current && available(frame) && !canInterruptTurn(frame.viewport, frame.nativeStatus, current)) {
          return { restoredDraft: current.empty ? undefined : current.text };
        }
      }
    }
    return;
  }
  // "Send now" cannot interrupt /compact: Claude Code holds the message until the
  // summary is written. Only a plain queue is honest while it compacts.
  if ((action.kind === 'flushQueue' || action.kind === 'steer') && parseTurnProgress(initial.viewport, editor, initial.nativeStatus === 'busy')?.compactPhase) {
    throw new Error(t('native.compactingQueueOnly'));
  }
  if (action.kind === 'flushQueue') {
    if (!running(initial) || !editor?.empty || !editor.queued.length) throw changed();
    await driver.keyForTurn('steer', true);
    return;
  }
  if (action.kind === 'queue' || action.kind === 'steer' || action.kind === 'sendRestored' || action.kind === 'openRewind') {
    const restored = action.kind === 'sendRestored';
    const opening = action.kind === 'openRewind';
    const text = opening ? '/rewind' : 'text' in action ? action.text : undefined;
    if (!validText(text)) throw new Error(t('native.enterValidMessage'));
    if (!opening && !restored && /^[!/]/.test(text.trimStart())) throw new Error(t('native.plainMessagesOnly'));
    if (opening ? !available(initial) || !isIdleEmptyComposer(initial.viewport)
      : restored ? !available(initial) || !editor || editor.empty || !sameDraft(editor.text, action.original)
      : !running(initial) || !editor?.empty) throw changed();
    if (restored && !sameDraft(editor!.text,text)) {
      await driver.keyForTurn('clear',true);
      await waitFor(f => available(f) && turnComposer(f.viewport)?.empty === true);
    }
    if (!restored || !sameDraft(editor!.text,text)) {
      await driver.pasteForTurn(text, !opening);
      await waitFor(frame => {
        const actual = turnComposer(frame.viewport);
        return !!actual && sameDraft(actual.text,text) && (opening || restored ? available(frame) : running(frame)) &&
          (!opening || focusedTurnCommandDescription(frame.viewport, '/rewind') === 'Restore earlier code, conversation, or both');
      });
    }
    const submitted = (frame: TurnFrame) => { const actual = turnComposer(frame.viewport); return !!actual && sameDraft(actual.text, text) && (opening || restored ? available(frame) : running(frame)); };
    await press(opening || restored ? 'submit' : action.kind === 'queue' ? 'queue' : 'steer', !opening, submitted);
    if (opening) await waitFor(f => readRewind(f.viewport)?.stage === 'checkpoint');
    return;
  }
  if (!('signature' in action)) throw changed();
  let menu = readRewind(initial.viewport);
  if (!menu || menu.signature !== action.signature) throw changed();
  if (action.kind === 'cancelRewind') { await driver.keyForTurn('cancel'); return; }
  if (action.kind === 'previous' || action.kind === 'next') {
    if (menu.stage !== 'checkpoint') throw changed();
    await driver.keyForTurn(action.kind === 'previous' ? 'up' : 'down');
    return;
  }
  if (action.kind !== 'checkpoint' && action.kind !== 'restore') throw changed();
  if (action.kind === 'checkpoint' && menu.stage !== 'checkpoint' || action.kind === 'restore' && menu.stage !== 'confirm') throw changed();
  const index = action.kind === 'restore' ? menu.rows.findIndex(r => r.label === 'Restore conversation') : action.index;
  if (index === undefined || !Number.isInteger(index) || !menu.rows[index] || menu.rows[index].label === '(current)') throw changed();
  // Where reaching an edge scrolls the native list, keep following the exact
  // message, rejecting ambiguities introduced by a redraw or duplicate label.
  const rows = JSON.stringify(menu.rows);
  const choice = menu.rows[index];
  const delta = index - menu.focused;
  for (let step = 0; step < Math.abs(delta); step++) {
    const prev = menu!;
    await driver.keyForTurn(delta < 0 ? 'up' : 'down');
    const frame = await waitFor(f => readRewind(f.viewport)?.signature !== prev.signature);
    menu = readRewind(frame.viewport);
    if (!menu || menu.stage !== prev.stage || menu.message !== prev.message) throw changed();
    if (JSON.stringify(menu.rows) !== rows) {
      if (JSON.stringify(menu.rows[menu.focused]) === JSON.stringify(choice) && menu.rows.filter(r => r.label === choice.label).length === 1) break;
      throw new Error(t('native.listScrolled'));
    }
    if (menu.focused !== prev.focused + Math.sign(delta)) throw changed();
  }
  if (JSON.stringify(menu.rows[menu.focused]) !== JSON.stringify(choice)) throw changed();
  const message = menu.message;
  assertCurrent?.();
  await driver.keyForTurn('accept');
  if (action.kind === 'checkpoint') {
    await waitFor(f => readRewind(f.viewport)?.stage === 'confirm');
    return;
  }
  const frame = await waitFor(f => !readRewind(f.viewport) && !!turnComposer(f.viewport));
  const draft = turnComposer(frame.viewport)!;
  return { restoredDraft: !draft.empty ? draft.text : undefined, message };
}
