import type { ReactNode } from "react";
import type { ToolBlock } from "../shared/types";
import { FileLink, LinkedToolText } from "./ArtifactLinks";
import { ShellCode } from "./ShellCode";
import { t, type MessageKey } from '../shared/i18n';

import type { OpenPath } from './artifact-paths';
type Input = Record<string, unknown>;

const text = (value: unknown) => typeof value === "string" && value.trim() ? value : undefined;
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const labels: Record<string, MessageKey> = {
  command: 'chat.fieldCommand', file_path: 'chat.fieldFile', notebook_path: 'chat.fieldFile', path: 'chat.fieldPath', pattern: 'chat.fieldPattern',
  glob: 'chat.fieldGlob', type: 'chat.fieldType', url: 'chat.fieldUrl', prompt: 'chat.fieldPrompt', query: 'chat.fieldQuery', content: 'chat.fieldContent',
  old_string: 'chat.fieldOld', new_string: 'chat.fieldNew', script: 'chat.fieldScript', skill: 'chat.fieldSkill', args: 'chat.fieldArgs',
  subagent_type: 'chat.fieldAgentType', model: 'chat.fieldModel', description: 'chat.fieldDescription', task_id: 'chat.fieldTask', shell_id: 'chat.fieldTask',
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="tool-field"><span className="tool-field-label">{label}</span><div className="tool-field-value">{children}</div></div>;
}
function Code({ value, onOpen }: { value: string; onOpen: OpenPath }) {
  return <div className="tool-code"><LinkedToolText text={value} onOpen={onOpen} /></div>;
}
function Path({ value, onOpen }: { value: string; onOpen: OpenPath }) {
  return <FileLink path={value} onOpen={onOpen}>{value}</FileLink>;
}
function Chips({ items }: { items: (string | false | undefined)[] }) {
  const shown = items.filter((item): item is string => !!item);
  return shown.length ? <div className="tool-chips">{shown.map(item => <span key={item} className="tool-chip">{item}</span>)}</div> : null;
}
function seconds(ms: unknown) {
  const value = count(ms);
  return value === undefined ? undefined : value >= 60_000 && value % 60_000 === 0 ? t('chat.minutes', { m: value / 60_000 }) : t('chat.secondsDecimal', { s: Math.round(value / 100) / 10 });
}
/** Any other field: short text inline, long text or structures as code. */
function generic(key: string, value: unknown, onOpen: OpenPath) {
  if (value === undefined || value === null || value === "" || value === false) return null;
  const label = Object.hasOwn(labels, key) ? t(labels[key]) : key;
  if (typeof value === "string") return <Field key={key} label={label}>{value.includes("\n") || value.length > 120 ? <Code value={value} onOpen={onOpen} /> : value}</Field>;
  if (typeof value === "number" || typeof value === "boolean") return <Field key={key} label={label}>{String(value)}</Field>;
  return <Field key={key} label={label}><Code value={JSON.stringify(value, null, 2)} onOpen={onOpen} /></Field>;
}

/**
 * A tool call's arguments as the few things worth reading: the command, file,
 * pattern or task, with flags as small chips. Arguments that are not a JSON
 * object (partial or legacy records) stay verbatim.
 */
export function ToolInput({ tool, onOpen }: { tool: ToolBlock; onOpen: OpenPath }) {
  let input: Input | undefined;
  try {
    const value: unknown = JSON.parse(tool.input);
    if (value && typeof value === "object" && !Array.isArray(value)) input = value as Input;
  } catch { /* shown verbatim below */ }
  if (!input) return tool.input.trim() ? <LinkedToolText text={tool.input} onOpen={onOpen} input /> : null;
  const used = new Set<string>();
  const take = (key: string) => { used.add(key); return input![key]; };
  const parts: ReactNode[] = [];
  const caption = text(take("description"));
  if (caption) parts.push(<p key="caption" className="tool-input-caption">{caption}</p>);
  const path = text(take("file_path")) ?? text(take("notebook_path"));
  switch (tool.name) {
    case "Bash": case "PowerShell": case "Monitor": {
      const command = text(take("command"));
      // Commands are coloured; paths in them stay links.
      if (command) parts.push(<div key="command" className="tool-code"><ShellCode text={command} onOpen={onOpen} /></div>);
      const limit = seconds(take("timeout")) ?? seconds(take("timeout_ms"));
      parts.push(<Chips key="flags" items={[take("run_in_background") === true && t('chat.runInBackground'), tool.name === "Monitor" && t('chat.persistentWatch'),
        limit && t('chat.timeLimit', { limit }),
        take("dangerouslyDisableSandbox") === true && t('chat.noSandbox'), take("persistent") === true && t('chat.persistent')]} />);
      break;
    }
    case "Read": {
      const offset = count(take("offset")), limit = count(take("limit")), pages = text(take("pages"));
      if (path) parts.push(<Field key="path" label={t('chat.fieldFile')}><Path value={path} onOpen={onOpen} /></Field>);
      parts.push(<Chips key="range" items={[offset !== undefined && limit !== undefined ? t('chat.lineRange', { from: offset, to: offset + limit - 1 })
        : offset !== undefined ? t('chat.fromLine', { line: offset }) : limit !== undefined ? t('chat.firstLines', { count: limit }) : undefined, pages && t('chat.pages', { pages })]} />);
      break;
    }
    case "Write": {
      if (path) parts.push(<Field key="path" label={t('chat.fieldFile')}><Path value={path} onOpen={onOpen} /></Field>);
      const content = text(take("content"));
      if (content) parts.push(<Code key="content" value={content} onOpen={onOpen} />);
      break;
    }
    case "Edit": case "MultiEdit": case "NotebookEdit": {
      if (path) parts.push(<Field key="path" label={t('chat.fieldFile')}><Path value={path} onOpen={onOpen} /></Field>);
      const before = text(take("old_string")), after = text(take("new_string")) ?? text(take("new_source"));
      if (before) parts.push(<Field key="before" label={t('chat.fieldOld')}><Code value={before} onOpen={onOpen} /></Field>);
      if (after) parts.push(<Field key="after" label={t('chat.fieldNew')}><Code value={after} onOpen={onOpen} /></Field>);
      const edits = take("edits");
      if (Array.isArray(edits)) parts.push(<Chips key="edits" items={[t('chat.editCount', { count: edits.length })]} />);
      parts.push(<Chips key="all" items={[take("replace_all") === true && t('chat.replaceAll')]} />);
      break;
    }
    case "Glob": case "Grep": {
      const pattern = text(take("pattern"));
      if (pattern) parts.push(<Field key="pattern" label={t('chat.fieldPattern')}><code className="tool-inline-code">{pattern}</code></Field>);
      const where = text(take("path"));
      if (where) parts.push(<Field key="path" label={t('chat.fieldPath')}><Path value={where} onOpen={onOpen} /></Field>);
      const mode = text(take("output_mode"));
      const modes: Record<string, MessageKey> = { content: 'chat.modeContent', files_with_matches: 'chat.modeFiles', count: 'chat.modeCount' };
      parts.push(<Chips key="flags" items={[text(take("glob")) && t('chat.globChip', { glob: String(input.glob) }), text(take("type")) && t('chat.typeChip', { type: String(input.type) }),
        mode && Object.hasOwn(modes, mode) && t(modes[mode]), take("-i") === true && t('chat.ignoreCase'),
        take("multiline") === true && t('chat.multiline'), count(take("head_limit")) !== undefined && t('chat.headLimit', { count: Number(input.head_limit) }),
        count(take("-C") ?? take("context")) !== undefined && t('chat.contextLines', { count: Number(input["-C"] ?? input.context) })]} />);
      for (const key of ["-n", "-A", "-B", "-C", "context", "offset"]) used.add(key);
      break;
    }
    case "WebFetch": case "WebSearch": {
      const url = text(take("url")), query = text(take("query"));
      if (url) parts.push(<Field key="url" label={t('chat.fieldUrl')}><span className="tool-url">{url}</span></Field>);
      if (query) parts.push(<Field key="query" label={t('chat.fieldQuery')}>{query}</Field>);
      const prompt = text(take("prompt"));
      if (prompt) parts.push(<Field key="prompt" label={t('chat.fieldGist')}>{prompt}</Field>);
      break;
    }
    case "Agent": case "Task": {
      parts.push(<Chips key="kind" items={[text(take("subagent_type")), text(take("model")) && t('chat.modelChip', { model: String(input.model) }),
        take("run_in_background") === true && t('chat.runInBackground'), text(take("isolation")) && t('chat.isolationChip', { isolation: String(input.isolation) })]} />);
      const prompt = text(take("prompt"));
      if (prompt) parts.push(<Field key="prompt" label={t('chat.fieldPrompt')}><div className="tool-prose">{prompt}</div></Field>);
      break;
    }
    case "TodoWrite": {
      const todos = take("todos");
      if (Array.isArray(todos)) parts.push(<ul key="todos" className="tool-todos">{todos.map((todo, index) => {
        const item = todo as Input, status = text(item.status) ?? "pending";
        return <li key={index} data-status={status}>{text(item.content) ?? text(item.subject) ?? JSON.stringify(item)}</li>;
      })}</ul>);
      break;
    }
  }
  for (const [key, value] of Object.entries(input)) if (!used.has(key)) parts.push(generic(key, value, onOpen));
  return <div className="tool-input">{parts}</div>;
}
