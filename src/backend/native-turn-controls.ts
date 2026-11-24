import { classifySessionScreen } from '../core/screen';
import { canInterruptTurn, turnComposer, readRewind, focusedTurnCommandDescription } from '../core/turn-controls';
import { isIdleEmptyComposer } from '../core/settings-screen';
import { parseTurnProgress } from '../core/turn-progress';
import type { RewindMenu, TurnAction } from '../shared/turn-controls';
import { t } from '../shared/i18n';
import { goalCommand } from '../shared/native-commands';
import { keysNotSent, TranscriptChangedNoKeys } from './native-settings';

interface TurnFrame { paneId: string; panePid: number; viewport: string; nativeStatus?: string }
export interface TurnDriver {
  frame(): Promise<TurnFrame>;
  /** `close` is Esc in the rewind menu like `cancel`, but not bound to the transcript revision
   * a rewind was chosen from: Lectern closes the menu it opened after the rewind failed. */
  keyForTurn(key: 'queue' | 'steer' | 'stop' | 'up' | 'down' | 'accept' | 'cancel' | 'close' | 'submit' | 'clear' | 'erase' | 'switchSession', footerOnly?: boolean): Promise<void>;
  pasteForTurn(text: string, footerOnly: boolean): Promise<void>;
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const changed = () => new Error(t('native.screenChanged'));
/** The awaited screen did not come (as opposed to a changed terminal or session). */
class NotYetConfirmed extends Error { constructor() { super(t('native.commandUnconfirmed')); } }

/**
 * Send one key or paste of a turn action or fork. The driver binds it to the frame
 * (or menu region) it was chosen from, and Claude Code repaints on its own meanwhile:
 * a streaming reply, a one-time note appended to the transcript (2.1.329's auto mode
 * introduction), or the 5 s "ctrl+y to paste deleted text" hint after Ctrl+U giving
 * way to the effort label again. The guard then refuses before sending anything.
 * Only that explicit refusal is retried, at most `attempts` times in all, and only
 * once `recheck` has read a fresh frame that still allows the same input (the retry
 * is bound to that frame). If the recheck fails, the refusal stands. A failure after
 * the guard passed, or a changed transcript record, is never repeated.
 */
export async function sendGuarded(dispatch: () => Promise<void>, recheck: () => Promise<unknown>, attempts = 3): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try { return await dispatch(); }
    catch (error) {
      if (attempt >= attempts || !keysNotSent(error) || error instanceof TranscriptChangedNoKeys) throw error;
      try { await recheck(); } catch { throw error; }
    }
  }
}
/**
 * Lectern typed the slash command `command` into an empty input box and cannot go on: the
 * completion that identifies it is not shown, or Enter stays refused. Take it out again
 * rather than leave a half-done command in the terminal (the chat box would only say there
 * is a draft there). The erase (Ctrl+U) is bound to a frame whose input box holds exactly
 * that command; `read` checks the pane's identity. True once the input box is empty again.
 */
export async function withdrawCommand(driver: Pick<TurnDriver, 'keyForTurn'>, command: string, read: () => Promise<string>): Promise<boolean> {
  const typed = (view: string) => turnComposer(view)?.text === command && classifySessionScreen(view).status !== 'waiting';
  const settle = async (test: (view: string) => boolean) => {
    for (const ms of [40, 80, 150, 270, 450]) { await delay(ms); if (test(await read())) return true; }
    return false;
  };
  try {
    if (!typed(await read())) return false;
    await sendGuarded(() => driver.keyForTurn('erase'), async () => { if (!await settle(typed)) throw changed(); });
    return await settle(isIdleEmptyComposer);
  } catch { return false; }
}
/** The error for a typed `command` that was not run, after `withdrawCommand`. */
export const notRunError = (command: string, cleared: boolean, refused: boolean) => new Error(t(refused
  ? cleared ? 'native.slashCommandNotSubmitted' : 'native.slashCommandNotSubmittedLeft'
  : cleared ? 'native.slashCommandUnconfirmed' : 'native.slashCommandUnconfirmedLeft', { command }));

const validText = (text: unknown): text is string => typeof text === 'string' && !!text.trim() && text.length <= 100000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
// The native editor soft-wraps long drafts (CJK by display width) and indents
// continuation rows, so a pasted single line comes back as several. The editor was
// verified empty before the paste: its visible characters identify the draft.
const visible = (s: string) => s.replace(/\s+/gu, '');
export function sameDraft(rendered: string, text: string) { return visible(rendered) === visible(text); }

// What the native /rewind completion says: 2.1.300–2.1.321, then 2.1.326–2.1.330.
const rewindDescription = /^(?:Restore the code and\/or conversation to a previous point|Restore earlier code, conversation, or both)$/;

/** `prompts` is Claude Code's whole /rewind list as Lectern reads it from the transcript, labels
 * oldest first (MessageDisplay.rewindPoints: prompts and listed local commands); `index` the target. */
export interface RewindTarget { index: number; prompts: string[] }
const mismatch = () => new Error(t('native.rewindMismatch'));
/** The transcript changed after the rewind was chosen, before its next key, and the terminal is
 * back as it was (nothing typed, or the typed /rewind or the opened menu taken out again): nothing
 * was rewound, and choosing again from a fresh read is safe. */
export class RewindRecordChanged extends Error { constructor() { super(t('native.rewindRecordChanged')); } }
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
    throw new NotYetConfirmed();
  };
  // Every key and paste goes through sendGuarded with the precondition it was chosen
  // under: a streaming reply redraws constantly, and under load the guard can catch a
  // half-drawn frame more than once. In the rewind menu the guard covers only the menu,
  // so its keys repeat only while the parsed menu (rows, focus, stage) is unchanged.
  const press = (key: Parameters<TurnDriver['keyForTurn']>[0], footerOnly: boolean | undefined, still: (frame: TurnFrame) => boolean) =>
    sendGuarded(() => driver.keyForTurn(key, footerOnly), () => waitFor(still));
  const paste = (text: string, footerOnly: boolean, still: (frame: TurnFrame) => boolean) =>
    sendGuarded(() => driver.pasteForTurn(text, footerOnly), () => waitFor(still));
  const onMenu = (menu: RewindMenu) => (frame: TurnFrame) => readRewind(frame.viewport)?.signature === menu.signature;
  const withdraw = (command: string) => withdrawCommand(driver, command, async () => (await inspect()).viewport);
  // Lectern opened the menu for a rewind it could not finish: back out again (Esc from the
  // confirmation to the list, then out of the list; Esc never restores anything) and wait for the
  // idle, empty input box /rewind was typed into. The error says whether that worked.
  const closeOpenedMenu = async (error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      for (let step = 0; step < 3; step++) {
        const menu = readRewind((await inspect()).viewport);
        if (!menu) break;
        await press('close', undefined, onMenu(menu));
        await waitFor(f => !onMenu(menu)(f));
      }
      await waitFor(f => !readRewind(f.viewport) && f.nativeStatus !== 'waiting' && isIdleEmptyComposer(f.viewport));
    } catch { return new Error(t('native.rewindMenuLeftOpen', { detail })); }
    return error instanceof TranscriptChangedNoKeys ? new RewindRecordChanged() : new Error(t('native.rewindMenuClosed', { detail }));
  };
  if (action?.kind === 'rewindTo' || action?.kind === 'restore' && target) {
    if (!target) throw mismatch();
    const text = target.prompts[target.index];
    if (!text) throw mismatch();
    const confirmation = (menu?: RewindMenu) => menu?.stage === 'confirm' && checkpointText(menu.message ?? '', text, target.prompts);
    // From the list on `frame`, move to the target's row and open its confirmation: one row
    // per key, the whole visible list re-aligned with the target's list after each.
    const chooseCheckpoint = async (frame: TurnFrame) => {
      let menu = readRewind(frame.viewport);
      if (!menu) throw mismatch();
      let position = checkpointPosition(menu, target);
      if (action.kind === 'restore' && position !== target.index) throw mismatch();
      while (position !== target.index) {
        assertCurrent?.();
        const delta = Math.sign(target.index - position);
        const old = menu;
        await press(delta < 0 ? 'up' : 'down', undefined, onMenu(old));
        frame = await waitFor(f => readRewind(f.viewport)?.signature !== old.signature);
        menu = readRewind(frame.viewport);
        if (!menu || checkpointPosition(menu, target) !== position + delta) throw mismatch();
        position += delta;
      }
      assertCurrent?.();
      await press('accept', undefined, onMenu(menu));
      frame = await waitFor(f => readRewind(f.viewport)?.stage === 'confirm');
      menu = readRewind(frame.viewport);
      if (!confirmation(menu)) throw mismatch();
      return menu!;
    };
    if (action.kind === 'rewindTo') {
      // Only a transcript change refused before /rewind was typed, or with it taken out again, is "nothing done".
      try { await performTurnAction(driver, pane, pid, {kind:'openRewind'}); }
      catch (error) { throw error instanceof TranscriptChangedNoKeys ? new RewindRecordChanged() : error; }
      try { await chooseCheckpoint(await inspect()); }
      catch (error) { throw await closeOpenedMenu(error); }
      return;
    }
    const opened = readRewind((await inspect()).viewport);
    if (!confirmation(opened) || opened!.signature !== action.signature) throw mismatch();
    // Even identical prompts produce identical confirmation pages. Return to
    // the list and verify the actual focused ordinal before any restore.
    await press('cancel', undefined, onMenu(opened!));
    const menu = await chooseCheckpoint(await waitFor(f => readRewind(f.viewport)?.stage === 'checkpoint'));
    assertCurrent?.();
    return performTurnAction(driver, pane, pid, {kind:'restore',signature:menu.signature}, undefined, assertCurrent);
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
    const flushable = (frame: TurnFrame) => { const current = turnComposer(frame.viewport); return running(frame) && !!current?.empty && current.queued.length > 0; };
    if (!flushable(initial)) throw changed();
    await press('steer', true, flushable);
    return;
  }
  if (action.kind === 'command') {
    // `/goal …` (goalCommand): Claude Code runs it at once while it replies; it is never queued.
    const text = action.text;
    if (!validText(text) || text.includes('\n') || !goalCommand(text)) throw new Error(t('native.enterValidMessage'));
    if (!running(initial) || !editor?.empty) throw changed();
    await paste(text, true, f => turnComposer(f.viewport)?.empty === true && running(f));
    // The reply may end meanwhile: Enter runs the command in an idle input box all the same.
    const typed = (frame: TurnFrame) => { const actual = turnComposer(frame.viewport);
      return !!actual && sameDraft(actual.text, text) && frame.nativeStatus !== 'waiting' && classifySessionScreen(frame.viewport).status !== 'waiting'; };
    await waitFor(typed);
    await press('submit', true, typed);
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
    const original = restored ? action.original : '';
    if (restored && !sameDraft(editor!.text,text)) {
      await press('clear', true, f => { const current = turnComposer(f.viewport); return available(f) && !!current && !current.empty && sameDraft(current.text, original); });
      await waitFor(f => available(f) && turnComposer(f.viewport)?.empty === true);
    }
    if (!restored || !sameDraft(editor!.text,text)) {
      // The input box is empty here: idle for /rewind and a restored draft, replying for queue and steer.
      await paste(text, !opening, f => turnComposer(f.viewport)?.empty === true
        && (opening ? available(f) && isIdleEmptyComposer(f.viewport) : restored ? available(f) : running(f)));
      const shown = () => waitFor(frame => {
        const actual = turnComposer(frame.viewport);
        return !!actual && sameDraft(actual.text,text) && (opening || restored ? available(frame) : running(frame)) &&
          (!opening || rewindDescription.test(focusedTurnCommandDescription(frame.viewport, '/rewind') ?? ''));
      });
      // A /rewind that is not confirmed as such is never submitted, nor left in the input box.
      try { await shown(); }
      catch (error) {
        if (!opening || !(error instanceof NotYetConfirmed)) throw error;
        throw notRunError(text, await withdraw(text), false);
      }
    }
    const submitted = (frame: TurnFrame) => { const actual = turnComposer(frame.viewport); return !!actual && sameDraft(actual.text, text) && (opening || restored ? available(frame) : running(frame)); };
    try { await press(opening || restored ? 'submit' : action.kind === 'queue' ? 'queue' : 'steer', !opening, submitted); }
    catch (error) {
      if (!opening || !keysNotSent(error)) throw error;
      const cleared = await withdraw(text);
      // The transcript changed under a rewind's Enter: once /rewind is out again, nothing was done.
      if (cleared && error instanceof TranscriptChangedNoKeys) throw error;
      throw notRunError(text, cleared, true);
    }
    if (opening) await waitFor(f => readRewind(f.viewport)?.stage === 'checkpoint');
    return;
  }
  if (!('signature' in action)) throw changed();
  let menu = readRewind(initial.viewport);
  if (!menu || menu.signature !== action.signature) throw changed();
  if (action.kind === 'cancelRewind') { await press('cancel', undefined, onMenu(menu)); return; }
  if (action.kind === 'previous' || action.kind === 'next') {
    if (menu.stage !== 'checkpoint') throw changed();
    await press(action.kind === 'previous' ? 'up' : 'down', undefined, onMenu(menu));
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
    await press(delta < 0 ? 'up' : 'down', undefined, onMenu(prev));
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
  const message = menu.message, chosen = menu;
  assertCurrent?.();
  await press('accept', undefined, onMenu(chosen));
  if (action.kind === 'checkpoint') {
    await waitFor(f => readRewind(f.viewport)?.stage === 'confirm');
    return;
  }
  const frame = await waitFor(f => !readRewind(f.viewport) && !!turnComposer(f.viewport));
  const draft = turnComposer(frame.viewport)!;
  return { restoredDraft: !draft.empty ? draft.text : undefined, message };
}
