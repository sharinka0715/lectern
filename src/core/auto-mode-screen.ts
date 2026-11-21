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

/** "Auto mode can't check actions in this session" (Claude Code 2.1.321+), which
 * holds a tool call when auto mode's safety check is to run on the server and does
 * not: the requests go through a gateway or other third-party endpoint that does
 * not pass the check through, and the server-side check is on (it is unless
 * CLAUDE_CODE_AUTO_MODE_SERVER turns it off, which Lectern's launch settings do).
 * It replaces the input box until answered and has no numbered choices, only keys:
 *
 *   ────────────────────────────── (full-width rule)
 *     Auto mode can't check actions in this session
 *
 *     Auto mode's safety check runs on the server. Your requests go through …
 *
 *     You can stay in auto mode and approve each action that needs the check yourself.
 *
 *     Or you can leave for accept edits mode, … This turn stops, …
 *
 *     To get the check back, …
 *
 *     Enter to stay in auto mode · shift+Tab to leave for accept edits mode and stop · Esc to cancel
 *
 * Shift+Tab is refused while the dialog does not fit the terminal; the footer then
 * says "… and stop (needs a taller window)". Esc stops the turn. Never answered by
 * Lectern on its own: the choice is a safety decision. */
export interface AutoModeUnavailable { title: string; paragraphs: string[]; footer: string; canLeave: boolean }

export const AUTO_MODE_UNAVAILABLE_TITLE = "Auto mode can't check actions in this session";
const UNAVAILABLE_FOOTER = /^Enter to stay in auto mode · shift\+Tab to leave for accept edits mode and stop( \(needs a taller window\))? · Esc to cancel$/u;

/** The dialog's title under a full-width rule, with only its indented paragraphs below,
 * as the last thing on screen: also when a short terminal cuts off its end (and footer). */
function unavailableDialog(rawLines: readonly string[]) {
  const lines = rawLines.map(line => line.replace(/\u00a0/g, ' ').trimEnd());
  while (lines.length && !lines.at(-1)) lines.pop();
  let title = lines.length - 1;
  while (title >= Math.max(0, lines.length - 80) && lines[title].trim() !== AUTO_MODE_UNAVAILABLE_TITLE) title--;
  if (title < 1 || !/^ {1,4}\S/u.test(lines[title])) return;
  let rule = title - 1;
  while (rule > 0 && !lines[rule]) rule--;
  if (!/^─{40,}$/u.test(lines[rule])) return;
  // Paragraphs below the title, each line indented alike.
  const body = lines.slice(title + 1);
  const indent = /^( {1,4})\S/u.exec(body.find(Boolean) ?? '')?.[1];
  if (!indent || body.some(line => line && !(line.startsWith(indent) && /\S/u.test(line[indent.length])))) return;
  return body.map(line => line.slice(indent.length));
}

/** True while the dialog holds the screen, readable or not (screen.ts classifies it as waiting). */
export function showsAutoModeUnavailable(lines: readonly string[]): boolean {
  return !!unavailableDialog(lines);
}

export function parseAutoModeUnavailableLines(rawLines: readonly string[]): AutoModeUnavailable | undefined {
  const body = unavailableDialog(rawLines);
  if (!body) return;
  // Wrapped lines are joined; the last paragraph is the key hint (a narrow terminal wraps it too).
  const paragraphs = body.join('\n').split(/\n{2,}/u).map(part => part.trim().split('\n').join(' ')).filter(Boolean);
  const footer = paragraphs.pop() ?? '';
  const keys = UNAVAILABLE_FOOTER.exec(footer);
  if (!keys || paragraphs.length < 2) return;
  return { title: AUTO_MODE_UNAVAILABLE_TITLE, paragraphs, footer, canLeave: !keys[1] };
}
