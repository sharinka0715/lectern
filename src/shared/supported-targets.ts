// Which machines Lectern runs Claude Code on. On Windows there is no tmux, so
// Lectern reaches macOS and Linux machines over SSH only (no local sessions).
// A target is always macOS or Linux: Windows SSH servers (cmd, PowerShell or
// Git Bash as their shell) are refused with a clear message.
import { allTranslations, t } from './i18n';

/** Windows: SSH machines only. */
export const sshOnly = (platform: string) => platform === 'win32';
export const sshOnlyMessage = () => t('shared.sshOnly');

export function unsupportedTargetMessage(host: string, system: string) {
  return t('shared.unsupportedTarget', { host, system, note: t('shared.supportedTargetNote') });
}
/** An error message about a target Lectern does not support (shown as 不支持, not as a connection problem), in either language. */
export const isUnsupportedTarget = (message: string) => allTranslations('shared.supportedTargetNote').some(note => message.includes(note));

/** The target's `uname -s`: Linux and Darwin are supported; Windows shells report MINGW, MSYS or CYGWIN. */
export function targetSystem(uname: string): { supported: true } | { supported: false; system: string } {
  const name = uname.trim().split(/\s+/)[0] ?? '';
  if (name === 'Linux' || name === 'Darwin') return { supported: true };
  if (/^(?:MINGW|MSYS|CYGWIN|UWIN|Windows)/i.test(name)) return { supported: false, system: 'Windows' };
  return { supported: false, system: name || t('shared.unknownSystem') };
}

/** cmd.exe or PowerShell rejecting the POSIX command Lectern sends (English or Chinese Windows). */
export function windowsShellFailure(message: string) {
  return /is not recognized as (?:an internal or external command|the name of a cmdlet)|不是内部或外部命令|识别为 cmdlet/i.test(message);
}
