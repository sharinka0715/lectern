import { randomUUID } from 'node:crypto';
import type { NativeQuestionScreen } from '../shared/native-question';
import type { QuestionSnapshot } from '../shared/question-action';
import type { ChatMessage, TranscriptPosition } from '../shared/types';
import type { SessionSettingsHandle } from './session-settings-cache';

export interface WatchedQuestion {
  screen: NativeQuestionScreen;
  snapshot: QuestionSnapshot;
  handle: SessionSettingsHandle;
  owner: string;
  position?: TranscriptPosition;
  consumed: boolean;
  unconfirmed?: boolean;
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

/** Keep the token while the same question screen (question, page, focus, edits, review) is shown
 * for the same call; any change there, or another call, issues a new one. Records appended
 * meanwhile without changing the pending call (Claude Code's notices) move the card to the newer
 * transcript position, like the permission card: answering checks that position, so a click on
 * the unchanged screen is not refused, and anything else the guard still refuses. */
export function observeQuestion(previous: WatchedQuestion | undefined, screen: NativeQuestionScreen, handle: SessionSettingsHandle,
  owner: string, position?: TranscriptPosition): WatchedQuestion {
  const same = previous?.handle === handle && previous.owner === owner;
  if (same && (!previous.consumed || previous.unconfirmed) && JSON.stringify(previous.screen) === JSON.stringify(screen)) {
    previous.position = position;
    return previous;
  }
  return { screen, handle, position, owner, consumed: false, snapshot: { ...screen,
    interactionId: same ? previous.snapshot.interactionId : randomUUID(), token: randomUUID() } };
}
