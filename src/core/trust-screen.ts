import { stripTerminalEscapes } from './screen';
import { inTranscriptExample } from './dialog-boundary';

/** Observation only: consuming this value never authorizes trusting a directory. */
export interface DirectoryTrustDialog {
  cwd: string;
  /** Never infer persistence or home-directory behavior from the path alone. */
  scope: 'session' | 'unspecified';
  acceptLabel: string;
  cancelLabel: string;
  focused: 'trust' | 'exit' | 'continue';
  cancelDecision: 'exit' | 'continue';
  warnings?: string[];
  /** Claude 2.1.327+: "Trusting this folder loads …", the files trust will load. */
  disclosure?: string;
  /** Zero-based positions are available even in Claude's unnumbered chooser. */
  acceptIndex: number;
  cancelIndex: number;
  acceptOrdinal?: number;
  cancelOrdinal?: number;
  confirmKey: 'Enter';
  cancelKey: 'Escape';
  signature: string;
}

const safetyText = "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first. Claude Code'll be able to read, edit, and execute files here.";
const homeSafetyText = safetyText.replace('files here.', 'files here. This is your home folder, so Yes lasts for this session only.');
const rule = /^[─━═▔╌┄-]{5,}$/u;

/** Recognize the complete native directory-trust dialog, never a generic permission menu. */
export function parseDirectoryTrust(viewport: string): DirectoryTrustDialog | undefined {
  const lines = stripTerminalEscapes(viewport).split('\n').map(line => line.trim());
  while (lines.length && !lines.at(-1)) lines.pop();
  let start = -1;
  for (let index = lines.length - 1; index >= 0; index--) if (lines[index] === 'Accessing workspace:') { start = index; break; }
  if (start < 0) return;
  const before = lines.slice(0, start).filter(Boolean);
  if (before.length && !rule.test(before.at(-1)!)) return;
  if (inTranscriptExample(before)) return;
  const section = lines.slice(start + 1).filter(Boolean);
  if (!/^Enter to confirm\s*[·•]\s*Esc to cancel$/.test(section.at(-1) ?? '')) return;
  const cwd = section[0];
  // Never reconstruct a clipped/multiline/relative path. The backend compares
  // this exact observation with the session's validated directory aliases.
  if (!cwd || !/^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\)/.test(cwd)) return;
  const optionPattern = /^(❯\s*)?(?:(\d+)\.\s*)?(Yes, I trust this (?:folder|directory)|No, (?:exit|continue without these permissions))$/;
  const firstOption = section.findIndex(line => optionPattern.test(line));
  if (firstOption < 2) return;
  const body = section.slice(1, firstOption);
  if (body.pop() !== 'Security guide') return;
  // Newer Claude Code names the settings and MCP files trust will load, after
  // any warnings and possibly wrapped. Shown verbatim and part of the signature.
  const disclosureStart = body.findIndex(line => /^Trusting this (?:folder|directory) loads /.test(line));
  const disclosure = disclosureStart >= 0 ? body.splice(disclosureStart).join(' ').replace(/\s+/g, ' ') : undefined;
  if (disclosure !== undefined && !/^Trusting this (?:folder|directory) loads [^❯⏺●⎿⚠`]{1,600}\.$/u.test(disclosure)) return;
  const warningStart = body.findIndex(line => /^(?:⚠️?\s*)?This folder (?:pre-approves|adds|runs commands to mint)/u.test(line));
  const warnings = warningStart >= 0 ? body.splice(warningStart) : undefined;
  const explanation = body.join(' ').replace(/\s+/g, ' ');
  if (explanation !== safetyText && explanation !== homeSafetyText) return;
  const scope = explanation === homeSafetyText ? 'session' as const : 'unspecified' as const;
  if (warnings) {
    const ending = 'These will apply without asking. Only proceed if you trust this configuration.';
    if (warnings.at(-1) !== ending) return;
    for (let index = 0; index < warnings.length - 1; index++) {
      const header = warnings[index].replace(/^⚠️?\s*/u, '');
      if (/^This folder runs commands to mint HTTP headers \(headersHelper\), declared in .+$/u.test(header)) continue;
      if (!/^This folder (?:pre-approves [1-9]\d* tool permissions? in|adds [1-9]\d* director(?:y|ies) to the workspace in) .+:$/u.test(header)) return;
      const detail = warnings[++index];
      if (!detail || detail === ending || /^(?:⚠|This folder|❯|⏺|●|⎿|`)/u.test(detail)) return;
    }
  }
  const optionLines = section.slice(firstOption, -1);
  if (optionLines.length !== 2) return;
  const choices = optionLines.map(line => optionPattern.exec(line));
  if (choices.some(choice => !choice)) return;
  const acceptIndex = choices.findIndex(choice => choice![3].startsWith('Yes, I trust this '));
  const cancelIndex = choices.findIndex(choice => choice![3].startsWith('No, '));
  if (acceptIndex < 0 || cancelIndex < 0 || choices.filter(choice => !!choice![1]).length !== 1) return;
  const accept = choices[acceptIndex]!, cancel = choices[cancelIndex]!;
  if (!!accept[2] !== !!cancel[2]) return;
  const acceptOrdinal = accept[2] ? Number(accept[2]) : undefined;
  const cancelOrdinal = cancel[2] ? Number(cancel[2]) : undefined;
  if (acceptOrdinal !== undefined && (!Number.isSafeInteger(acceptOrdinal) || !Number.isSafeInteger(cancelOrdinal)
    || acceptOrdinal < 1 || cancelOrdinal! < 1 || acceptOrdinal === cancelOrdinal)) return;
  const cancelDecision = cancel[3] === 'No, exit' ? 'exit' as const : 'continue' as const;
  const value = { cwd, scope, warnings, disclosure, cancelDecision, acceptLabel: accept[3], cancelLabel: cancel[3], focused: accept[1] ? 'trust' as const : cancelDecision,
    acceptIndex, cancelIndex, acceptOrdinal, cancelOrdinal, confirmKey: 'Enter' as const, cancelKey: 'Escape' as const };
  return { ...value, signature: JSON.stringify(value) };
}
