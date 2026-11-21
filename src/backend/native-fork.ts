import { stripTerminalEscapes } from '../core/screen';
import { isIdleEmptyComposer } from '../core/settings-screen';
import { focusedTurnCommandDescription } from '../core/turn-controls';
import type { TurnDriver } from './native-turn-controls';
import { keysNotSent } from './native-settings';
import { SESSION_UUID } from './native-presence';
import { t } from '../shared/i18n';

const branchDescription = /^(?:Create a branch of the current conversation at this point|Create a fork of the current conversation at this point|Fork the current conversation at this point)$/i;
const backgroundDescription = /^(?:Copy this conversation into a new background session and keep working here|Start a background agent with the full conversation)$/i;

/** Only the focused completion in the block immediately adjacent to this boxed
 * draft counts. Text printed by an assistant earlier in the viewport does not. */
export function forkCapability(view: string, command: '/branch' | '/fork'): 'branch' | 'background' | undefined {
  const description = focusedTurnCommandDescription(view, command);
  if (!description) return;
  return branchDescription.test(description) ? 'branch' : backgroundDescription.test(description) ? 'background' : undefined;
}

export async function submitNativeFork(driver: TurnDriver, pane: string, pid: number) {
  const frame = async () => {
    const f = await driver.frame();
    if (f.paneId !== pane || f.panePid !== pid || f.nativeStatus !== 'idle') throw new Error(t('backend.forkIdentityChanged'));
    return f.viewport;
  };
  const wait = async <T>(check: (view: string) => T | undefined) => {
    for (const ms of [40, 80, 150, 270, 450]) {
      await new Promise(resolve => setTimeout(resolve, ms));
      const result = check(await frame());
      if (result !== undefined) return result;
    }
    throw new Error(t('backend.forkCommandUnclear'));
  };
  // Every key is bound to the whole frame it was chosen from. Claude Code can
  // append to the transcript at any moment: 2.1.329 adds its one-time auto mode
  // description about 0.8 s after a session first enters auto mode, which on a
  // slow machine lands in the middle of these steps. The guard then refuses
  // before sending anything. Only that explicit refusal, on a fresh frame that
  // still satisfies the same precondition, repeats the step (at most 3 times).
  // Otherwise the refusal stands: a refused Enter must still clear the journal.
  const step = async (send: () => Promise<void>, still: (view: string) => boolean) => {
    for (let attempt = 1; ; attempt++) {
      try { return await send(); }
      catch (error) {
        if (attempt >= 3 || !keysNotSent(error)) throw error;
        try { await wait(view => still(view) || undefined); } catch { throw error; }
      }
    }
  };
  if (!isIdleEmptyComposer(await frame())) throw new Error(t('backend.forkNeedsIdle'));
  await step(() => driver.pasteForTurn('/fork', false), isIdleEmptyComposer);
  let command: '/fork' | '/branch' = '/fork';
  const capability = await wait(view => forkCapability(view, '/fork'));
  if (capability === 'background') {
    // Do not submit /fork in versions where it starts a background session.
    await step(() => driver.keyForTurn('erase'), view => forkCapability(view, '/fork') === 'background');
    await wait(view => isIdleEmptyComposer(view) ? true : undefined);
    await step(() => driver.pasteForTurn('/branch', false), isIdleEmptyComposer);
    command = '/branch';
    if (await wait(view => forkCapability(view, '/branch')) !== 'branch') throw new Error(t('backend.forkCommandMissing'));
  }
  // Guard the last frame but don't resolve the old UUID after Enter.
  await step(() => driver.keyForTurn('switchSession'), view => forkCapability(view, command) === 'branch');
}

export function forkReceipt(view: string, original: string, fork: string): boolean {
  const lines = stripTerminalEscapes(view).replace(/ /g, ' ').split('\n');
  let at = lines.length - 1;
  while (at >= 0 && !/^❯\s+\/(?:fork|branch)\s*$/u.test(lines[at])) at--;
  if (at < 0) return false;
  const receipt = lines.slice(at + 1, at + 6).map(s => s.trim()).join(' ').replace(/\s+/g, ' ');
  return receipt.startsWith(`⎿ Branched session. You're now in the new one (${fork}). Back to the original: /resume ${original}`) ||
    receipt.startsWith(`⎿ Forked session. You're now in the new one (${fork}). Back to the original: /resume ${original}`);
}

/** Native /branch copies the old message UUID into both uuid and forkedFrom.messageUuid. */
export function recordForkParent(row: any, fork: string): string | undefined {
  const source = row?.forkedFrom;
  if (row?.sessionId === fork && !row.isSidechain && (row.type === 'user' || row.type === 'assistant') &&
      typeof row.uuid === 'string' && source?.messageUuid === row.uuid && typeof source.sessionId === 'string' &&
      source.sessionId !== fork && SESSION_UUID.test(source.sessionId)) return source.sessionId;
}

export function hasForkLineage(bytes: Buffer, original: string, fork: string): boolean {
  const lines = bytes.toString('utf8').split('\n');
  for (const line of lines.slice(0, -1)) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (recordForkParent(row, fork) === original) return true;
  }
  return false;
}
