// A small shell tokenizer for showing commands: enough to colour the parts a
// reader looks for (the command, its flags, variables, strings, operators),
// not a parser. The tokens always join back to the original text.

export type ShellTokenKind = "command" | "keyword" | "flag" | "variable" | "string" | "operator" | "comment" | "number" | "assign";
export interface ShellToken { text: string; kind?: ShellTokenKind }

/** Words that keep (or start) a command position after them. */
const leading = new Set(["if", "then", "else", "elif", "do", "while", "until", "time", "{", "!"]);
const keywords = new Set([...leading, "fi", "for", "done", "case", "esac", "in", "function", "select", "}", "return", "export", "local", "readonly", "declare"]);
// Shell metacharacters end a word; quotes and $ start pieces inside one.
const delimiter = /[\s;&|()<>`]/u;
const operator = /^(?:&&|\|\||;;|\|&|[;&|()`])/u;
const redirect = /^(?:\d*(?:>>|>\||<<<|<<-?|&>>?|[<>]&-?\d*|[<>]))/u;
const variable = /^\$(?:\{[^}\n]*\}?|[A-Za-z_][A-Za-z0-9_]*|[0-9?$!#@*-])/u;
/** Commands that run the next word as a command. */
const plainCommands = new Set(["sudo", "nohup", "env", "xargs", "exec", "command", "builtin", "nice", "timeout", "watch"]);

/** The end of a quoted string starting at `start` (the closing quote included, or the end of text). */
function quoteEnd(text: string, start: number) {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (quote === '"' && text[i] === "\\") { i++; continue; }
    if (text[i] === quote) return i + 1;
  }
  return text.length;
}

/** A double-quoted string, with its $variables picked out. */
function doubleQuoted(value: string, out: ShellToken[]) {
  let last = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "\\") { i++; continue; }
    if (value[i] !== "$") continue;
    const match = variable.exec(value.slice(i));
    if (!match) continue;
    if (i > last) out.push({ text: value.slice(last, i), kind: "string" });
    out.push({ text: match[0], kind: "variable" });
    last = i + match[0].length;
    i = last - 1;
  }
  if (last < value.length) out.push({ text: value.slice(last), kind: "string" });
}

export function shellTokens(text: string): ShellToken[] {
  const out: ShellToken[] = [];
  const push = (value: string, kind?: ShellTokenKind) => {
    if (!value) return;
    const previous = out.at(-1);
    if (previous && previous.kind === kind) previous.text += value;
    else out.push(kind ? { text: value, kind } : { text: value });
  };
  // `wrapper`: the last word was sudo, timeout, …: its own flags and numbers come before the command.
  let commandPosition = true, wrapper = false, i = 0;
  while (i < text.length) {
    const rest = text.slice(i), char = text[i];
    if (char === "\n") { push(char); commandPosition = true; i++; continue; }
    if (/\s/u.test(char)) { const run = /^[^\S\n]+/u.exec(rest)![0]; push(run); i += run.length; continue; }
    if (char === "\\" && text[i + 1] === "\n") { push("\\\n"); i += 2; continue; }
    if (char === "#") { const line = /^[^\n]*/u.exec(rest)![0]; push(line, "comment"); i += line.length; continue; }
    if (rest.startsWith("$(")) { push("$(", "operator"); commandPosition = true; i += 2; continue; }
    const redirection = redirect.exec(rest);
    const op = redirection ? undefined : operator.exec(rest);
    if (op || redirection) {
      const value = (redirection ?? op)![0];
      push(value, "operator"); i += value.length;
      // After a separator or pipe a new command starts; a redirection's target follows.
      if (op) commandPosition = value !== ")";
      continue;
    }
    // A word: bare runs, quoted strings and variables until a metacharacter.
    let end = i;
    while (end < text.length && !delimiter.test(text[end])) {
      if (end > i && text.startsWith("$(", end)) break;
      if (text[end] === "\\") end += 2;
      else if (text[end] === "'" || text[end] === '"') end = quoteEnd(text, end);
      else end++;
    }
    end = Math.min(end, text.length);
    const word = text.slice(i, end);
    const assignment = commandPosition && /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/u.exec(word);
    let kind: ShellTokenKind | undefined;
    if (commandPosition && keywords.has(word)) kind = "keyword";
    else if (assignment) kind = "assign";
    else if (wrapper && word.startsWith("-")) kind = "flag";
    else if (wrapper && /^\d+(?:\.\d+)?[smhd]?$/u.test(word)) kind = "number";
    else if (commandPosition) kind = "command";
    else if (word.startsWith("-")) kind = "flag";
    else if (/^\d+(?:\.\d+)?$/u.test(word)) kind = "number";
    // The first bare run carries the word's role (up to "=" for an assignment or a flag).
    let first = true, j = 0;
    while (j < word.length) {
      const piece = word.slice(j);
      if (piece[0] === "'" || piece[0] === '"') {
        const close = quoteEnd(word, j) - j, value = piece.slice(0, close);
        if (piece[0] === '"') doubleQuoted(value, out); else push(value, "string");
        j += close; first = false; continue;
      }
      const name = piece[0] === "$" ? variable.exec(piece) : undefined;
      if (name) { push(name[0], "variable"); j += name[0].length; first = false; continue; }
      let run = /^(?:\\.|[^'"$\\])+|^[$\\]/su.exec(piece)![0];
      if (first && (kind === "assign" || kind === "flag") && run.includes("=")) run = run.slice(0, run.indexOf("=") + 1);
      push(run, first ? (kind === "assign" ? "assign" : kind) : undefined);
      j += run.length; first = false;
    }
    if (wrapper && (kind === "flag" || kind === "number")) { i = end; continue; }
    wrapper = kind === "command" && plainCommands.has(word);
    if (kind === "keyword") commandPosition = leading.has(word);
    else if (kind === "assign") commandPosition = true;
    else if (kind === "command") commandPosition = plainCommands.has(word);
    i = end;
  }
  return out;
}
