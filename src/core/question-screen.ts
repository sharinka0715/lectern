import type { NativeQuestionOption, NativeQuestionScreen } from '../shared/native-question';
import { inTranscriptExample } from './dialog-boundary';
import { stripTerminalEscapes, terminalCells } from './screen';

const ruler = /^─{8,}$/u;
// Claude Code wraps by terminal cells. A break between two wide (CJK) characters
// had no space in the original, nor one beside fullwidth punctuation (a long run
// like "对比（ImageGrid" is cut at the edge); a break elsewhere was at a space.
const wide = (char: string | undefined) => !!char && terminalCells(char) === 2;
const cjkPunctuation = /^[　-〿！-／：-＠［-｀｛-･]$/u;
const glued = (a = '', b = '') => wide(a) && wide(b) || cjkPunctuation.test(a) || cjkPunctuation.test(b);
function joinWrapped(parts: string[]) {
  return parts.reduce((text, part) => !text ? part : text + (glued(Array.from(text).at(-1), Array.from(part)[0]) ? '' : ' ') + part, '');
}
// A named session (2.1.329) closes the dialog with its name in a rule below the footer.
const namedRule = /^─{3,} \S(?:.*\S)? ─+$/u;
const numberRow = /^(❯ |  )([1-9]\d*)\. (.+)$/u;
const footerPattern = /^Enter to select · (?:↑\/↓ to navigate|Tab\/Arrow keys to navigate)(?: · n to add notes)?(?: · Tab to switch questions)?(?: · ctrl\+g to edit in [^·]+)? · Esc to cancel$/u;
const trimBlank = (lines: string[]) => {
  let i = 0, j = lines.length;
  while (i < j && !lines[i].trim()) i++;
  while (j > i && !lines[j-1].trim()) j--;
  return lines.slice(i,j);
};
function tabStrip(line: string) {
  const nav = /^←\s+(.+?)\s+✔ Submit\s+→$/u.exec(line.trim());
  const parts = (nav?.[1] ?? line.trim()).split(/\s{2,}(?=[☐☒] )/u);
  const tabs = parts.map(part=>/^([☐☒]) ([^☐☒✔←→]+)$/u.exec(part));
  if ((!nav && parts.length !== 1) || !tabs.length || tabs.some(t=>!t || !t[2].trim())) return;
  return {tabs:tabs.map(t=>({label:t![2].trim(),answered:t![1]==='☒'})),hasReview:!!nav};
}
function review(lines: string[], tabs: NativeQuestionScreen['tabs']): NativeQuestionScreen | undefined {
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
  // Once any question wraps, every question carries a quote bar (" │ ● …",
  // continued by " │   …"; 2.1.300 to 2.1.330); answers stay unbarred ("   → …").
  const barred = rows[i]?.startsWith(' │ ');
  const head = barred ? /^ │ [●⏺] (.+)$/u : /^ [●⏺] (.+)$/u;
  const more = barred ? /^ │ {3}(\S.*)$/u : /^ {3,}(?!→)(\S.*)$/u;
  const answers: NonNullable<NativeQuestionScreen['review']> = [];
  for (; i<end;) {
    const q = head.exec(rows[i++]); if (!q) return;
    const question = [q[1]];
    for (let m; i<end && (m = more.exec(rows[i])); i++) question.push(m[1]);
    const a = /^ {3}→ (.+)$/u.exec(rows[i++] ?? ''); if(!a) return;
    const answer = [a[1]];
    while (i<end && /^ {3,}\S/u.test(rows[i])) answer.push(rows[i++].trim());
    answers.push({question:joinWrapped(question),answer:joinWrapped(answer)});
  }
  if (answers.length!==tabs.filter(t=>t.answered).length || incomplete!==tabs.some(t=>!t.answered)) return;
  return {kind:'review',tabs,activeTab:tabs.length,options,review:answers,footer:''};
}
function standardRows(lines:string[], chat:string, hasAnswer:boolean): Pick<NativeQuestionScreen,'multiSelect'|'options'|'input'> | undefined {
  const options: NativeQuestionOption[] = [];
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
        last.description = joinWrapped([last.description ?? '',line.trim()].filter(Boolean));
      }
    }
  }
  if (options.length<3 || Number(chatRow[2])!==options.length+1 || !!action!==multiSelect
    || (!multiSelect && options.filter(o=>o.checked).length>1)) return;
  // In this layout the final numbered row ABOVE the separator is the custom text field.
  const other = options.at(-1)!;
  if (other.description) return;
  other.kind = 'other';
  const placeholder = multiSelect?'Type something':'Type something.';
  const input = {kind:'other' as const,number:other.number,value:other.label===placeholder?'':other.label,focused:other.focused};
  other.label = placeholder;
  if (action) options.push(action);
  options.push({number:Number(chatRow[2]),kind:'chat',label:'Chat about this',focused:chatRow[1]==='❯ '});
  return {multiSelect,options,input};
}
function previewRows(lines:string[],chat:string,footer:string): Pick<NativeQuestionScreen,'options'|'multiSelect'|'canAmend'|'input'|'preview'> | undefined {
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
/** Only recognize a complete native chooser at the bottom of a *current* viewport.
 * A text-only parse rejects a chooser copied into assistant output. To recognize a
 * genuine chooser after an assistant preamble, the caller must independently verify
 * a pending AskUserQuestion tool_use on the active branch and a waiting native pane.
 */
export function parseQuestionScreen(viewport:string, evidence?:{pendingToolUse:true}): NativeQuestionScreen | undefined {
  let lines = trimBlank(stripTerminalEscapes(viewport).replace(/ /g,' ').split('\n').map(line=>line.trimEnd()));
  if (lines.length && namedRule.test(lines.at(-1)!)) lines = trimBlank(lines.slice(0,-1));
  let start = lines.length - 2;
  while (start >= 0 && !(ruler.test(lines[start]) && tabStrip(lines[start+1]))) start--;
  if (start<0) return;
  const before = lines.slice(0,start);
  const fenced = before.filter(line=>/^\s*(?:[●⏺]\s+)?```/u.test(line)).length%2!==0;
  if (fenced || (inTranscriptExample(before) && !evidence?.pendingToolUse)) return;
  const {tabs,hasReview} = tabStrip(lines[start+1])!;
  const section = trimBlank(lines.slice(start+2));
  if (section[0]==='Review your answers' && hasReview) return review(section,tabs);
  let divider = section.length - 1;
  while (divider >= 0 && !ruler.test(section[divider])) divider--;
  if (divider<0) return;
  const tail = trimBlank(section.slice(divider+1)), chat = tail[0]??'';
  const footer = tail.slice(1).map(line=>line.trim()).filter(Boolean).join(' ');
  if (!footerPattern.test(footer)) return;
  const first = section.findIndex(line=>numberRow.test(line));
  if (first<1 || first>=divider || section[first-1]!=='') return;
  let title = trimBlank(section.slice(0,first));
  // 2.1.329 sets a question that wraps off with a quote bar on each line.
  if (title.length && title.every(line=>line.startsWith('│'))) title = title.map(line=>line.replace(/^│ ?/u,''));
  if (!title.length || title.some(line=>!line.trim() || ruler.test(line) || /^[❯>●⏺│]/u.test(line))) return;
  const rows = trimBlank(section.slice(first,divider));
  const data = footer.includes('n to add notes') ? previewRows(rows,chat,footer) : standardRows(rows,chat,tabs.some(t=>t.answered));
  if (!data || data.options.filter(o=>o.focused).length!==1 || hasReview!==(tabs.length>1 || data.multiSelect)) return;
  return {kind:'question',tabs,...(tabs.length===1?{activeTab:0}:{}),question:joinWrapped(title.map(l=>l.trim())),...data,footer};
}
