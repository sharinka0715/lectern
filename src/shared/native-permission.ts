/** Claude Code's tool permission dialog, as read from the native screen. */
export interface NativePermissionOption {
  number: number;
  label: string;
  focused: boolean;
  /** A choice made with a key rather than by number (the keyed auto mode dialogs). */
  key?: 'Enter' | 'BTab';
  /** Claude Code does not take this choice now (e.g. "needs a taller window"). */
  unavailable?: boolean;
}
export interface NativePermissionScreen {
  /** Undefined for a tool's own permission dialog. Keyed dialogs that hold a tool call too
   * (core/auto-mode-screen.ts): 'auto-mode-unavailable' for "Auto mode can't check actions in
   * this session", 'auto-mode-billing' for the classifier billing notice ("We're changing auto
   * mode to no longer charge for classifier requests …"). 'native-dialog' for any other native
   * dialog read by its common layout (core/native-dialog-screen.ts): its text, its choices if
   * it lists any, else Enter as option 1 when its key hints offer it. */
  kind?: 'auto-mode-unavailable' | 'auto-mode-billing' | 'native-dialog';
  title: string;
  subtitle: string[];
  content: string[];
  question: string;
  options: NativePermissionOption[];
  footer: string;
  /** A quoted note above the question, e.g. why auto mode asks ("Auto mode needs your
   * confirmation for this command. 3 consecutive actions were blocked. …"), one entry per paragraph. */
  notice?: string[];
  /** 'native-dialog': what Esc does there ("cancel"), when its key hints offer Esc. */
  escape?: string;
}
export type PermissionAction = { kind: 'choose'; number: number } | { kind: 'cancel' };
/** The dialog as offered to the window, bound to the frame it was read from. */
export interface PermissionSnapshot extends NativePermissionScreen {
  token: string;
  /** The pending tool call it answers; undefined while the dialog is on screen before the
   * session's transcript has that call (main/session-permission.ts). */
  toolUseId?: string;
  /** The same while dialogs of one call follow each other (focus moves issue new tokens) and when
   * the transcript catches up with a dialog first read off the screen alone: one card, not a new one. */
  cardId: string;
}
