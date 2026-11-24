import { randomUUID } from 'node:crypto';
import type { NativeStatus } from '../backend/native-presence';
import type { NativeQuestionScreen } from '../shared/native-question';
import type { AskedQuestion } from '../core/question-hook';
import type { QuestionSnapshot } from '../shared/question-action';
import type { ChatMessage, TranscriptPosition } from '../shared/types';
import type { SessionSettingsHandle } from './session-settings-cache';

export interface WatchedQuestion {
  screen: NativeQuestionScreen;
  snapshot: QuestionSnapshot;
  handle: SessionSettingsHandle;
  /** The pending call; undefined for a dialog read off the screen before the transcript has it. */
  owner?: string;
  position?: TranscriptPosition;
  consumed: boolean;
  unconfirmed?: boolean;
  /** The call's input when the card was read with the recording hook (core/question-hook.ts). */
  asked?: AskedQuestion[];
}

/** 只在当前回合中关联尚未收到结果的调用。旧回合、工具输出和用户粘贴的菜单均不能提供问答身份。 */
export function pendingQuestionId(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    // A send the transcript has not confirmed is not a new turn yet (it can sit
    // after the question's turn); its preview has no tools.
    if (message.role === 'user' && message.source === 'pending') continue;
    if (message.role === 'user') break;
    const pending = message.tools.filter(tool => tool.name === 'AskUserQuestion' && tool.result === undefined && !tool.isError);
    if (pending.length) return pending.length === 1 ? pending[0].id : undefined;
  }
}

/** The current turn's newest AskUserQuestion call that has its result (an answer, or the
 * error of a cancelled or discussed question). */
export function answeredQuestionId(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'user' && message.source === 'pending') continue;
    if (message.role === 'user') break;
    const answered = message.tools.filter(tool => tool.name === 'AskUserQuestion' && (tool.result !== undefined || tool.isError));
    if (answered.length) return answered.at(-1)!.id;
  }
}

/** The question set a dialog asks: its tab labels (the headers), the same on every page, focus,
 * edit and on the review. */
export const questionSet = (screen: NativeQuestionScreen) => JSON.stringify(screen.tabs.map(tab => tab.label));

/** A question dialog last seen with its call, or answered from a card, while it stays on screen. */
export interface OwnedQuestion { set: string; at: number }
/** A frame from before the answer is at most a read or two late; the same questions still asked
 * after this long are asked again (the model may repeat a question), not a late frame. */
export const LATE_QUESTION_MS = 2000;

/** Track the dialog that had its call (`owner`), and the one an earlier card showed when the
 * transcript has since got a newly answered question (`answered`; Claude Code 2.1.300–2.1.330 write
 * a deferred call together with its result): kept while the same question set is on screen. */
export function ownQuestion(owned: OwnedQuestion | undefined, screen: NativeQuestionScreen | undefined, owner: string | undefined,
  answered: NativeQuestionScreen | undefined, now: number): OwnedQuestion | undefined {
  const set = screen && questionSet(screen);
  if (owner && set) return { set, at: now };
  if (answered) owned = { set: questionSet(answered), at: now };
  return owned && owned.set === set ? owned : undefined;
}

/**
 * Claude Code shows a question before its transcript has the call: by a batch interval at least
 * (about 170 ms in 2.1.300 and 2.1.310), and when the call started before the reply's stream ended
 * (a gateway's late end of stream is enough) 2.1.300–2.1.330 write the reply and the call only once
 * the question is answered: the whole time it is on screen, the transcript has no call for it.
 * The dialog is then a card all the same, read off the screen alone, while Claude Code's own session
 * record says it waits for an answer: status "waiting" and waitingFor exactly "input needed", as for
 * any question (2.1.300–2.1.330); a permission prompt, "dialog open" or no waitingFor is another
 * dialog. That record also stands in for the pending call that otherwise lets a dialog under reply
 * text be read at all (parseQuestionScreen's evidence): Claude Code reports it only while a dialog
 * of its own asks the user, and that dialog is then what takes the bottom of the screen in place of
 * the input box, so a complete question dialog there is Claude Code's, not a menu in the reply.
 * Without it (busy, idle, another dialog, no record) a question-like screen with no pending call is
 * no card, nor is one in a code block. A question seen with its call, or answered from a card, is
 * not offered again without it while the same questions stay on screen (ownQuestion): a late frame.
 * Clicks are checked against the live screen and the transcript as read, as for any card.
 */
export function earlyQuestion(screen: NativeQuestionScreen, status: NativeStatus | undefined, waitingFor: string | undefined,
  owned: OwnedQuestion | undefined, now: number): boolean {
  if (status !== 'waiting' || waitingFor !== 'input needed') return false;
  return !owned || owned.set !== questionSet(screen) || now - owned.at >= LATE_QUESTION_MS;
}

/** Keep the token while the same question screen (question, page, focus, edits, review) is shown
 * for the same call; any change there, or another call, issues a new one. Records appended
 * meanwhile without changing the pending call (Claude Code's notices) move the card to the newer
 * transcript position, like the permission card: answering checks that position, so a click on
 * the unchanged screen is not refused, and anything else the guard still refuses. A card read off
 * the screen alone (no `owner`) takes the call once the transcript has it, token kept: the same
 * card, now bound to the newer position. */
export function observeQuestion(previous: WatchedQuestion | undefined, screen: NativeQuestionScreen, handle: SessionSettingsHandle,
  owner: string | undefined, position?: TranscriptPosition): WatchedQuestion {
  const same = previous?.handle === handle && (owner !== undefined && previous.owner === owner
    || previous.owner === undefined && questionSet(previous.screen) === questionSet(screen));
  if (same && (!previous.consumed || previous.unconfirmed) && JSON.stringify(previous.screen) === JSON.stringify(screen)) {
    if (previous.owner !== owner) {
      previous.owner = owner;
      previous.snapshot = { ...previous.snapshot, toolUseId: owner };
    }
    previous.position = position;
    return previous;
  }
  return { screen, handle, position, owner, consumed: false, snapshot: { ...screen, toolUseId: owner,
    interactionId: same ? previous.snapshot.interactionId : randomUUID(), token: randomUUID() } };
}
