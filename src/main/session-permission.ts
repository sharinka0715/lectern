import { randomUUID } from 'node:crypto';
import type { NativePermissionScreen, PermissionSnapshot } from '../shared/native-permission';
import type { ChatMessage, TranscriptPosition } from '../shared/types';
import type { SessionSettingsHandle } from './session-settings-cache';

export interface WatchedPermission {
  screen: NativePermissionScreen;
  snapshot: PermissionSnapshot;
  handle: SessionSettingsHandle;
  owner: string;
  position?: TranscriptPosition;
  consumed: boolean;
  unconfirmed?: boolean;
}

/** The tool call awaiting permission: the current turn's last call without a result.
 * A menu-like text with no pending call (pasted, or in an old turn) is never a decision. */
export function pendingToolId(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'user') break;
    const pending = message.tools.filter(tool => tool.name !== 'AskUserQuestion' && tool.result === undefined && !tool.isError);
    if (pending.length) return pending.at(-1)!.id;
  }
}

/** Keep the token while the same dialog is shown for the same call; any change (focus included)
 * issues a new one. Records appended meanwhile without changing the pending call (Claude Code's
 * notices, e.g. 2.1.321+ writing "Auto mode can't check actions …" after the follow-up dialog is
 * up) move the card to the newer transcript position: answering checks that position, and a
 * stale one would refuse the first click although nothing that matters changed. */
export function observePermission(previous: WatchedPermission | undefined, screen: NativePermissionScreen, handle: SessionSettingsHandle,
  owner: string, position?: TranscriptPosition): WatchedPermission {
  if (previous?.handle === handle && previous.owner === owner && (!previous.consumed || previous.unconfirmed)
      && JSON.stringify(previous.screen) === JSON.stringify(screen)) {
    previous.position = position;
    return previous;
  }
  return { screen, handle, position, owner, consumed: false, snapshot: { ...screen, toolUseId: owner, token: randomUUID() } };
}
