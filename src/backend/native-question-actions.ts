import { isDeepStrictEqual as equal } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { parseQuestionScreen } from '../core/question-screen';
import { NavigationKeyNotSent } from './native-settings';
import { turnComposer } from '../core/turn-controls';
import type { NativeQuestionScreen } from '../shared/native-question';
import { isQuestionText, type QuestionAction } from '../shared/question-action';
import { t } from '../shared/i18n';

export type QuestionKey = 'Up' | 'Down' | 'Left' | 'Right' | 'Space' | 'Enter' | 'Escape' | 'n' | 'End' | 'C-u';
interface QuestionFrame { paneId: string; panePid: number; viewport: string; nativeStatus?: string; nativeWaitingFor?: string }
export interface QuestionDriver {
  frame(): Promise<QuestionFrame>;
  /** Both methods must bind the actual dispatch to the pane and last frame on the target. */
  questionKey(key: QuestionKey): Promise<void>;
  pasteQuestion(text: string): Promise<void>;
}

/** A transport failure can occur after tmux accepted input. Never replay it. */
export class QuestionInputUnconfirmed extends Error {
  constructor(cause?: unknown) { super(t('native.questionUnconfirmed'), { cause }); }
}
const changed = () => new Error(t('native.questionChanged'));
const unsupported = () => new Error(t('native.questionUnsupported'));
const focusedIndex = (s: NativeQuestionScreen) => s.options.findIndex(o => o.focused);

// Re-reading after each arrow must prove that this is the same question and the
// exact adjacent row. The preview/notes panel follows its owner, and the native
// external-editor hint can persist after moving from Other to Submit or Chat.
function sameRows(a: NativeQuestionScreen, b: NativeQuestionScreen) {
  const layout = (s: NativeQuestionScreen) => [s.kind, s.activeTab, s.question, s.multiSelect, s.tabs.map(t => t.label), s.review,
    s.options.map(o => [o.number, o.kind, o.label, o.description]), s.footer.replace(/ · ctrl\+g to edit in [^·]+?(?= · )/u, '')];
  return equal(layout(a), layout(b));
}
function focusMoved(before: NativeQuestionScreen, after: NativeQuestionScreen, index: number) {
  if (!sameRows(before, after) || focusedIndex(after) !== index || !equal(before.tabs, after.tabs)
      || !equal(before.options.map(o => o.checked), after.options.map(o => o.checked))) return false;
  const a = before.input, b = after.input;
  if (a?.kind !== b?.kind) return false;
  if (a?.kind === 'notes' && b) {
    // Notes editing is not silently entered by an arrow. Its resting hint and
    // preview belong to the newly focused choice, not to the previous one.
    return !b.focused && a.value === b.value && (after.options[index].kind === 'chat' || b.number === after.options[index].number);
  }
  return a?.number === b?.number && a?.value === b?.value && equal(before.preview, after.preview);
}
// Only the current question's answered marker may change. In captures without
// tab highlight, the ordinal is unknown; still require all labels and at most
// one changed marker, rather than guessing an ordinal from the question text.
function tabsAfter(before: NativeQuestionScreen, after: NativeQuestionScreen, answered?: boolean) {
  if (!equal(before.tabs.map(t => t.label), after.tabs.map(t => t.label))) return false;
  const diffs = after.tabs.flatMap((t, i) => t.answered !== before.tabs[i].answered ? [i] : []);
  return !diffs.length || (diffs.length === 1 && (before.activeTab === undefined || diffs[0] === before.activeTab)
    && after.tabs[diffs[0]].answered === answered);
}
function nextPage(before: NativeQuestionScreen, after: NativeQuestionScreen, delta: number, answering = false) {
  if (!tabsAfter(before, after, answering ? true : undefined)) return false;
  if (before.activeTab !== undefined && after.activeTab !== undefined) return after.activeTab === before.activeTab + delta;
  return after.kind !== before.kind || before.question !== after.question;
}
function inputChanged(before: NativeQuestionScreen, after: NativeQuestionScreen, text: string) {
  const a = before.input, b = after.input;
  if (!a?.focused || !b?.focused || a.kind !== b.kind || a.number !== b.number || b.value !== text || !sameRows(before, after)
      || focusedIndex(before) !== focusedIndex(after) || before.preview !== after.preview || before.footer !== after.footer) return false;
  if (!before.multiSelect) return equal(before.tabs, after.tabs) && after.options.every((o, i) => {
    const old = before.options[i];
    // An edited Other draft need no longer equal the previously submitted value.
    return old.checked === o.checked || (a.kind === 'other' && o.number === a.number && old.checked === true && !o.checked);
  });
  // Typing in the multi-select Other editor also changes its checkbox.
  return after.options.every((o, i) => o.checked === (o.number === a.number ? !!text : before.options[i].checked))
    && tabsAfter(before, after, after.options.some(o => o.checked));
}

export async function performQuestionAction(driver: QuestionDriver, paneId: string, panePid: number,
  expected: NativeQuestionScreen, action: QuestionAction, assertCurrent: () => void): Promise<void> {
  const deadline = Date.now() + 30_000;
  const check = () => { assertCurrent(); if (Date.now() >= deadline) throw new Error(t('native.questionTimeout')); };
  const inspect = async () => {
    check();
    const frame = await driver.frame();
    check();
    if (frame.paneId !== paneId || frame.panePid !== panePid || frame.nativeStatus === 'shell') throw changed();
    const screen = parseQuestionScreen(frame.viewport, frame.nativeStatus === 'waiting' ? { pendingToolUse: true } : undefined);
    if (screen && (frame.nativeStatus !== undefined && frame.nativeStatus !== 'waiting'
        || frame.nativeWaitingFor !== undefined && frame.nativeWaitingFor !== 'input needed')) throw changed();
    return { frame, screen };
  };
  const initial = (await inspect()).screen;
  if (!initial || !equal(initial, expected)) throw changed();
  let current: NativeQuestionScreen = initial;
  let awaitingEffect = false;
  // 原生菜单外的正文也可能重绘。只有目标明确回执「尚未发送」，且重新采样后
  // 仍是相同的题目、编辑值、焦点和进程，才能再次尝试派发这一个输入。
  const dispatch = async (send: () => Promise<void>) => {
    for (let attempt = 0; ; attempt++) {
      check();
      awaitingEffect = true;
      try { await send(); return; }
      catch (error) {
        if (!(error instanceof NavigationKeyNotSent)) throw error;
        awaitingEffect = false;
        if (attempt === 2) throw error;
        if (!equal((await inspect()).screen, current)) throw changed();
      }
    }
  };
  const key = (value: QuestionKey) => dispatch(() => driver.questionKey(value));
  const paste = (text: string) => dispatch(() => driver.pasteQuestion(text));
  // A stale redraw can repeat the old frame. Never repeat a key while waiting;
  // a different, unrecognized frame aborts instead of waiting for a new menu.
  const settle = async (test: (next: NativeQuestionScreen) => boolean, allowClosed = false) => {
    for (const ms of [0, 35, 65, 120, 200, 320, 500, 700]) {
      if (ms) await delay(ms);
      const { frame, screen } = await inspect();
      if (!screen) {
        if (allowClosed && turnComposer(frame.viewport)) { awaitingEffect = false; return; }
        throw changed();
      }
      if (test(screen)) { current = screen; awaitingEffect = false; return; }
      if (!equal(screen, current)) throw changed();
    }
    throw new Error(t('native.questionNoResult'));
  };
  const focus = async (index: number) => {
    let at = focusedIndex(current);
    if (at < 0 || index < 0) throw changed();
    if (at !== index && current.input?.kind === 'notes' && current.input.focused) throw unsupported();
    while (at !== index) {
      const before = current, delta = Math.sign(index - at);
      await key(delta < 0 ? 'Up' : 'Down');
      await settle(after => focusMoved(before, after, at + delta));
      at += delta;
    }
  };
  try {
    if (!action || typeof action !== 'object') throw unsupported();
    if (action.kind === 'text') {
      if (!isQuestionText(action.text)) throw new Error(t('native.answerInvalid'));
      const field = current.input;
      if (!field?.focused || current.options[focusedIndex(current)]?.number !== field.number) throw changed();
      if (field.value === action.text) return;
      // These literal strings are indistinguishable from native placeholders in
      // a text capture. Do not erase an existing answer for an unverifiable edit.
      if (field.kind === 'other' ? action.text === current.options[focusedIndex(current)].label
        : ['press n to add notes', 'Add notes on this design…'].includes(action.text)) {
        throw new Error(t('native.answerMatchesHint'));
      }
      if (field.value) {
        // End has no visible effect when the cursor was already at the end. It
        // is safe to continue only on a fresh, unchanged focused editor frame.
        await key('End');
        await settle(next => equal(next, current));
        await key('C-u');
        await settle(next => inputChanged(current, next, ''));
      }
      if (action.text) { await paste(action.text); await settle(next => inputChanged(current, next, action.text)); }
      return; // Editing never presses Enter (it submits a single answer, including Notes).
    }
    if (action.kind === 'cancel') {
      const before = current, notes = before.input?.kind === 'notes' && before.input.focused;
      await key('Escape');
      if (notes) {
        await settle(next => sameRows(before, next) && equal(before.tabs, next.tabs) && equal(before.options, next.options)
          && before.preview === next.preview && equal(next.input, { ...before.input, focused: false }));
      } else { await settle(() => false, true); }
      return;
    }
    if (action.kind === 'previous' || action.kind === 'next') {
      const delta = action.kind === 'previous' ? -1 : 1;
      if (current.input?.focused || current.tabs.length < 2 && !current.multiSelect && current.kind !== 'review'
          || current.activeTab !== undefined && (current.activeTab + delta < 0 || current.activeTab + delta > current.tabs.length)) throw unsupported();
      // Moving out of Other can leave horizontal arrows owned by its editor.
      // Return to an ordinary choice, proving every step, before changing pages.
      if (current.input?.kind === 'other' && current.footer.includes('ctrl+g to edit in ')) {
        await focus(current.options.findIndex(o => o.kind === 'choice'));
        if (current.footer.includes('ctrl+g to edit in ')) throw unsupported();
      }
      await key(delta < 0 ? 'Left' : 'Right');
      await settle(next => nextPage(current, next, delta));
      return;
    }
    if (action.kind !== 'activate' && action.kind !== 'focus' && action.kind !== 'amend') throw unsupported();
    if (!Number.isSafeInteger(action.number)) throw unsupported();
    const index = current.options.findIndex(o => o.number === action.number);
    const row = current.options[index];
    if (!row) throw unsupported();
    if (action.kind === 'amend' && (row.kind !== 'choice' || current.input?.kind !== 'notes')) throw unsupported();
    if (action.kind === 'activate' && row.kind === 'other' && !current.input?.value) throw unsupported();
    await focus(index);
    if (action.kind === 'focus') return;
    if (action.kind === 'amend') {
      const before = current;
      if (!before.canAmend || before.input?.kind !== 'notes' || before.input.number !== row.number) throw unsupported();
      if (!before.input.focused) {
        await key('n');
        await settle(next => sameRows(before, next) && equal(before.tabs, next.tabs) && equal(before.options, next.options)
          && before.preview === next.preview && next.input?.focused === true && next.input.kind === 'notes'
          && next.input.number === row.number && next.input.value === before.input?.value);
      }
      return;
    }
    if (current.multiSelect && (row.kind === 'choice' || row.kind === 'other')) {
      const before = current;
      // Space types a literal space in the Other editor. There Enter toggles
      // the checkbox, whereas Space toggles an ordinary multi-choice row.
      await key(row.kind === 'choice' ? 'Space' : 'Enter');
      await settle(next => sameRows(before, next) && focusedIndex(next) === index && equal(before.input, next.input)
        && next.options.every((o, i) => o.checked === (i === index ? !before.options[i].checked : before.options[i].checked))
        && tabsAfter(before, next, next.options.some(o => o.checked)));
      return;
    }
    const closes = current.kind === 'review' || row.kind === 'chat' || current.tabs.length === 1 && !current.multiSelect;
    await key('Enter');
    await settle(next => !closes && (row.kind !== 'submit' || next.kind === 'review')
      && (row.kind !== 'next' || next.kind === 'question') && nextPage(current, next, 1, true), closes);
  } catch (error) {
    if (awaitingEffect && !(error instanceof NavigationKeyNotSent)) throw new QuestionInputUnconfirmed(error);
    throw error;
  }
}
