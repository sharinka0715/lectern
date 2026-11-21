/** An observation of the current native AskUserQuestion dialog, not its tool input. */
export interface NativeQuestionOption {
  /** Stable 1-based row ID. Unnumbered actions take the next unused ID, NOT a numeric hotkey. */
  number: number;
  label: string;
  kind: 'choice' | 'other' | 'chat' | 'submit' | 'next' | 'cancel';
  focused: boolean;
  checked?: boolean;
  description?: string;
}
export interface NativeQuestionScreen {
  kind: 'question' | 'review';
  /** Question tabs only. The Submit/Review page, if shown, is at tabs.length. */
  tabs: {label: string; answered: boolean}[];
  /** Zero-based where provable without ANSI colors. */
  activeTab?: number;
  question?: string;
  multiSelect?: boolean;
  /** In native navigation order, not sorted by number. */
  options: NativeQuestionOption[];
  input?: {kind: 'other' | 'notes'; number: number; value: string; focused: boolean};
  /** True only for the preview chooser's explicit `n to add notes` affordance. */
  canAmend?: boolean;
  preview?: string;
  review?: {question: string; answer: string}[];
  /** Empty on the review page (2.1.326 has no footer there). */
  footer: string;
}
