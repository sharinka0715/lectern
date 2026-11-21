import type { ConversationTask } from '../shared/types';

const border = /^\s*[─━▔]{5,}(?: .* [─━▔]+)?\s*$/u;
const hint = /\b(?:ctrl\+t|control\+t) to (hide|show) tasks\b/i;

// Claude Code 2.1.329 lists background work below the input box's footer: a
// workflow ("◯ name  ▱▱▱  0/4 · 11s"), the main thread and its subagents
// ("⏺ main", "◯ general-purpose  description  2s"). They belong to neither the
// editor nor its footer, and there can be many of them.
const taskRow = /^ {2,}[◯○◌◉◎●⏺✓✔✗✘] \S/u;
/** The screen without the task rows below the editor (only right below its rule and footer). */
export function withoutTaskRows(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && (!lines[end - 1].trim() || taskRow.test(lines[end - 1]))) end--;
  if (end === lines.length || !lines.slice(end, lines.length).some(line => taskRow.test(line))) return lines;
  return lines.slice(Math.max(0, end - 4), end).some(line => /^\s*[─━]{8,}/u.test(line)) ? lines.slice(0, end) : lines;
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
