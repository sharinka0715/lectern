import type { NativeQuestionScreen } from './native-question';

export type QuestionSnapshot = NativeQuestionScreen & {
  token: string;
  /** The same card while one question set is answered (each new frame issues a new token) and when
   * the transcript catches up with a dialog first read off the screen alone (main/session-question.ts). */
  interactionId: string;
  /** The pending AskUserQuestion call it answers; undefined while the dialog is on screen before the
   * session's transcript has that call. */
  toolUseId?: string;
};

/** Literal, single-line native input. Empty text explicitly clears the current field. */
export const isQuestionText = (v: unknown): v is string => typeof v === 'string' && v.trim() === v
  && v.length <= 4096 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(v);

/** Use the parser's stable row number, never an array index or a hotkey. */
export type QuestionAction =
  | { kind: 'activate' | 'focus' | 'amend'; number: number }
  | { kind: 'previous' | 'next' | 'cancel' }
  | { kind: 'text'; text: string };
