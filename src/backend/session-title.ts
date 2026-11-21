import type { Workspace } from '../shared/types';
import { quoteShell as q, type Transport } from './transport';

/** A rename is acknowledged by Claude's own persisted metadata. This short
 * read can also observe a title before a new session gets its first user turn. */
export async function readRecentCustomTitle(transport: Transport, workspace: Workspace, sessionId: string, paths: string[]) {
  const script = `for f in ${paths.map(q).join(' ')}; do
  d=\${f%/*}; [ -d "$d" ] && [ ! -L "$d" ] && [ ! -L "\${d%/*}" ] || continue
  s=\${f%.jsonl}/custom-title.json
  if [ -f "$f" ] && [ ! -L "$f" ]; then tail -c 16384 "$f" | base64; fi
  printf '\\0'
  if [ -f "$s" ] && [ ! -L "$s" ] && [ ! -L "\${s%/*}" ]; then head -c 16385 "$s" | base64; fi
  printf '\\0'
done`;
  const { stdout } = await transport.run(workspace, script, { tag: 'history.rename_evidence', maxBytes: 65536 * paths.length });
  const frames = stdout.toString('ascii').split('\0');
  for (let i = 0; i + 1 < frames.length; i += 2) {
    for (const line of Buffer.from(frames[i], 'base64').toString('utf8').split('\n').reverse()) {
      try {
        const row = JSON.parse(line);
        if (row.type === 'custom-title' && row.sessionId === sessionId && typeof row.customTitle === 'string') return row.customTitle;
      } catch { /* The byte window may start in the middle of a record. */ }
    }
    try {
      const sidecar = JSON.parse(Buffer.from(frames[i + 1], 'base64').toString('utf8'));
      if (typeof sidecar.customTitle === 'string') return sidecar.customTitle;
    } catch { /* A sidecar is optional on older Claude Code versions. */ }
  }
  return undefined;
}
