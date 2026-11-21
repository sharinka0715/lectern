import type { Workspace } from '../shared/types';
import { maxAttachmentBytes } from '../shared/attachments';
import { quoteShell as q, type Transport } from './transport';
import { t } from '../shared/i18n';

/**
 * A file name safe to create on any target: the last path part, without
 * control characters, quotes or separators, at most 120 characters.
 */
export function attachmentName(name: string): string {
  const base = String(name).split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\p{Cc}\p{Cf}"'`$\\]/gu, '').replace(/\s+/gu, ' ').trim();
  if (!clean || clean === '.' || clean === '..') return 'attachment';
  const chars = [...clean];
  if (chars.length <= 120) return clean;
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : '';
  return chars.slice(0, 120 - [...ext].length).join('').trimEnd() + ext;
}

/**
 * Writes stdin to a new private directory under the target's temporary
 * directory and prints the file's path. The per-user base directory must be a
 * real directory the user owns; directories older than 7 days are removed.
 */
export function uploadScript(name: string): string {
  return `umask 077
lectern_base="\${TMPDIR:-/tmp}"
lectern_base="\${lectern_base%/}/lectern-attachments-$(id -u)"
mkdir -p "$lectern_base" || exit 1
if [ -L "$lectern_base" ] || [ ! -d "$lectern_base" ] || [ ! -O "$lectern_base" ]; then
 echo "Attachment directory is not private: $lectern_base" >&2; exit 1
fi
chmod 700 "$lectern_base" || exit 1
find "$lectern_base" -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null
lectern_dir=$(mktemp -d "$lectern_base/XXXXXXXX") || exit 1
lectern_file="$lectern_dir"/${q(attachmentName(name))}
cat > "$lectern_file" || exit 1
printf '%s' "$lectern_file"
`;
}

/** Copies a file into the target's temporary directory; returns its path there. */
export async function uploadAttachment(transport: Transport, workspace: Workspace, name: string, data: Buffer): Promise<string> {
  if (!data.length) throw new Error(t('backend.reasonEmpty'));
  if (data.length > maxAttachmentBytes) throw new Error(t('main.fileTooLarge'));
  // Its own connection (a signal skips the shared command channels), allowing
  // at least 128 KiB/s on slow jump hosts.
  const { stdout } = await transport.run(workspace, uploadScript(name), {
    input: data, signal: new AbortController().signal, tag: 'attachment.upload',
    timeoutMs: 60_000 + Math.ceil(data.length / (128 * 1024)) * 1000,
  });
  const path = stdout.toString('utf8');
  if (!path.startsWith('/') || /[\n\r]/.test(path)) throw new Error(t('backend.uploadNoPath'));
  return path;
}
