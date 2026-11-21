/**
 * Where a shell command sends its output, read from the command text alone:
 * `> f`, `>> f`, `&> f`, `2>&1 > f`, `exec > f`, `| tee f`, with `cd dir`
 * before them changing what a relative name means. Only literal names count:
 * a target with a variable, a command substitution or a glob is unknown, and
 * /dev/* (`2>/dev/null`, `>&2`) is never an output file. Heredoc bodies,
 * comments and quoted text are skipped, so a `>` in them is not a redirect.
 */
export type RedirectStream = 'stdout' | 'stderr' | 'both';
export interface OutputRedirect {
  /** As written (quotes removed); may be relative or start with `~/`. */
  path: string;
  /** The `cd` chain in effect before the command ('' when none); undefined when a `cd` target is unknown. */
  dir?: string;
  stream: RedirectStream;
  append: boolean;
  tee?: true;
}

type Token = { kind: 'word'; text: string; literal: boolean } | { kind: 'op'; op: string } | { kind: 'redir'; op: string; fd?: number };

const META = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);

/** Splits a command into words, operators and redirections (heredoc bodies dropped). */
function lex(source: string): Token[] {
  const tokens: Token[] = [];
  const heredocs: { delimiter: string; tabs: boolean }[] = [];
  let i = 0;
  const skipHeredocs = () => {
    // The bodies start on the line after the operator: drop them up to their delimiter lines.
    for (const doc of heredocs.splice(0)) {
      while (i < source.length) {
        const end = source.indexOf('\n', i), line = source.slice(i, end < 0 ? source.length : end);
        i = end < 0 ? source.length : end + 1;
        if ((doc.tabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) break;
      }
    }
  };
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '\\' && source[i + 1] === '\n') { i += 2; continue; }
    if (c === '#') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (c === '\n') { tokens.push({ kind: 'op', op: '\n' }); i++; skipHeredocs(); continue; }
    if (c === '&' || c === '|' || c === ';') {
      const two = source.slice(i, i + 2), three = source.slice(i, i + 3);
      if (three === '&>>') { tokens.push({ kind: 'redir', op: '&>>' }); i += 3; continue; }
      if (two === '&>') { tokens.push({ kind: 'redir', op: '&>' }); i += 2; continue; }
      const op = ['&&', '||', '|&', ';;'].includes(two) ? two : c;
      tokens.push({ kind: 'op', op }); i += op.length; continue;
    }
    if (c === '(' || c === ')') { tokens.push({ kind: 'op', op: c }); i++; continue; }
    // Process substitution, >(...) or <(...): a word, not a redirection.
    if ((c === '<' || c === '>') && source[i + 1] === '(') { const end = skipParens(source, i + 1); tokens.push({ kind: 'word', text: source.slice(i, end), literal: false }); i = end; continue; }
    if (c === '<' || c === '>') { i = redirection(source, i, tokens, heredocs); continue; }
    // A number directly before < or > names the descriptor (2>, 1>>).
    const digits = /^\d+(?=[<>])/.exec(source.slice(i, i + 12));
    if (digits && source[i + digits[0].length + 1] !== '(') { i = redirection(source, i + digits[0].length, tokens, heredocs, Number(digits[0])); continue; }
    const [word, end] = readWord(source, i);
    tokens.push(word); i = end;
  }
  return tokens;
}

function redirection(source: string, i: number, tokens: Token[], heredocs: { delimiter: string; tabs: boolean }[], fd?: number) {
  const op = ['<<<', '<<-', '&>>'].find(o => source.startsWith(o, i)) ?? ['>>', '>|', '>&', '<<', '<&', '<>'].find(o => source.startsWith(o, i)) ?? source[i];
  i += op.length;
  tokens.push({ kind: 'redir', op, ...(fd !== undefined && { fd }) });
  if (op === '<<' || op === '<<-') {
    while (source[i] === ' ' || source[i] === '\t') i++;
    const [word, end] = readWord(source, i);
    // The delimiter is the word with its quotes removed.
    if (word.kind === 'word' && word.text) heredocs.push({ delimiter: word.text, tabs: op === '<<-' });
    if (word.kind === 'word') tokens.push({ ...word, literal: false });
    return end;
  }
  return i;
}

/** The end of a parenthesised group starting at `start` ('('), with quotes and nesting. */
function skipParens(source: string, start: number) {
  let depth = 0, i = start;
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { const end = source.indexOf("'", i + 1); i = end < 0 ? source.length : end + 1; continue; }
    if (c === '"') { i = skipDouble(source, i); continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
    i++;
  }
  return source.length;
}

/** The index after the double-quoted string starting at `start`. */
function skipDouble(source: string, start: number) {
  let i = start + 1;
  while (i < source.length && source[i] !== '"') {
    if (source[i] === '\\') i++;
    else if (source[i] === '$' && source[i + 1] === '(') { i = skipParens(source, i + 1); continue; }
    else if (source[i] === '`') { const end = source.indexOf('`', i + 1); i = end < 0 ? source.length : end; }
    i++;
  }
  return i + 1;
}

const ANSI_C: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v' };
const HOME_VARIABLE = /^\$(?:HOME\b|\{HOME\})/;

/** One word from `start`: its text without quotes, and whether it is literal (no expansion or glob). */
function readWord(source: string, start: number): [Extract<Token, { kind: 'word' }>, number] {
  let i = start, text = '', literal = true, braces = false;
  while (i < source.length && !META.has(source[i])) {
    const c = source[i];
    if (c === "'") {
      const end = source.indexOf("'", i + 1);
      text += source.slice(i + 1, end < 0 ? source.length : end);
      i = end < 0 ? source.length : end + 1;
    } else if (c === '$' && source[i + 1] === "'") {
      i += 2;
      while (i < source.length && source[i] !== "'") {
        if (source[i] === '\\' && i + 1 < source.length) { text += ANSI_C[source[i + 1]] ?? '\\' + source[i + 1]; i += 2; } else text += source[i++];
      }
      i++;
    } else if (c === '"') {
      const end = skipDouble(source, i);
      // "$HOME/…" at the start is the home directory too.
      const raw = source.slice(i + 1, end - 1), inner = i === start ? raw.replace(HOME_VARIABLE, '~') : raw;
      if (/(?<!\\)[$`]/.test(inner)) literal = false;
      text += inner.replace(/\\([$`"\\\n])/g, (_, ch: string) => ch === '\n' ? '' : ch);
      i = end;
    } else if (c === '\\') {
      text += source[i + 1] ?? ''; i += 2;
    } else if (c === '$' && i === start && HOME_VARIABLE.test(source.slice(i))) {
      // $HOME or ${HOME} at the start: the home directory, like ~.
      text += '~'; i += source[i + 1] === '{' ? 7 : 5;
    } else if (c === '$' || c === '`') {
      literal = false;
      if (source[i + 1] === '(') i = skipParens(source, i + 1);
      else if (source[i + 1] === '{') { const end = source.indexOf('}', i); i = end < 0 ? source.length : end + 1; }
      else if (c === '`') { const end = source.indexOf('`', i + 1); i = end < 0 ? source.length : end + 1; }
      else { i++; while (i < source.length && /[\w@*#?$!-]/.test(source[i])) { i++; if (!/\w/.test(source[i - 1])) break; } }
    } else {
      if (c === '*' || c === '?' || c === '[') literal = false;
      if (c === '{') braces = true;
      if (c === '~' && i === start && !(source[i + 1] === undefined || source[i + 1] === '/' || META.has(source[i + 1]))) literal = false;
      text += c; i++;
    }
  }
  // Brace expansion ({a,b}, {1..3}) names several files.
  if (braces && /\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(text)) literal = false;
  return [{ kind: 'word', text, literal }, i];
}

interface Redirect { op: string; fd?: number; target?: Extract<Token, { kind: 'word' }> }
type Word = Extract<Token, { kind: 'word' }>;
const PREFIXES = new Set(['sudo', 'command', 'builtin', 'nohup', 'time', 'exec', 'env', 'stdbuf']);
const device = (path: string) => /^\/dev(?:\/|$)/.test(path);

/** The `cd` chain after `cd <arg>`: undefined when the target cannot be known. */
function changeDir(dir: string | undefined, args: Word[]): string | undefined {
  const operands = args.filter(arg => !(arg.literal && /^-[LPe@]+$/.test(arg.text)));
  if (!operands.length) return '~';
  if (operands.length > 1 || !operands[0].literal || operands[0].text === '-' || dir === undefined) return undefined;
  const target = operands[0].text;
  return target.startsWith('/') || target === '~' || target.startsWith('~/') || !dir ? target : `${dir}/${target}`;
}

/** Every file the command writes its output to, in order. */
export function outputRedirects(command: string): OutputRedirect[] {
  if (typeof command !== 'string' || !command || command.length > 64 * 1024) return [];
  const found: OutputRedirect[] = [];
  // The cd chain of each nesting level: a subshell's cd ends with it, a { } group's does not.
  const scopes: (string | undefined)[] = [''];
  // A { } group's redirections apply before it runs: relative to the directory it started in.
  const braces: (string | undefined)[] = [];
  let group: { dir: string | undefined } | undefined;
  let words: Word[] = [], redirects: Redirect[] = [];
  const add = (path: string, stream: RedirectStream, append: boolean, tee?: true) => {
    const dir = group ? group.dir : scopes.at(-1);
    const same = found.find(item => item.path === path && item.dir === dir);
    if (same) { if (same.stream !== stream) same.stream = 'both'; same.append &&= append; return; }
    found.push({ path, dir, stream, append, ...(tee && { tee }) });
  };
  const flush = () => {
    let argv = words.filter(word => !(word.literal && (word.text === '{' || word.text === '}')));
    while (argv.length && argv[0].literal && /^[A-Za-z_]\w*=/.test(argv[0].text)) argv = argv.slice(1);
    const name = argv[0]?.literal ? argv[0].text : undefined;
    if (name === 'cd' || name === 'pushd') scopes[scopes.length - 1] = name === 'pushd' && argv.length === 1 ? undefined : changeDir(scopes.at(-1), argv.slice(1));
    else if (name === 'popd') scopes[scopes.length - 1] = undefined;
    redirect(redirects, add);
    group = undefined;
    tee(argv, add);
    words = []; redirects = [];
  };
  const tokens = lex(command);
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    if (token.kind === 'word') {
      if (!words.length && token.literal && token.text === '{') braces.push(scopes.at(-1));
      else if (!words.length && token.literal && token.text === '}' && braces.length) group = { dir: braces.pop() };
      words.push(token);
      continue;
    }
    if (token.kind === 'redir') {
      const next = tokens[k + 1];
      redirects.push({ op: token.op, fd: token.fd, target: next?.kind === 'word' ? next : undefined });
      if (next?.kind === 'word') k++;
      continue;
    }
    flush();
    if (token.op === '(') scopes.push(scopes.at(-1));
    else if (token.op === ')' && scopes.length > 1) scopes.pop();
  }
  flush();
  return found;
}

type Add = (path: string, stream: RedirectStream, append: boolean, tee?: true) => void;

/** Applies one command's redirections in order, as the shell does: `> f 2>&1` sends
 * both streams to f, `2>&1 > f` only stdout. A file left with neither stream is skipped. */
function redirect(redirects: Redirect[], add: Add) {
  type Sink = { file?: string; append?: boolean } | 'task' | 'other';
  const fds = new Map<number, Sink>([[1, 'task'], [2, 'task']]);
  for (const { op, fd, target } of redirects) {
    if (op.startsWith('<') && op !== '<>') continue;
    const text = target?.literal ? target.text : undefined;
    if ((op === '>&' || op === '<>') && text !== undefined && (/^\d+$/.test(text) || text === '-')) {
      // A duplicate (2>&1) or a close (>&-).
      fds.set(fd ?? 1, text === '-' ? 'other' : fds.get(Number(text)) ?? 'other');
      continue;
    }
    const sink: Sink = text === undefined || !text || device(text) ? 'other' : { file: text, append: op === '>>' || op === '&>>' };
    if (op === '&>' || op === '&>>' || op === '>&' && fd === undefined) { fds.set(1, sink); fds.set(2, sink); }
    else fds.set(fd ?? (op === '<>' ? 0 : 1), sink);
  }
  const out = fds.get(1), err = fds.get(2);
  const files = [out, err].filter((sink): sink is { file: string; append?: boolean } => typeof sink === 'object');
  for (const sink of new Set(files)) add(sink.file, sink === out && sink === err ? 'both' : sink === out ? 'stdout' : 'stderr', !!sink.append);
}

/** `tee [-a] f…` copies its input to the files. */
function tee(argv: Word[], add: Add) {
  let k = 0;
  while (k < argv.length - 1 && argv[k].literal && PREFIXES.has(argv[k].text)) k++;
  if (!argv[k]?.literal || argv[k].text !== 'tee') return;
  let options = true, append = false;
  for (const word of argv.slice(k + 1)) {
    if (options && word.literal && word.text === '--') { options = false; continue; }
    if (options && word.literal && word.text.startsWith('-') && word.text.length > 1) {
      if (/^-[a-z]*a/.test(word.text) || word.text === '--append') append = true;
      continue;
    }
    if (word.literal && word.text && !device(word.text)) add(word.text, 'stdout', append, true);
  }
}

/** POSIX path normalisation that keeps a leading `/` or `~`; `..` never climbs above either. */
export function normalizePath(path: string): string {
  const root = path.startsWith('/') ? '/' : path === '~' || path.startsWith('~/') ? '~/' : '';
  const parts: string[] = [];
  for (const part of path.slice(root === '~/' ? 1 : 0).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else if (part !== '..' || !root) parts.push(part);
  }
  const joined = parts.join('/');
  return root === '~/' ? (joined ? '~/' + joined : '~') : root + joined || '.';
}

/** The file's path: absolute, under `~`, or relative to the command's working directory `cwd`.
 * Undefined when a `cd` before it went somewhere unknown, or the name is not a usable path. */
export function resolveRedirect(target: OutputRedirect, cwd?: string): string | undefined {
  const { path, dir } = target;
  if (!path || path.includes('\0')) return;
  if (path.startsWith('/') || path === '~' || path.startsWith('~/')) return normalizePath(path);
  if (dir === undefined) return;
  const base = !dir ? cwd : dir.startsWith('/') || dir === '~' || dir.startsWith('~/') || !cwd ? dir : `${cwd}/${dir}`;
  return normalizePath(base ? `${base}/${path}` : path);
}

export interface RedirectFile { path: string; stream: RedirectStream; append: boolean; tee?: true }
/** The files to show as a command's output when it printed nothing itself: those that
 * take its stdout first, then stderr-only ones; at most `limit`, resolved against `cwd`. */
export function redirectFiles(command: string | undefined, cwd?: string, limit = 6): RedirectFile[] {
  const files = new Map<string, RedirectFile>();
  for (const target of outputRedirects(command ?? '')) {
    const path = resolveRedirect(target, cwd);
    if (!path || device(path)) continue;
    const known = files.get(path);
    if (known) { if (known.stream !== target.stream) known.stream = 'both'; continue; }
    files.set(path, { path, stream: target.stream, append: target.append, ...(target.tee && { tee: true as const }) });
  }
  const list = [...files.values()];
  return [...list.filter(file => file.stream !== 'stderr'), ...list.filter(file => file.stream === 'stderr')].slice(0, limit);
}
