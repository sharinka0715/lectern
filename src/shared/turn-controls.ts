export interface RewindMenu {
  stage: 'checkpoint' | 'confirm';
  rows: { label: string; detail?: string }[];
  focused: number;
  /** Native overflow counters, in choices (including the final current row). */
  before?: number;
  after?: number;
  /** Present on the native restore confirmation. */
  message?: string;
  /** Fingerprint of the live choices and cursor, independent of relative timestamps. */
  signature: string;
}

export interface TurnControls {
  running: boolean;
  canStop: boolean;
  queued: string[];
  rewind?: RewindMenu;
  /** A native rewind put this prompt back in the input box. */
  restoredDraft?: string;
  draftOccupied?: boolean;
  /** /compact is running: a message can only wait in the queue (no steering, no "send now"). */
  compacting?: boolean;
}

export type TurnAction =
  | { kind: 'stop' | 'openRewind' | 'flushQueue' }
  | { kind: 'rewindTo'; uuid: string }
  | { kind: 'queue' | 'steer'; text: string }
  | { kind: 'checkpoint' | 'previous' | 'next' | 'cancelRewind' | 'restore'; signature: string; index?: number }
  | { kind: 'sendRestored'; text: string; original: string };
