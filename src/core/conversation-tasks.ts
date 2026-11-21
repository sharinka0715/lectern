import type { ConversationTask } from '../shared/types';
import type { TranscriptChange, TranscriptRow } from './transcript-store';

type Fields = Record<string, unknown>;
function fields(value: unknown): Fields {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Fields : {};
}
function status(value: unknown): ConversationTask['status'] | undefined {
  if (value === 'pending' || value === 'in_progress' || value === 'completed') return value;
}

/** 来自整表回执、原生提醒或 compact 快照。损坏的列表不覆盖已有任务。 */
export function readTaskList(value: unknown): ConversationTask[] | undefined {
  if (!Array.isArray(value)) return;
  const tasks: ConversationTask[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const item = fields(entry);
    const title = item.subject ?? item.content;
    const state = status(item.status);
    const id = item.id ?? String(tasks.length + 1);
    if (typeof id !== 'string' || !id || seen.has(id) || !state || typeof title !== 'string' || !title.trim()) return;
    seen.add(id);
    tasks.push({ id, title, status: state });
  }
  return tasks;
}

const taskTools = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TodoWrite', 'mcp__ccd_turn__update_plan', 'mcp__ccd_turn__wrap_up']);
interface PendingCall { name: string; input: Fields }

/** 对当前分支按工具回执顺序更新，原生 taskId 和 tool_use_id 各自有独立用途。 */
export class ConversationTasks {
  private items = new Map<string, ConversationTask>();
  private pending = new Map<string, PendingCall>();
  private desktopPlan = false;

  get list() { return [...this.items.values()]; }
  private replace(tasks: ConversationTask[], desktop = false) {
    this.items = new Map(tasks.map(task => [task.id, task]));
    this.desktopPlan = desktop;
  }
  private update(id: string, next: Partial<Pick<ConversationTask, 'title' | 'status'>>) {
    const task = this.items.get(id);
    if (task) this.items.set(id, { ...task, ...next });
  }
  private plan(input: Fields) {
    const list = readTaskList(input.items);
    if (list) { this.replace(list, true); return; }
    if (!this.desktopPlan) return;
    if (Array.isArray(input.done)) for (const index of input.done) this.update(String(index), { status: 'completed' });
    if (input.start !== undefined) this.update(String(input.start), { status: 'in_progress' });
    if (input.advance === true) {
      const active = this.list.find(task => task.status === 'in_progress');
      if (active) this.update(active.id, { status: 'completed' });
      const next = this.list.find(task => task.status === 'pending');
      if (next) this.update(next.id, { status: 'in_progress' });
    }
  }
  private finish({ name, input }: PendingCall, text: string) {
    if (name === 'mcp__ccd_turn__update_plan') { this.plan(input); return; }
    if (name === 'mcp__ccd_turn__wrap_up') {
      if (this.desktopPlan && input.blocked !== true) for (const task of this.items.values()) this.update(task.id, { status: 'completed' });
      return;
    }
    if (name === 'TodoWrite') {
      const list = readTaskList(input.todos);
      if (list) this.replace(list);
      return;
    }
    if (name === 'TaskCreate') {
      const created = /^Task #(\d+) created successfully: ([\s\S]+)$/.exec(text.trim());
      if (created) {
        if (this.desktopPlan) this.replace([]);
        this.items.set(created[1], { id: created[1], title: created[2], status: 'pending' });
      }
      return;
    }
    if (name === 'TaskUpdate') {
      const id = /^Updated task #(\d+)\b/.exec(text)?.[1];
      if (!id || String(input.taskId) !== id) return;
      if (input.status === 'deleted') { this.items.delete(id); return; }
      const state = status(input.status);
      this.update(id, { ...(state && {status: state}), ...(typeof input.subject === 'string' && input.subject.trim() && {title: input.subject}) });
      return;
    }
    if (name === 'TaskList') {
      if (text.trim() === 'No tasks found') { this.items.clear(); return; }
      const rows = text.trim().split('\n').map(line => /^#(\d+) \[(pending|in_progress|completed)\] (.+)$/.exec(line));
      const list = readTaskList(rows.map(match => match && {id: match[1], status: match[2], subject: match[3]}));
      if (list) this.replace(list);
    }
  }
  apply(change: TranscriptChange) {
    if (change.replace) { this.items.clear(); this.pending.clear(); this.desktopPlan = false; }
    let checkpoint: TranscriptRow | undefined;
    for (const row of change.rows) if (row.kind === 'compact' && row.taskList !== undefined) checkpoint = row;
    if (checkpoint?.taskList) this.replace(checkpoint.taskList);
    for (const row of change.rows) {
      if (checkpoint && (row.order <= checkpoint.order || change.preserved.has(row.key))) continue;
      if (row.taskList) this.replace(row.taskList);
      for (const tool of row.tools ?? []) {
        if (!taskTools.has(tool.name)) continue;
        try { this.pending.set(tool.id, {name: tool.name, input: fields(JSON.parse(tool.input))}); } catch { /* 等待完整工具输入。 */ }
      }
      for (const result of row.results ?? []) {
        const call = this.pending.get(result.id);
        if (!call) continue;
        this.pending.delete(result.id);
        if (!result.isError) this.finish(call, result.result);
      }
    }
  }
}
