import type { NativeQuestionOption, NativeQuestionScreen } from '../shared/native-question';
import { footerPattern, namedRule, parseQuestionScreen, previewRows, ruler, standardRows, tabStrip, trimBlank } from './question-screen';
import { stripTerminalEscapes, terminalCells } from './screen';

/** One question of an AskUserQuestion call's input, as Claude Code handed it to the PreToolUse hook. */
export interface AskedQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description?: string; preview?: string }[];
}
const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max ? value : undefined;

/** The questions of an AskUserQuestion input, or undefined when it is not that shape. */
export function askedQuestions(input: unknown): AskedQuestion[] | undefined {
  const questions = (input as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(questions) || !questions.length || questions.length > 8) return;
  const asked: AskedQuestion[] = [];
  for (const raw of questions) {
    const q = raw as Record<string, unknown> | null;
    const question = text(q?.question, 20_000), header = text(q?.header, 256), options = q?.options;
    if (!question?.trim() || header === undefined || !Array.isArray(options) || !options.length || options.length > 16) return;
    if (q!.multiSelect !== undefined && typeof q!.multiSelect !== 'boolean') return;
    const rows: AskedQuestion['options'] = [];
    for (const option of options as Record<string, unknown>[]) {
      const label = text(option?.label, 1000), description = text(option?.description, 20_000), preview = text(option?.preview, 100_000);
      if (!label?.trim() || (option.description !== undefined && description === undefined)) return;
      rows.push({ label, ...description && { description }, ...preview && { preview } });
    }
    asked.push({ question, header, multiSelect: q!.multiSelect === true, options: rows });
  }
  return asked;
}

const squash = (value: string) => value.replace(/\s+/gu, ' ').trim();
/** A label as the screen shows it: the same text, or (wrapped or cut by the pane) its start. */
function sameLabel(screen: string, asked: string) {
  const a = squash(screen), b = squash(asked);
  return a === b || (a.length >= 16 && b.startsWith(a));
}
/** A tab as the tab strip shows it: the header, or its start cut with "…" on a narrow pane. */
function sameTab(screen: string, header: string) {
  return screen === header.trim() || (screen.endsWith('…') && header.trim().startsWith(screen.slice(0, -1)));
}

/** The asked questions whose options the visible choice rows are, in order. */
function pages(options: NativeQuestionOption[], multiSelect: boolean | undefined, asked: AskedQuestion[]) {
  const choices = options.filter(o => o.kind === 'choice');
  return asked.flatMap((q, i) => q.multiSelect === !!multiSelect && choices.length === q.options.length
    && choices.every((o, j) => sameLabel(o.label, q.options[j].label)) ? [i] : []);
}

/** The screen's state (page, focus, checks, edits, footer) with the asked text in place of the
 * screen's: question, headers, labels, descriptions and the focused option's preview. */
function withAsked(screen: NativeQuestionScreen, asked: AskedQuestion[], page: number, answered: boolean[]): NativeQuestionScreen {
  const q = asked[page];
  let index = 0;
  const options = screen.options.map(o => {
    if (o.kind !== 'choice') return o;
    const row = q.options[index++], { description: _, ...rest } = o;
    return { ...rest, label: row.label, ...row.description && { description: row.description } };
  });
  // The preview chooser shows the preview of the option its notes belong to (Chat may own the keys).
  const owner = screen.input?.kind === 'notes' ? q.options[screen.input.number - 1] : undefined;
  const { preview: _, ...rest } = screen;
  return { ...rest, tabs: asked.map((a, i) => ({ label: a.header, answered: answered[i] ?? false })), activeTab: page,
    question: q.question, multiSelect: q.multiSelect, options, ...owner?.preview && { preview: owner.preview } };
}

/** A dialog the whole frame reads (parseQuestionScreen), checked against the call's input. */
function fromWhole(screen: NativeQuestionScreen, asked: AskedQuestion[]): NativeQuestionScreen | undefined {
  if (screen.tabs.length !== asked.length || screen.tabs.some((tab, i) => !sameTab(tab.label, asked[i].header))) return;
  const answered = screen.tabs.map(tab => tab.answered);
  if (screen.kind === 'review') {
    const shown = asked.filter((_, i) => answered[i]);
    if (screen.review?.length !== shown.length) return;
    return { ...screen, tabs: asked.map((a, i) => ({ label: a.header, answered: answered[i] })),
      review: screen.review.map((row, i) => ({ ...row, question: shown[i].question })) };
  }
  let found = pages(screen.options, screen.multiSelect, asked);
  if (found.length > 1) found = found.filter(i => squash(asked[i].question) === squash(screen.question ?? ''));
  return found.length === 1 ? withAsked(screen, asked, found[0], answered) : undefined;
}

/** Claude Code's note that rows above (or below) are out of the pane. */
const moreLines = /^\s*[↑↓] \d+ more lines?$/u;
/**
 * The dialog by its bottom alone, for a question taller than the pane: Claude Code then redraws
 * it whole with its top (rule, tab strip, the start of the question) cut off and "↑ N more lines"
 * above the footer. From the bottom: the footer, the Chat row and the divider, then the options up
 * to the last row numbered 1 above it, read as the whole frame reads them; the tab strip only if
 * it is on screen after all. The visible choices must be exactly one asked question's options.
 */
function fromBottom(viewport: string, asked: AskedQuestion[]): NativeQuestionScreen | undefined {
  let lines = trimBlank(stripTerminalEscapes(viewport).replace(/ /g, ' ').split('\n').map(line => line.trimEnd()));
  if (lines.length && namedRule.test(lines.at(-1)!)) lines = trimBlank(lines.slice(0, -1));
  let divider = lines.length - 1;
  while (divider >= 0 && !ruler.test(lines[divider])) divider--;
  if (divider < 1) return;
  const [chat = '', ...tail] = trimBlank(lines.slice(divider + 1));
  const footer = tail.filter(line => line.trim() && !moreLines.test(line)).map(line => line.trim()).join(' ');
  if (!footerPattern.test(footer)) return;
  let first = divider - 1;
  while (first >= 0 && !/^(?:❯ | {2})1\. /u.test(lines[first])) first--;
  if (first < 0) return;
  let top = first - 1;
  while (top >= 0 && !(ruler.test(lines[top]) && tabStrip(lines[top + 1] ?? ''))) top--;
  const strip = top >= 0 ? tabStrip(lines[top + 1]) : undefined;
  if (strip && (strip.tabs.length !== asked.length || strip.tabs.some((tab, i) => !sameTab(tab.label, asked[i].header)))) return;
  const rows = trimBlank(lines.slice(first, divider));
  const answeredBefore = strip ? strip.tabs.some(tab => tab.answered) : rows.some(row => / ✔$/u.test(row));
  const data = footer.includes('n to add notes') ? previewRows(rows, chat, footer) : standardRows(rows, chat, answeredBefore, terminalCells(lines[divider]));
  if (!data || data.options.filter(o => o.focused).length !== 1) return;
  const found = pages(data.options, data.multiSelect, asked);
  if (found.length !== 1 || (strip && strip.hasReview !== (asked.length > 1 || asked[found[0]].multiSelect))) return;
  const answered = strip ? strip.tabs.map(tab => tab.answered) : asked.map(() => false);
  return withAsked({ kind: 'question', tabs: [], ...data, footer }, asked, found[0], answered);
}

/**
 * The AskUserQuestion dialog at the bottom of the screen read with its call's input (the
 * PreToolUse hook's tool_input): the text, headers, options and previews are the input's, the
 * screen gives only what the user does there (page, focus, checks, edits, the review). Undefined
 * when the screen does not show exactly this call's dialog: the caller reads the screen alone.
 * The question card and the driver that answers it read every frame this same way.
 */
export function readHookQuestion(viewport: string, asked: AskedQuestion[]): NativeQuestionScreen | undefined {
  const whole = parseQuestionScreen(viewport, { pendingToolUse: true });
  return whole ? fromWhole(whole, asked) : fromBottom(viewport, asked);
}
