import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isIdleEmptyComposer } from '../core/settings-screen';
import { parseDirectoryTrust } from '../core/trust-screen';
import type { Workspace } from '../shared/types';
import { decodePresence, presenceReadScript, SESSION_UUID } from './native-presence';
import { quoteShell as q, type Transport } from './transport';
import { t } from '../shared/i18n';

/** A normal terminal need not be attached to Lectern's tmux server. Only probe
 * numeric registrations of live PIDs in this config, including non-tmux CLIs. */
async function ensureInactive(transport: Transport, workspace: Workspace, config: string, sessionId: string) {
  const script = `set -eu
lectern_foreground=$(ps -e -o pid=)
${presenceReadScript(config)}`;
  const { stdout } = await transport.run(workspace, script, { tag: 'rename.native_owners' });
  const { unsafe, frames } = decodePresence(stdout.toString().split('\0'));
  if (unsafe) throw new Error(t('backend.renameRegistryUnsafe'));
  for (const frame of frames.values()) {
    if (!frame.start || !frame.domain) continue;
    let record;
    try { record = JSON.parse(frame.bytes.toString()); } catch { continue; }
    if (record?.pid === frame.pid && record.procStart === frame.start
      && (record.pidDomain === undefined || record.pidDomain === frame.domain)
      && typeof record.sessionId === 'string' && record.sessionId.toLowerCase() === sessionId.toLowerCase()) {
      throw new Error(t('backend.renameInUse'));
    }
  }
}

export async function renameInactiveSession(
  transport: Transport, workspace: Workspace, sessionId: string, title: string,
  location: { cwd: string; claudeDir: string }, launchCommand: string, verify: () => Promise<boolean>,
): Promise<void> {
  if (!SESSION_UUID.test(sessionId) || !title.trim()) throw new Error(t('backend.renameInvalid'));
  await ensureInactive(transport, workspace, location.claudeDir, sessionId);

  // No operation targets the user's tmux server. The target-side shell also
  // expires the private server when the client stops polling or loses SSH.
  const directory = `/tmp/lectern-rename-${randomUUID()}`;
  const socket = q(`${directory}/socket`);
  const tmux = `tmux -S ${socket}`;
  const close = `${tmux} kill-server 2>/dev/null || true`;
  const start = `set -eu
umask 077
mkdir ${q(directory)}
trap ${q(close + '; rm -f ' + socket + '; rmdir ' + q(directory))} EXIT
trap 'exit 1' HUP INT TERM
${tmux} -f /dev/null new-session -d -s rename -x 140 -y 36 -c ${q(location.cwd)} sh -c ${q(launchCommand)}
lectern_n=0
while [ "$lectern_n" -lt 90 ]; do
  lectern_n=$((lectern_n + 1))
  ${tmux} has-session -t rename 2>/dev/null || exit 0
  sleep 0.4
done
echo ${q(t('backend.renameTimeout'))} >&2
exit 1`;
  let ended = false, failure: unknown;
  const supervisor = transport.run(workspace, start, { tag: 'rename.temporary_terminal', timeoutMs: 50_000 })
    .catch(error => { failure = error; }).finally(() => { ended = true; });
  try {
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (!ended && Date.now() < deadline) {
      const { stdout } = await transport.run(workspace,
        `${tmux} capture-pane -p -J -t rename: 2>/dev/null || true`, { tag: 'rename.observe', maxBytes: 64 * 1024 });
      const screen = stdout.toString();
      if (parseDirectoryTrust(screen)) throw new Error(t('backend.renameNeedsTrust'));
      const idle = isIdleEmptyComposer(screen);
      if (idle && ready && await verify()) return;
      ready = idle;
      await delay(160);
    }
    if (failure) throw failure;
    throw new Error(t('backend.renameUnverified'));
  } finally {
    try { await transport.run(workspace, close, { tag: 'rename.close_terminal', timeoutMs: 8_000 }); }
    finally { await supervisor; }
  }
}
