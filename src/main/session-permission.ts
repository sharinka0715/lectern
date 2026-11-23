import { randomUUID } from 'node:crypto';
import { permissionLayout, samePermission } from '../core/permission-screen';
import type { NativePermissionScreen, PermissionSnapshot } from '../shared/native-permission';
import type { NativeStatus } from '../backend/native-presence';
import type { ChatMessage, TranscriptPosition } from '../shared/types';
import type { SessionSettingsHandle } from './session-settings-cache';

export interface WatchedPermission {
  screen: NativePermissionScreen;
  snapshot: PermissionSnapshot;
  handle: SessionSettingsHandle;
  /** The pending call; undefined for a dialog read off the screen before the transcript has it. */
  owner?: string;
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

/**
 * Claude Code shows a tool's permission dialog before its transcript has the call: by a batch
 * interval at least (writes are flushed every 100 ms), longer on a slow disk or a busy machine.
 * The dialog is then a card all the same, read off the screen alone, when Claude Code's own
 * session record says it waits for exactly that: a permission prompt for a tool's dialog, a
 * dialog for the keyed auto mode dialogs ("dialog open" in 2.1.300–2.1.330). A dialog seen with
 * its call (`owned`, its layout) is never offered again without it: still on screen after the
 * call got its result, it is a late frame, not a new question. Clicks are checked against the
 * live screen as for any card.
 */
export function earlyPermission(screen: NativePermissionScreen, status: NativeStatus | undefined, waitingFor: string | undefined, owned: string | undefined): boolean {
  if (status !== 'waiting' || owned === permissionLayout(screen)) return false;
  return waitingFor === 'permission prompt' || (!!screen.kind && waitingFor === 'dialog open');
}

/** Keep the token while the same dialog is shown for the same call; any change (focus included)
 * issues a new one. Records appended meanwhile without changing the pending call (Claude Code's
 * notices, e.g. 2.1.321+ writing "Auto mode can't check actions …" after the follow-up dialog is
 * up) move the card to the newer transcript position: answering checks that position, and a
 * stale one would refuse the first click although nothing that matters changed. A card read off
 * the screen alone (no `owner`) takes the call once the transcript has it, token kept: the same
 * card, now bound to the newer position. */
export function observePermission(previous: WatchedPermission | undefined, screen: NativePermissionScreen, handle: SessionSettingsHandle,
  owner: string | undefined, position?: TranscriptPosition): WatchedPermission {
  if (previous?.handle === handle && (previous.owner === owner || previous.owner === undefined) && (!previous.consumed || previous.unconfirmed)
      && JSON.stringify(previous.screen) === JSON.stringify(screen)) {
    if (previous.owner !== owner) {
      previous.owner = owner;
      previous.snapshot = { ...previous.snapshot, toolUseId: owner };
    }
    previous.position = position;
    return previous;
  }
  const sameCard = previous?.handle === handle && (owner !== undefined && previous.owner === owner || previous.owner === undefined && samePermission(previous.screen, screen));
  return { screen, handle, position, owner, consumed: false,
    snapshot: { ...screen, toolUseId: owner, cardId: sameCard ? previous.snapshot.cardId : owner ?? randomUUID(), token: randomUUID() } };
}
