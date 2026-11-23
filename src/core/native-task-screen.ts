import type { ConversationTask } from '../shared/types';
import { namedEditorBorder } from './editor-border';

const plainBorder = /^\s*[─━▔]{5,}(?: .* [─━▔]+)?\s*$/u;
// A session name of any width in the input box's upper border (editor-border.ts).
const border = { test: (line: string) => plainBorder.test(line) || namedEditorBorder.test(line) };
const hint = /\b(?:ctrl\+t|control\+t) to (hide|show) tasks\b/i;

// Claude Code 2.1.329 lists background work below the input box's footer: a
// workflow ("◯ name  ▱▱▱  0/4 · 11s"), the main thread and its subagents
// ("⏺ main", "◯ general-purpose  description  2s"). They belong to neither the
// editor nor its footer, and there can be many of them.
// The effort label ("◉ xhigh · /effort", right-aligned above the input box) starts like
// a task row but is never one. With more than fit (2.1.330: main and five subagents),
// "↓ 7 more" closes the list. The guard on the target (composer-frame-guard.ts,
// taskRowsGuard) checks the same three forms.
const taskRow = /^ {2,}[◯○◌◉◎●⏺✓✔✗✘] \S/u;
const effortLabel = /·\s*\/effort\s*$/u;
const overflowRow = /^ {2,}[↑↓] \d+ more\s*$/u;
const isTaskRow = (line: string) => taskRow.test(line) && !effortLabel.test(line);
const inTaskList = (line: string) => !line.trim() || isTaskRow(line) || overflowRow.test(line);
/** Where the trailing run of task rows (with blank and "↓ N more" rows) starts, or
 * `lines.length` when that run has no task row. Only for rows known to sit below an editor. */
export function trailingTaskRows(lines: string[]): number {
  let end = lines.length;
  while (end > 0 && inTaskList(lines[end - 1])) end--;
  return lines.slice(end).some(isTaskRow) ? end : lines.length;
}
/** Where the task rows below the editor start (only right below its rule and footer), or `lines.length`. */
export function taskRowsStart(lines: string[]): number {
  const end = trailingTaskRows(lines);
  return end < lines.length && lines.slice(Math.max(0, end - 4), end).some(line => /^\s*[─━]{8,}/u.test(line)) ? end : lines.length;
}
/** The screen without the task rows below the editor (only right below its rule and footer). */
export function withoutTaskRows(lines: string[]): string[] {
  const end = taskRowsStart(lines);
  return end === lines.length ? lines : lines.slice(0, end);
}

// 独立的页脚快捷键和原生编辑框可将原生任务面板与回复中的同形文本区分开。
// 页脚从输入框下边框数起：下方列出的后台任务行先去掉（多了会把边框挤出页脚的行数上限）。
export function nativeTaskPanel(pane: string[]) {
  const lines = withoutTaskRows(pane);
  let end = lines.length - 1;
  while (end >= 0 && !lines[end].trim()) end--;
  let bottom = end;
  while (bottom >= 0 && end - bottom <= 5 && !border.test(lines[bottom])) bottom--;
  if (bottom < 2 || !border.test(lines[bottom])) return;
  const mode = hint.exec(lines.slice(bottom + 1,end + 1).join('\n'))?.[1];
  if (!mode) return;
  let top = bottom - 1;
  while (top >= 0 && !border.test(lines[top])) top--;
  if (top < 0 || !/^\s*❯/u.test(lines[top+1])) return;
  if (mode === 'show') return { visible: false };
  for (let i = top-1; i >= Math.max(0, top-220); i--) {
    if (border.test(lines[i]) || /^\s*[❯⏺●]/u.test(lines[i])) break;
    const header = /^\s+(\d+)\/(\d+) tasks? done\b/iu.exec(lines[i]);
    if (!header) continue;
    const tasks: ConversationTask[] = [];
    for (const line of lines.slice(i+1,top)) {
      const item = /^\s+([✔◼◻])\s+(.+)$/u.exec(line.trimEnd());
      if (!item) break;
      tasks.push({id:`screen-${tasks.length}`,title:item[2],status:item[1]==='✔'?'completed':item[1]==='◼'?'in_progress':'pending'});
    }
    if (tasks.length) return {visible:true,start:i, tasks:tasks.length===Number(header[2]) ? tasks : undefined};
  }
}
