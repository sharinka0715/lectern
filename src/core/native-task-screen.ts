import type { ConversationTask } from '../shared/types';

const border = /^\s*[─━▔]{5,}(?: .* [─━▔]+)?\s*$/u;
const hint = /\b(?:ctrl\+t|control\+t) to (hide|show) tasks\b/i;

// 独立的页脚快捷键和原生编辑框可将原生任务面板与回复中的同形文本区分开。
export function nativeTaskPanel(lines: string[]) {
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
