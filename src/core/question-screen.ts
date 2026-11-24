import type { NativeQuestionOption, NativeQuestionScreen } from '../shared/native-question';
import { inTranscriptExample } from './dialog-boundary';
import { stripTerminalEscapes, terminalCells } from './screen';
import { namedEditorBorder } from './editor-border';

export const ruler = /^─{8,}$/u;
// Claude Code wraps by terminal cells. A break between two wide (CJK) characters
// had no space in the original, nor one beside fullwidth punctuation (a long run
// like "对比（ImageGrid" is cut at the edge); a break elsewhere was at a space.
const wide = (char: string | undefined) => !!char && terminalCells(char) === 2;
const cjkPunctuation = /^[　-〿！-／：-＠［-｀｛-･]$/u;
const glued = (a = '', b = '') => wide(a) && wide(b) || cjkPunctuation.test(a) || cjkPunctuation.test(b);
function joinWrapped(parts: string[]) {
  return parts.reduce((text, part) => !text ? part : text + (glued(Array.from(text).at(-1), Array.from(part)[0]) ? '' : ' ') + part, '');
}
/**
 * Rejoin text Claude Code wrapped into rows of `width` cells, keeping the text's own line breaks
 * and blank lines. Claude Code breaks a row at a space and cuts only a word longer than a whole
 * row (2.1.300–2.1.331), so a row ends where the text has a line break when the next row's first
 * word would have fit after it, or the next row starts indented (a wrapped row never does). A run
 * without spaces longer than a row fills it and goes on in the next one ("…/demo-grad-eval" and
 * "-736rel-…"): two narrow characters at a full row's end, in a run too long for a row together,
 * are joined as they were (beside a wide one it may as well be a space, as in "脚本 sync_demo.sh…").
 */
function unwrap(rows: string[], width: number) {
  const lines: string[] = [];
  let last: string | undefined;
  for (const row of rows) {
    const word = /^\S+/u.exec(row)?.[0];
    if (last !== undefined && word && terminalCells(last) + 1 + terminalCells(word) > width) {
      const tail = /\S+$/u.exec(last)![0], cut = terminalCells(last) === width && !wide(Array.from(tail).at(-1)) && !wide(Array.from(word)[0])
        && terminalCells(tail) + terminalCells(word) > width;
      lines.push(cut ? lines.pop()! + row : joinWrapped([lines.pop()!, row]));
    } else lines.push(row);
    last = row.trim() ? row : undefined;
  }
  return lines.join('\n');
}
/** The question as asked, whatever it holds (paragraphs, lists, code, a bar of its own): a question
 * of more than one row has a quote bar on every row ("│ ", alone on a blank line; 2.1.300–2.1.331).
 * Rows are never a reason to reject the dialog: one without the bar is kept as it is. */
function questionText(rows: string[], width: number) {
  const barred = rows[0]?.startsWith('│');
  return unwrap(barred ? rows.map(row => row.replace(/^│ ?/u, '')) : rows.map(row => row.trim()), barred ? width - 2 : width);
}
// A named session (2.1.329) closes the dialog with its name in a rule below the footer,
// the input box's upper border: any width of name (editor-border.ts).
export const namedRule = namedEditorBorder;
const numberRow = /^(❯ |  )([1-9]\d*)\. (.+)$/u;
// The footer names its keys between "Enter to select" and "Esc to cancel": the navigation
// (arrows, Tab with several questions), notes, the editor; any other hint added there is kept.
export const footerPattern = /^Enter to select(?: · [^·]+)+ · Esc to cancel$/u;
export const trimBlank = (lines: string[]) => {
  let i = 0, j = lines.length;
  while (i < j && !lines[i].trim()) i++;
  while (j > i && !lines[j-1].trim()) j--;
  return lines.slice(i,j);
};
export function tabStrip(line: string) {
  const nav = /^←\s+(.+?)\s+✔ Submit\s+→$/u.exec(line.trim());
  const parts = (nav?.[1] ?? line.trim()).split(/\s{2,}(?=[☐☒] )/u);
  const tabs = parts.map(part=>/^([☐☒]) ([^☐☒✔←→]+)$/u.exec(part));
  if ((!nav && parts.length !== 1) || !tabs.length || tabs.some(t=>!t || !t[2].trim())) return;
  return {tabs:tabs.map(t=>({label:t![2].trim(),answered:t![1]==='☒'})),hasReview:!!nav};
}
/** Only an actual terminal highlight identifies the active tab of a plain multi-page form. */
function activeQuestionTab(line: string, count: number) {
  const parts = line.split(/(\x1b\[[\d;]+m)/u);
  let highlighted = false, tab = 0, active: number | undefined;
  for (const part of parts) {
    const sgr = /^\x1b\[([\d;]+)m$/u.exec(part);
    if (sgr) {
      const codes = sgr[1].split(';').map(Number);
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        if (code === 0 || code === 27 || code === 49) highlighted = false;
        else if (code === 7 || code >= 40 && code <= 47 || code >= 100 && code <= 107 || code === 48) highlighted = true;
        if (code === 38 || code === 48) i += codes[i + 1] === 2 ? 4 : 2;
      }
    } else {
      for (const _ of part.matchAll(/[☐☒] (?=\S)|✔ Submit/gu)) {
        if (highlighted) {
          if (active !== undefined) return;
          active = tab;
        }
        tab++;
      }
    }
  }
  return tab === count + 1 ? active : undefined;
}

export function questionReview(lines: string[], width: number) {
  const rows = lines.filter(s=>s.trim());
  // 2.1.329 dropped the "Ready to submit your answers?" line above the two actions.
  const ready = rows.at(-3) === 'Ready to submit your answers?', end = rows.length - (ready ? 3 : 2);
  if (rows[0] !== 'Review your answers') return;
  const options: NativeQuestionOption[] = [];
  for (const [i,line] of rows.slice(-2).entries()) {
    const match = numberRow.exec(line), label = i === 0 ? 'Submit answers' : 'Cancel';
    if (!match || match[2] !== String(i+1) || match[3] !== label) return;
    options.push({number:i+1,label,kind:i===0?'submit':'cancel',focused:match[1]==='❯ '});
  }
  if (options.filter(o=>o.focused).length!==1) return;
  let i = 1;
  // 2.1.329 reworded the warning above a partial set of answers.
  const incomplete = /^⚠\s+(?:You have not answered all questions|Some questions are unanswered)$/u.test(rows[i]);
  if (incomplete) i++;
  const answers: NonNullable<NativeQuestionScreen['review']> = [];
  for (; i<end;) {
    // Some releases mix quoted, wrapping questions with unquoted short ones on the same page.
    const q = /^ (│ )?[●⏺] (.+)$/u.exec(rows[i++]); if (!q) return;
    const barred = !!q[1], question = [q[2]];
    const more = barred ? /^ │(?: {3}(.*))?$/u : /^ {3,}(?!→)(\S.*)$/u;
    for (let m; i<end && (m = more.exec(rows[i])); i++) question.push(m[1] ?? '');
    const a = /^ {3}→ (.+)$/u.exec(rows[i++] ?? ''); if(!a) return;
    const answer = [a[1]];
    while (i<end && /^ {3,}\S/u.test(rows[i])) answer.push(rows[i++].trim());
    answers.push({question:unwrap(question, width - (barred ? 5 : 3)),answer:joinWrapped(answer)});
  }
  return { options, review: answers, incomplete };
}
export function standardRows(lines:string[], chat:string, hasAnswer:boolean, width:number): Pick<NativeQuestionScreen,'multiSelect'|'options'|'input'> | undefined {
  const options: NativeQuestionOption[] = [], described = new Map<NativeQuestionOption, string[]>();
  let multiSelect: boolean | undefined, action: NativeQuestionOption | undefined;
  const chatRow = /^(❯ |  )([1-9]\d*)\. Chat about this$/u.exec(chat); if (!chatRow) return;
  for (const line of lines) {
    const row = numberRow.exec(line);
    if (row) {
      const number = Number(row[2]), check = /^\[([ ✔])\] (.+)$/u.exec(row[3]);
      if (number!==options.length+1 || action || (multiSelect!==undefined && !!check!==multiSelect)) return;
      multiSelect = !!check;
      const marked = !multiSelect && hasAnswer && row[3].endsWith(' ✔');
      options.push({number,focused:row[1]==='❯ ',kind:'choice',label:marked?row[3].slice(0,-2):check?.[2]??row[3],
        ...(check?{checked:check[1]==='✔'}:marked?{checked:true}:{})});
    } else {
      const submit = /^(❯ {4}| {5})(Submit|Next)$/u.exec(line);
      if (submit && multiSelect && !action) {
        action = {number:Number(chatRow[2])+1,kind:submit[2]==='Next'?'next':'submit',label:submit[2],focused:submit[1][0]==='❯'};
      } else {
        const last = options.at(-1);
        if (action || !last || !/^ {5,}\S/u.test(line)) return;
        described.set(last, [...described.get(last) ?? [], line]);
      }
    }
  }
  // A description wraps to the pane's width less its indent (five, nine under a checkbox). In this
  // layout the final numbered row ABOVE the separator is the custom text field: rows under it are
  // a long answer of one's own, wrapped the same way.
  const other = options.at(-1), unwrapped = (rows: string[], first = '') => {
    const indent = /^ */u.exec(rows[0])![0].length;
    return unwrap([...first ? [first] : [], ...rows.map(row => row.slice(indent))], width - indent);
  };
  for (const [option, rows] of described) if (option !== other) option.description = unwrapped(rows);
  if (!other || options.length<3 || Number(chatRow[2])!==options.length+1 || !!action!==multiSelect
    || (!multiSelect && options.filter(o=>o.checked).length>1)) return;
  other.kind = 'other';
  const placeholder = multiSelect?'Type something':'Type something.', typed = described.get(other);
  let value = typed ? unwrapped(typed, other.label) : other.label;
  if (typed && !multiSelect && hasAnswer && value.endsWith(' ✔') && !other.checked) { value = value.slice(0, -2); other.checked = true; }
  const input = {kind:'other' as const,number:other.number,value:value===placeholder?'':value,focused:other.focused};
  other.label = placeholder;
  if (action) options.push(action);
  options.push({number:Number(chatRow[2]),kind:'chat',label:'Chat about this',focused:chatRow[1]==='❯ '});
  return {multiSelect,options,input};
}
function previewChoices(lines: string[], hasAnswer: boolean) {
  const options: NativeQuestionOption[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], number = options.length + 1;
    const row = numberRow.exec(line);
    const selected = hasAnswer && /^(❯ | {2}) {2}(\S.*?) ✔$/u.exec(line);
    if (row) {
      if (Number(row[2]) !== number) return;
      const checked = hasAnswer && row[3].endsWith(' ✔');
      options.push({ number, kind: 'choice', label: checked ? row[3].slice(0, -2) : row[3], focused: row[1] === '❯ ', ...(checked && { checked }) });
    } else if (selected) {
      // Adding the check mark can move the number to the next row, ahead of the
      // rest of the label (e.g. "❯   … ✔" followed by " 2.对齐").
      const next = /^ ([1-9]\d*)\.(.*)$/u.exec(lines[++i] ?? '');
      if (!next || Number(next[1]) !== number) return;
      const label = joinWrapped([selected[2], next[2].trim()].filter(Boolean));
      options.push({ number, kind: 'choice', label, focused: selected[1] === '❯ ', checked: true });
    } else {
      const previous = options.at(-1);
      if (!previous || !/^ {4,}\S/u.test(line)) return;
      previous.label = joinWrapped([previous.label, line.trim()]);
    }
  }
  if (options.length >= 2 && options.filter(o=>o.checked).length <= 1) return options;
}

export function previewRows(lines:string[],chat:string,footer:string,hasAnswer:boolean): Pick<NativeQuestionScreen,'options'|'multiSelect'|'canAmend'|'input'|'preview'> | undefined {
  const chatRow = /^(❯ |  )Chat about this$/u.exec(chat); if (!chatRow) return;
  const labels: string[] = [], body: string[] = [];
  let notes: string | undefined, column: number | undefined, boxWidth = 0, closed = false;
  // The option and preview columns share physical lines. Split at the box glyph,
  // not a JS character offset: CJK characters occupy two terminal cells.
  for (const raw of lines) {
    const fields = /^(.*?)\s+(┌─+┐|│.*│|├─+ ✂ ─+ \d+ lines? hidden ─+┤|└─+┘)$/u.exec(raw);
    const left = (fields?.[1] ?? raw).trimEnd(), right = fields?.[2];
    if (right?.startsWith('┌')) {
      if (column !== undefined || labels.length) return;
      column = terminalCells(raw.slice(0, -right.length));
      boxWidth = terminalCells(right);
    } else if (right) {
      if (column === undefined || closed || column !== terminalCells(raw.slice(0, -right.length))) return;
      // Preview text can contain tabs and characters whose cell width differs between Ink and tmux.
      if (right.startsWith('└')) {
        if (boxWidth !== terminalCells(right)) return;
        closed = true;
      } else if (right.startsWith('├')) {
        body.push(right.replace(/^├─+ ✂ ─+ | ─+┤$/gu, ''));
      } else body.push(right.slice(1,-1).replace(/^ /,'').trimEnd());
    } else if (column !== undefined && !closed) return;
    if (!left.trim()) continue;
    if (closed && column !== undefined) {
      const aligned = left.startsWith(' '.repeat(column));
      const note = aligned ? /^Notes: (.+)$/u.exec(left.slice(column)) : null;
      if (note && notes === undefined) { notes = note[1]; continue; }
      if (notes !== undefined && aligned) { notes += ' ' + left.trim(); continue; }
    }
    if (!right && (column === undefined || terminalCells(left) >= column)) return;
    labels.push(left);
  }
  const options = previewChoices(labels, hasAnswer);
  if (!closed || !options || notes===undefined || !body.length) return;
  const owners = options.filter(o=>o.focused); if (owners.length!==1) return;
  const owner = owners[0], chatFocused = chatRow[1]==='❯ ';
  // Preview keeps its pointer on the last option even when Chat owns the keys.
  if (chatFocused) owner.focused=false;
  options.push({number:options.length+1,kind:'chat',label:'Chat about this',focused:chatFocused});
  const focused = !chatFocused && (notes==='Add notes on this design…' || footer.includes('ctrl+g to edit in '));
  const hint = notes==='press n to add notes' || notes==='Add notes on this design…';
  return {options,multiSelect:false,canAmend:!chatFocused,...(body.join('\n')==='No preview available'?{}:{preview:body.join('\n')}),
    input:{kind:'notes',number:owner.number,focused,value:hint?'':notes}};
}
/**
 * Read a native AskUserQuestion dialog at the bottom of the current viewport by its fixed frame,
 * never by what the question says. From the bottom: an optional rule (the input box's upper border,
 * named in a named session), the footer ("Enter to select · … · Esc to cancel"), the Chat row under
 * the divider, then the options up to the last row numbered 1 above the divider, after a blank row.
 * From the top: a full-width rule and the tab strip (one header, or the arrows, the questions and
 * Submit). Everything between the tab strip and the options is the question, as it is: blank lines,
 * lists, code and any shape of text (questionText); the review page likewise.
 *
 * A text-only parse rejects a chooser copied into assistant output. To recognize a genuine chooser
 * after an assistant preamble, the caller must independently verify that Claude Code waits for it:
 * a pending AskUserQuestion tool_use on the active branch and a waiting native pane, or, before the
 * transcript has that call, the native record waiting for "input needed" (main/session-question.ts
 * earlyQuestion). A chooser in a code block is never one.
 */
export function parseQuestionScreen(viewport:string, evidence?:{pendingToolUse:true}): NativeQuestionScreen | undefined {
  const raw = viewport.split('\n'), offset = raw.findIndex(line=>stripTerminalEscapes(line).trim());
  const lines = questionLines(viewport);
  let start = lines.length - 2;
  while (start >= 0 && !(ruler.test(lines[start]) && tabStrip(lines[start+1]))) start--;
  if (start<0) return;
  const before = lines.slice(0,start);
  if (insideQuestionFence(before) || (inTranscriptExample(before) && !evidence?.pendingToolUse)) return;
  // The rule spans the pane: the width Claude Code wrapped the question to.
  const width = terminalCells(lines[start]);
  const {tabs,hasReview} = tabStrip(lines[start+1])!;
  const section = trimBlank(lines.slice(start+2));
  if (section[0]==='Review your answers' && hasReview) {
    const data = questionReview(section, width);
    if (!data || data.review.length !== tabs.filter(t=>t.answered).length || data.incomplete !== tabs.some(t=>!t.answered)) return;
    return {kind:'review',tabs,activeTab:tabs.length,options:data.options,review:data.review,footer:''};
  }
  let divider = section.length - 1;
  while (divider >= 0 && !ruler.test(section[divider])) divider--;
  if (divider<0) return;
  const tail = trimBlank(section.slice(divider+1)), chat = tail[0]??'';
  const footer = tail.slice(1).map(line=>line.trim()).filter(Boolean).join(' ');
  if (!footerPattern.test(footer)) return;
  const preview = footer.includes('n to add notes');
  const first = firstQuestionOption(section, divider, preview);
  if (first<2 || section[first-1]!=='') return;
  const question = questionText(trimBlank(section.slice(0,first-1)), width);
  if (!question.trim()) return;
  const rows = trimBlank(section.slice(first,divider));
  const activeTab = tabs.length === 1 ? 0 : activeQuestionTab(raw[offset + start + 1], tabs.length);
  if (activeTab === tabs.length) return;
  const hasAnswer = activeTab === undefined ? tabs.some(t=>t.answered) : tabs[activeTab].answered;
  const data = preview ? previewRows(rows,chat,footer,hasAnswer) : standardRows(rows,chat,hasAnswer,width);
  if (!data || data.options.filter(o=>o.focused).length!==1 || hasReview!==(tabs.length>1 || data.multiSelect)) return;
  return {kind:'question',tabs,...(activeTab!==undefined?{activeTab}:{}),question,...data,footer};
}

export const insideQuestionFence = (before: string[]) => before.filter(line=>/^\s*(?:[●⏺]\s+)?```/u.test(line)).length % 2 !== 0;

export function firstQuestionOption(lines: string[], divider: number, preview: boolean) {
  // Search from the footer. A question's own numbered rows or box sit above the options.
  const pattern = preview ? /^(?:❯ | {2})(?:1\. | {2}\S).* +┌─+┐$/u : /^(?:❯ | {2})1\. /u;
  let first = divider - 1;
  while (first >= 0 && !pattern.test(lines[first])) first--;
  return first;
}

export function questionLines(viewport: string) {
  const lines = trimBlank(stripTerminalEscapes(viewport).replace(/\u00a0/g, ' ').split('\n').map(line=>line.trimEnd()));
  return lines.length && namedRule.test(lines.at(-1)!) ? trimBlank(lines.slice(0, -1)) : lines;
}
