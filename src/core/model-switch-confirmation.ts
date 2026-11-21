import { inTranscriptExample } from './dialog-boundary';

/** Parsed evidence only. The caller must separately match a user-authorized target. */
export interface ModelSwitchConfirmation {
  kind: 'model' | 'effort';
  targetLabel: string;
  focused: 'confirm' | 'cancel';
  confirmOrdinal: number;
  cancelOrdinal: number;
  confirmKey: 'Enter';
  cancelKey: 'Escape';
  /** Older native dialogs omit the footer; their entire bounded layout is required. */
  footerObserved: boolean;
  signature: string;
}

const turnDone = /^[✶✻✽✢✳✺·*] [A-Za-z][A-Za-z -]* for \d+(?:\.\d+)?(?:ms|s|m|h)(?: \d+(?:\.\d+)?(?:ms|s|m))*(?: · done \d{1,2}:\d{2}(?:\s?[AaPp][Mm])?)?(?: · [^·]+)*$/u;

/** Shared by the viewport classifier and the settings parser without a dependency cycle. */
export function parseCacheConfirmationLines(rawLines: readonly string[]): ModelSwitchConfirmation | undefined {
  const lines = rawLines.map(line => line.replace(/\u00a0/g, ' ').trim());
  while (lines.length && !lines.at(-1)) lines.pop();
  let start = -1;
  for (let index = lines.length - 1; index >= 0; index--) if (lines[index] === 'Switch model?' || lines[index] === 'Change effort level?') { start = index; break; }
  if (start < 0) return;
  const before = lines.slice(0, start).filter(Boolean);
  // A finished turn's status line ("✻ Churned for 0s · done 5:16 PM") is TUI chrome at
  // column 0 (reply text is indented under its bullet): the reply above it is over. An
  // inline `/model <alias>` opens this dialog right below it (2.1.300), with no
  // "❯ /model" echo to end the reply.
  const raw = rawLines.map(line => line.replace(/\u00a0/g, ' ').trimEnd());
  let done = -1;
  for (let index = start - 1; index >= 0; index--) if (turnDone.test(raw[index])) { done = index; break; }
  // Claude Code 2.1.300 draws the effort indicator into the dialog's top border
  // ("▔▔▔…▔ ◐ medium · /effort ▔"): a short label near the right end is still the border.
  if (before.length && !/^[─━═▔╌┄-]{5,}(?: [^─━═▔╌┄\s][^─━═▔╌┄]{0,60} [─━═▔╌┄-]{1,8})?$/u.test(before.at(-1)!)) return;
  if (inTranscriptExample(done < 0 ? before : lines.slice(done + 1, start).filter(Boolean))) return;
  const kind = lines[start] === 'Switch model?' ? 'model' as const : 'effort' as const;
  const section = lines.slice(start + 1).filter(Boolean);
  const footerObserved = /^Enter to confirm\s*[·•]\s*Esc to cancel$/.test(section.at(-1) ?? '');
  // Claude 2.1.319 ends this exact dialog immediately after its two choices.
  // Without printed key hints, also require the native separator above it.
  if (!footerObserved && (!before.length || kind === 'effort')) return;
  const firstOption = section.findIndex(line => /^(?:❯\s*)?\d+\.\s/.test(line));
  if (firstOption < 0) return;
  const optionLines = section.slice(firstOption, footerObserved ? -1 : undefined);
  if (optionLines.length !== 2) return;
  const yes = /^(❯\s*)?(\d+)\.\s+Yes, switch to (.+)$/.exec(optionLines[0]);
  const no = /^(❯\s*)?(\d+)\.\s+No, go back$/.exec(optionLines[1]);
  if (!yes || !no || !!yes[1] === !!no[1]) return;
  const confirmOrdinal = Number(yes[2]), cancelOrdinal = Number(no[2]);
  if (!Number.isSafeInteger(confirmOrdinal) || !Number.isSafeInteger(cancelOrdinal)
    || confirmOrdinal < 1 || cancelOrdinal <= confirmOrdinal) return;
  const targetLabel = yes[3].trim();
  if (!targetLabel) return;
  const explanation = section.slice(0, firstOption).join(' ');
  // 2.1.300 ends the sentence with "re-read on your next message.".
  const expected = `Your next response will be slower and use more tokens This conversation is cached for the current ${kind === 'model' ? 'model' : 'effort level'}. Switching to ${targetLabel} means the full history gets re-read`;
  if (explanation !== `${expected}.` && explanation !== `${expected} on your next message.`) return;
  const value = { kind, targetLabel, focused: yes[1] ? 'confirm' as const : 'cancel' as const,
    confirmOrdinal, cancelOrdinal, confirmKey: 'Enter' as const, cancelKey: 'Escape' as const, footerObserved };
  return { ...value, signature: JSON.stringify(value) };
}
