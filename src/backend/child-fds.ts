import { openSync, readdirSync } from 'node:fs';
import { spawn as nodeSpawn, type SpawnOptions, type StdioOptions } from 'node:child_process';

let devNull: number | undefined;

/**
 * On Linux, Electron's main process holds descriptors without close-on-exec
 * (DevTools and inspector sockets, Mojo channels, resource packs, profile
 * files), and libuv passes every one of them to a child. The children Lectern
 * starts can outlive it: the tmux server behind its sessions and SSH
 * ControlMaster processes keep the copies open after the app quits, so a
 * debugging client never sees its connection close and sockets stay bound.
 * macOS's posix_spawn already closes them. Here every descriptor above stderr
 * that this process has open is replaced by /dev/null in the child.
 *
 * The first three stdio entries are unchanged, so the child's streams (and the
 * TypeScript type of the options) stay the same.
 */
export function withoutInheritedDescriptors<T extends SpawnOptions>(options: T, platform = process.platform): T {
  if (platform !== 'linux') return options;
  let highest = 2;
  try {
    for (const name of readdirSync('/proc/self/fd')) highest = Math.max(highest, Number(name) || 0);
  } catch { return options; }
  if (highest <= 2) return options;
  try { devNull ??= openSync('/dev/null', 'r+'); } catch { return options; }
  return { ...options, stdio: extendedStdio(options.stdio, Math.min(highest, 4095), devNull) };
}

export function extendedStdio(stdio: StdioOptions | undefined, highest: number, filler: number): StdioOptions {
  const base = stdio ?? 'pipe';
  const entries = typeof base === 'string' ? [base, base, base] : [...base];
  while (entries.length < 3) entries.push('pipe');
  for (let fd = entries.length; fd <= highest; fd++) entries.push(filler);
  return entries as StdioOptions;
}

/** child_process.spawn with withoutInheritedDescriptors applied (same overloads and types). */
export const spawn = ((command: string, args: readonly string[], options: SpawnOptions = {}) =>
  nodeSpawn(command, args, withoutInheritedDescriptors(options))) as typeof nodeSpawn;
