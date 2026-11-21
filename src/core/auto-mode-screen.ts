/** "Make auto mode your default permission mode?", which Claude Code 2.1.300+
 * shows at startup to a user whose own default permission mode is manual. Lectern
 * starts its sessions with auto mode as the default (launch-settings.ts), so it does
 * not appear for them in 2.1.300–2.1.330; should a release ask anyway, the backend
 * answers "No, keep manual mode", which keeps the session in auto mode and leaves
 * the user's settings files unchanged.
 * Layouts: 2.1.300–2.1.321 indent the title one cell and the rest three; 2.1.329+
 * indent everything two. Only the complete dialog at the bottom of the screen,
 * below a full-width rule and with nothing after its two choices, is recognized. */
export interface AutoModeNudge { focused: 'yes' | 'no'; signature: string }

const TITLE = 'Make auto mode your default permission mode?';
const YES = 'Yes, set auto mode as my default permission mode';
const NO = 'No, keep manual mode';
const BODY = 'Auto mode lets Claude handle permission prompts automatically. Claude checks each tool call for risky actions and prompt injection before executing, runs the ones it assesses as lower-risk, and blocks the rest.';

/** Lines without terminal escapes (screen.ts parseAutoModeNudge takes a viewport);
 * kept import-free so the screen classifier can use it without a dependency cycle. */
export function parseAutoModeNudgeLines(rawLines: readonly string[]): AutoModeNudge | undefined {
  const lines = rawLines.map(line => line.replace(/\u00a0/g, ' ').trimEnd());
  while (lines.length && !lines.at(-1)) lines.pop();
  if (lines.length < 6) return;
  const choice = (line: string) => /^( {2,4})(❯ | {2})(.+)$/u.exec(line);
  const yes = choice(lines.at(-2)!), no = choice(lines.at(-1)!);
  if (!yes || !no || yes[1] !== no[1] || yes[3] !== YES || no[3] !== NO) return;
  const focusedYes = yes[2] === '❯ ', focusedNo = no[2] === '❯ ';
  if (focusedYes === focusedNo) return;
  let title = lines.length - 3;
  while (title >= 0 && lines[title].trim() !== TITLE) title--;
  if (title < 1 || !/^ {1,4}\S/u.test(lines[title])) return;
  let rule = title - 1;
  while (rule > 0 && !lines[rule]) rule--;
  if (!/^─{40,}$/u.test(lines[rule])) return;
  const body = lines.slice(title + 1, -2);
  if (body.some(line => line && !/^ {2,4}\S/u.test(line))) return;
  if (body.filter(Boolean).map(line => line.trim()).join(' ') !== BODY) return;
  const focused = focusedYes ? 'yes' as const : 'no' as const;
  return { focused, signature: JSON.stringify({ focused, indent: yes[1].length }) };
}
