/** Claude Code's tool permission dialog, as read from the native screen. */
export interface NativePermissionOption {
  number: number;
  label: string;
  focused: boolean;
  /** A choice made with a key rather than by number (the auto-mode-unavailable dialog). */
  key?: 'Enter' | 'BTab';
  /** Claude Code does not take this choice now (e.g. "needs a taller window"). */
  unavailable?: boolean;
}
export interface NativePermissionScreen {
  /** Undefined for a tool's own permission dialog; 'auto-mode-unavailable' for "Auto mode
   * can't check actions in this session" (core/auto-mode-screen.ts), which holds a tool call too. */
  kind?: 'auto-mode-unavailable';
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
