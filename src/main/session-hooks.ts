import type { DialogHookObservation, DialogHookRecord, DialogHookStatus } from '../shared/dialog-hooks';
import type { ChatMessage, ToolBlock } from '../shared/types';
import { askedQuestions, type AskedQuestion } from '../core/question-hook';

/** Hook data counts only once SessionStart showed the hooks run in this process and while the
 * launch's folder is there; otherwise every card is read off the screen as without hooks. */
export const hooksLive = (hooks: DialogHookObservation | undefined): hooks is DialogHookObservation => !!hooks?.started && hooks.folder;

/** The hooks' state for the settings page and diagnostics. */
export function dialogHookStatus(enabled: boolean, hooks: DialogHookObservation | undefined, active: boolean): DialogHookStatus {
  if (hooks?.started && hooks.folder) return { state: 'active', since: hooks.started.at, ...hooks.last && { last: hooks.last } };
  if (hooks && !hooks.folder) return { state: 'unavailable', reason: 'no-folder' };
  if (hooks) return { state: 'waiting' };
  return active && enabled ? { state: 'unavailable', reason: 'not-launched' } : { state: 'off' };
}

/** Stable JSON of a value: object keys sorted, for comparing a hook's input with the transcript's. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const resolved = (tool: ToolBlock) => tool.result !== undefined || !!tool.isError;
function findTool(messages: ChatMessage[], id: string): ToolBlock | undefined {
  for (let i = messages.length - 1; i >= 0; i--) for (const tool of messages[i].tools) if (tool.id === id) return tool;
}
const newest = (records: DialogHookRecord[], test: (record: DialogHookRecord) => boolean) => {
  for (let i = records.length - 1; i >= 0; i--) if (test(records[i])) return records[i];
};

/** The AskUserQuestion call the question dialog asks, by its PreToolUse hook: the newest one of the
 * main conversation, while the transcript has no result for it (written or not yet). */
export function hookQuestionCall(hooks: DialogHookObservation | undefined, messages: ChatMessage[]): { toolUseId: string; asked: AskedQuestion[] } | undefined {
  if (!hooksLive(hooks)) return;
  const record = newest(hooks.records, r => r.event === 'PreToolUse' && r.toolName === 'AskUserQuestion' && !r.agentId);
  const asked = record?.toolUseId ? askedQuestions(record.input) : undefined;
  if (!record?.toolUseId || !asked) return;
  const tool = findTool(messages, record.toolUseId);
  return tool && resolved(tool) ? undefined : { toolUseId: record.toolUseId, asked };
}

function inputKey(input: string): string | undefined {
  try { return canonical(JSON.parse(input)); } catch { return; }
}
/** The current turn's tool calls (after the last prompt), newest last. */
function turnCalls(messages: ChatMessage[]): ToolBlock[] {
  const calls: ToolBlock[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    // A send the transcript has not confirmed is not a new turn yet (pendingQuestionId).
    if (messages[i].role === 'user' && messages[i].source === 'pending') continue;
    if (messages[i].role === 'user') break;
    calls.unshift(...messages[i].tools);
  }
  return calls;
}

/** A permission dialog's call by its PermissionRequest hook, which has no tool_use_id. */
export interface HookPermission { toolName: string; input: Record<string, unknown>; toolUseId?: string }
/**
 * The call a tool's permission dialog asks about, by the newest PermissionRequest hook of all (a
 * subagent's request is the dialog then: none here), while no tool call has started since and the
 * call has no result: bound to the call by the PreToolUse hook of the same tool and input when
 * there is one, else by the transcript's unanswered call of the current turn with that input
 * (none yet: Claude Code writes it later). A request whose call the transcript already answered
 * is an old one. Whether the dialog on screen is this call is checked against the screen too
 * (core/permission-hook.ts).
 */
export function hookPermissionCall(hooks: DialogHookObservation | undefined, messages: ChatMessage[]): HookPermission | undefined {
  if (!hooksLive(hooks)) return;
  const request = newest(hooks.records, r => r.event === 'PermissionRequest');
  if (!request || request.agentId || !request.toolName || !request.input || request.toolName === 'AskUserQuestion') return;
  if (hooks.records.some(r => r.event === 'PreToolUse' && !r.agentId && r.seq > request.seq)) return;
  const key = canonical(request.input);
  const pre = newest(hooks.records, r => r.event === 'PreToolUse' && !r.agentId && r.seq < request.seq
    && r.toolName === request.toolName && canonical(r.input) === key);
  const same = turnCalls(messages).filter(tool => tool.name === request.toolName && inputKey(tool.input) === key);
  let toolUseId = pre?.toolUseId;
  if (toolUseId) {
    const tool = findTool(messages, toolUseId);
    if (tool && resolved(tool)) return;
  } else {
    const open = same.filter(tool => !resolved(tool));
    if (!open.length && same.length) return;
    toolUseId = open.at(-1)?.id;
  }
  return { toolName: request.toolName, input: request.input, ...toolUseId && { toolUseId } };
}
