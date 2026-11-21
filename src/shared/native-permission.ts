/** Claude Code's tool permission dialog, as read from the native screen. */
export interface NativePermissionOption { number: number; label: string; focused: boolean }
export interface NativePermissionScreen {
  title: string;
  subtitle: string[];
  content: string[];
  question: string;
  options: NativePermissionOption[];
  footer: string;
  /** A quoted note above the question, e.g. why auto mode asks ("Auto mode needs your
   * confirmation for this command. 3 consecutive actions were blocked. …"), one entry per paragraph. */
  notice?: string[];
}
export type PermissionAction = { kind: 'choose'; number: number } | { kind: 'cancel' };
/** The dialog as offered to the window, bound to the frame it was read from. */
export interface PermissionSnapshot extends NativePermissionScreen { token: string; toolUseId: string }
