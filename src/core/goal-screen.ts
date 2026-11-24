import { namedEditorBorder } from './editor-border';

/**
 * Claude Code's native /goal on the screen (2.1.300–2.1.331, research in CLAUDE.md "目标"):
 *
 *   ✻ Whirlpooling… (running Stop hook · 3s · ↓ 24 tokens)        the evaluator at work
 *     tmux focus-events off · add 'set -g …' to ~/.tmux.conf a… · ◎ /goal active (4s)
 *   ────────────────────────────────────────────────────────────  the input box's upper border
 *   ❯
 *
 * The indicator closes the notice row right on top of the input box, joined to other notices
 * (tmux advisories, "◐ medium · /effort", "stop hook problem · ctrl+o to see") by " · ", or
 * alone and right-aligned. Its timer ticks every second for the first minute ("(59s)", then
 * "(1m)", "(2h)"); the notices in front of it are cut to fit and move with it. 2.1.326+ shows
 * "◎ /goal paused" (no timer) when Claude paused the goal itself (PauseGoal). After a busy
 * `/goal clear` the same row briefly says "Goal cleared: <condition>".
 */
const indicator = /(^\s*| · )◎ \/goal (active(?: \((\d+[smhd])\))?|paused)\s*$/u;
const clearedNotice = /^\s{2,}Goal cleared: \S/u;
const upperBorder = (line: string | undefined) => line !== undefined
  && (/^\s*[─━]{8,}(?: \S(?:.*\S)? [─━]+)?\s*$/u.test(line) || namedEditorBorder.test(line));

export interface GoalIndicator { state: 'active' | 'paused'; elapsed?: string }

const plainLines = (viewport: string) => viewport
  .replace(/\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\r/g, '').replace(/ /g, ' ').split('\n');

/**
 * The rows every screen parser reads, with the goal indicator taken out of the notice row
 * on top of the input box (and a busy clear's "Goal cleared: …" notice blanked). The row
 * keeps its width: what stood before the indicator moves right by the indicator's width, so a
 * right-aligned notice stays right-aligned (`withoutEditorNotices` blanks it as before) and
 * "◐ medium · /effort" reads as the effort label again. Rows keep their index.
 */
export function withoutGoalIndicator(lines: string[]): string[] {
  let out: string[] | undefined;
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!upperBorder(lines[i + 1])) continue;
    const row = lines[i].replace(/ /g, ' ').trimEnd();
    if (clearedNotice.test(row)) { (out ??= [...lines])[i] = ''; continue; }
    const match = indicator.exec(row);
    if (!match) continue;
    // Everything in the indicator is one cell wide ("◎", "·", ASCII).
    const kept = row.slice(0, match.index);
    (out ??= [...lines])[i] = kept.trim() ? ' '.repeat(row.length - match.index) + kept : '';
  }
  return out ?? lines;
}

/** The goal indicator above the current input box (the last one on the screen). */
export function parseGoalIndicator(viewport: string): GoalIndicator | undefined {
  const lines = plainLines(viewport);
  for (let i = lines.length - 2; i >= 0; i--) {
    if (!upperBorder(lines[i + 1]) || !/^\s*[❯>!]/u.test(lines[i + 2] ?? '')) continue;
    const match = indicator.exec(lines[i].trimEnd());
    if (!match) return;
    return match[2] === 'paused' ? { state: 'paused' } : { state: 'active', ...match[3] && { elapsed: match[3] } };
  }
}

/**
 * Claude Code's own /goal rows in the transcript, never reply text: "◯ Goal not yet met…
 * continuing", "✔ Goal achieved (2s · 2 turns · 96 tokens)", "✘ Goal couldn't be achieved (…)"
 * ("could not" up to 2.1.325) with the reason indented below, its notices "● Goal still active ·
 * …" and "● Goal paused · …" (wrapped onto indented rows), "● Goal check-in: …", "● Goal cleared
 * after an unrecoverable error …", and "● Ran 1 stop hook" when the evaluator fails.
 */
export const goalTranscriptRow = /^(?:◯ Goal not yet met… continuing|✔ Goal achieved(?: \(.+\))?|✘ Goal could(?:n't| not) be achieved(?: \(.+\))?|[●⏺] (?:Goal (?:still active|paused(?: after \d+ automatic retries)?) · .+|Goal check-in: .+|Goal cleared after an unrecoverable error.+|Ran \d+ stop hooks?))\s*$/u;

/** The evaluator (or another Stop hook) runs: the spinner's "(running Stop hook · 3s · …)". */
export const runningStopHook = /^running Stop hooks?$/iu;

/**
 * The bare `/goal` status panel, which replaces the input box until Esc (2.1.300+). Three
 * layouts: 2.1.300–2.1.325 indent by three and end "… · Esc to dismiss" (or a lone "Esc to
 * dismiss"); 2.1.326 ends with its own "Esc to close" row; 2.1.329+ indent by two, align
 * "Goal:" and "Last check:" and say "/goal clear to stop this goal early". The upper rule is
 * "▔▔▔…", which may carry a notice at its right end ("▔▔▔ ◐ medium · /effort ▔").
 */
export interface GoalPanel { title: string; lines: string[]; dismiss: 'dismiss' | 'close' }
export function parseGoalPanelLines(rows: readonly string[]): GoalPanel | undefined {
  const lines = rows.map(line => line.replace(/ /g, ' ').trimEnd());
  let end = lines.length - 1;
  while (end >= 0 && !lines[end].trim()) end--;
  const esc = /(?:^|· )Esc to (dismiss|close)$/u.exec(lines[end]?.trim() ?? '');
  if (!esc) return;
  let rule = end - 1;
  while (rule >= 0 && end - rule <= 16 && !/^▔{20,}(?: .* ▔+)?$/u.test(lines[rule])) rule--;
  if (rule < 0 || end - rule > 16) return;
  const body = lines.slice(rule + 1, end + 1);
  if (body.some(line => line && !/^ {2,6}\S/u.test(line))) return;
  const first = body.find(line => line.trim())!.trim();
  const title = /^(?:◎ |✔ )?(Goal (?:active|paused|achieved)|Goal)$/u.exec(first)?.[1];
  if (!title) return;
  const text = body.map(line => line.trim()).filter(Boolean).slice(1);
  // The last row's own hint goes; a separate "Esc to …" row goes entirely.
  const last = text.at(-1)!.replace(/(?:^| · )Esc to (?:dismiss|close)$/u, '').trim();
  return { title, lines: last ? [...text.slice(0, -1), last] : text.slice(0, -1), dismiss: esc[1] as 'dismiss' | 'close' };
}
