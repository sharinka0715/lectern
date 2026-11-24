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
function review(lines: string[], tabs: NativeQuestionScreen['tabs'], width: number): NativeQuestionScreen | undefined {
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
  // Once any question takes more than a row, every question carries a quote bar (" │ ● …",
  // continued by " │   …", a blank line of its own by " │"; 2.1.300 to 2.1.331); answers stay
  // unbarred ("   → …").
  const barred = rows[i]?.startsWith(' │ ');
  const head = barred ? /^ │ [●⏺] (.+)$/u : /^ [●⏺] (.+)$/u;
  const more = barred ? /^ │(?: {3}(.*))?$/u : /^ {3,}(?!→)(\S.*)$/u;
  const answers: NonNullable<NativeQuestionScreen['review']> = [];
  for (; i<end;) {
    const q = head.exec(rows[i++]); if (!q) return;
    const question = [q[1]];
    for (let m; i<end && (m = more.exec(rows[i])); i++) question.push(m[1] ?? '');
    const a = /^ {3}→ (.+)$/u.exec(rows[i++] ?? ''); if(!a) return;
    const answer = [a[1]];
    while (i<end && /^ {3,}\S/u.test(rows[i])) answer.push(rows[i++].trim());
    answers.push({question:unwrap(question, width - (barred ? 5 : 3)),answer:joinWrapped(answer)});
  }
  if (answers.length!==tabs.filter(t=>t.answered).length || incomplete!==tabs.some(t=>!t.answered)) return;
  return {kind:'review',tabs,activeTab:tabs.length,options,review:answers,footer:''};
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
export function previewRows(lines:string[],chat:string,footer:string): Pick<NativeQuestionScreen,'options'|'multiSelect'|'canAmend'|'input'|'preview'> | undefined {
  const chatRow = /^(❯ |  )Chat about this$/u.exec(chat); if (!chatRow) return;
  const options: NativeQuestionOption[] = [], body:string[] = [];
  let notes: string | undefined, opened = false, closed = false;
  // The option and preview columns share physical lines. Split at the box glyph,
  // not a JS character offset: CJK characters occupy two terminal cells.
  for (const raw of lines) {
    const fields = /^(.*?)\s+(┌─+┐|│.*│|└─+┘)$/u.exec(raw);
    const left = (fields?.[1] ?? raw).trimEnd(), right = fields?.[2];
    if (right?.startsWith('┌')) { if (opened || closed) return; opened=true; }
    else if (right?.startsWith('│')) { if (!opened || closed) return; body.push(right.slice(1,-1).replace(/^ /,'').trimEnd()); }
    else if (right?.startsWith('└')) { if (!opened || closed) return; closed=true; }
    if (!left.trim()) continue;
    const row = numberRow.exec(left);
    if (row) {
      if (Number(row[2])!==options.length+1) return;
      options.push({number:Number(row[2]),kind:'choice',label:row[3],focused:row[1]==='❯ '});
    } else if (closed && /^ {30,}Notes: /.test(left) && notes===undefined) notes=left.trim().slice('Notes: '.length);
    else if (closed && notes!==undefined && /^ {30,}\S/u.test(left)) notes+=' '+left.trim();
    else return;
  }
  if (!closed || options.length<2 || notes===undefined || !body.length) return;
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
  let lines = trimBlank(stripTerminalEscapes(viewport).replace(/\u00a0/g,' ').split('\n').map(line=>line.trimEnd()));
  if (lines.length && namedRule.test(lines.at(-1)!)) lines = trimBlank(lines.slice(0,-1));
  let start = lines.length - 2;
  while (start >= 0 && !(ruler.test(lines[start]) && tabStrip(lines[start+1]))) start--;
  if (start<0) return;
  const before = lines.slice(0,start);
  const fenced = before.filter(line=>/^\s*(?:[●⏺]\s+)?```/u.test(line)).length%2!==0;
  if (fenced || (inTranscriptExample(before) && !evidence?.pendingToolUse)) return;
  // The rule spans the pane: the width Claude Code wrapped the question to.
  const width = terminalCells(lines[start]);
  const {tabs,hasReview} = tabStrip(lines[start+1])!;
  const section = trimBlank(lines.slice(start+2));
  if (section[0]==='Review your answers' && hasReview) return review(section,tabs,width);
  let divider = section.length - 1;
  while (divider >= 0 && !ruler.test(section[divider])) divider--;
  if (divider<0) return;
  const tail = trimBlank(section.slice(divider+1)), chat = tail[0]??'';
  const footer = tail.slice(1).map(line=>line.trim()).filter(Boolean).join(' ');
  if (!footerPattern.test(footer)) return;
  // Searched upwards: a question of its own "  1. …" rows sits above the options.
  let first = divider - 1;
  while (first >= 0 && !/^(?:❯ | {2})1\. /u.test(section[first])) first--;
  if (first<2 || section[first-1]!=='') return;
  const question = questionText(trimBlank(section.slice(0,first-1)), width);
  if (!question.trim()) return;
  const rows = trimBlank(section.slice(first,divider));
  const data = footer.includes('n to add notes') ? previewRows(rows,chat,footer) : standardRows(rows,chat,tabs.some(t=>t.answered),width);
  if (!data || data.options.filter(o=>o.focused).length!==1 || hasReview!==(tabs.length>1 || data.multiSelect)) return;
  return {kind:'question',tabs,...(tabs.length===1?{activeTab:0}:{}),question,...data,footer};
}
