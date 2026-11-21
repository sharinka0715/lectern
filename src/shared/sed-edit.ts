import { t } from './i18n';
// `sed -i` edits files without a native diff. Reconstruct what the command asked
// for (substitution rules, deleted or inserted lines) so the chat can show it like
// an Edit made from its parameters. Anything not simple enough is left undefined.

export interface SedReplacement { old_string: string; new_string: string; replace_all?: boolean }
export interface SedEdit {
  files: string[];
  /** s/pattern/replacement/flags as before → after fragments (patterns may be regular expressions). */
  edits: SedReplacement[];
  /** Other edits in words: deletions, insertions, addresses. */
  notes: string[];
  regex: 'basic' | 'extended';
}

type Token = { word: string } | { op: string };

/** Words and control operators of a simple shell command line. Command
 * substitution, here-documents and other expansions are not interpreted. */
export function shellWords(command: string): Token[] | undefined {
  const tokens: Token[] = [];
  let word: string | undefined, i = 0;
  const flush = () => { if (word !== undefined) tokens.push({ word }); word = undefined; };
  while (i < command.length) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return;
      word = (word ?? '') + command.slice(i + 1, end); i = end + 1;
    } else if (c === '"') {
      let j = i + 1, text = '';
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === '$' || command[j] === '`') return;
        if (command[j] === '\\' && '"\\$`\n'.includes(command[j + 1] ?? '')) text += command[++j];
        else text += command[j];
      }
      if (j >= command.length) return;
      word = (word ?? '') + text; i = j + 1;
    } else if (c === '\\') { word = (word ?? '') + (command[i + 1] ?? ''); i += 2; }
    else if (c === '$' || c === '`' || c === '(' || c === ')' || c === '<') return;
    else if (/\s/.test(c)) { flush(); if (c === '\n') tokens.push({ op: ';' }); i++; }
    else if (c === '&' || c === '|' || c === ';') {
      flush();
      const op = command.slice(i, i + 2) === '&&' || command.slice(i, i + 2) === '||' ? command.slice(i, i + 2) : c;
      tokens.push({ op }); i += op.length;
    } else if (c === '>') {
      // Redirections (e.g. 2>&1, >/dev/null) never name an edited file here.
      const match = /^>>?(?:&\d+)?/.exec(command.slice(i))!;
      if (word !== undefined && /^\d$/.test(word)) word = undefined;
      flush(); tokens.push({ op: match[0].includes('&') ? 'dup' : 'redirect' }); i += match[0].length;
    } else { word = (word ?? '') + c; i++; }
  }
  flush();
  return tokens;
}

type SedOp = { kind: 's'; address: string; pattern: string; replacement: string; flags: string }
  | { kind: 'd'; address: string } | { kind: 'a' | 'i' | 'c'; address: string; text: string };

/** Read up to an unescaped delimiter; `\<delim>` becomes the delimiter itself. */
function delimited(script: string, start: number, delimiter: string): [string, number] | undefined {
  let text = '';
  for (let i = start; i < script.length; i++) {
    if (script[i] === '\\' && i + 1 < script.length) {
      text += script[i + 1] === delimiter ? delimiter : script[i] + script[i + 1];
      i++;
    } else if (script[i] === delimiter) return [text, i + 1];
    else text += script[i];
  }
}

function address(script: string, start: number): [string, number] | undefined {
  let i = start, text = '';
  const one = (): boolean => {
    const number = /^(?:\d+(?:~\d+)?|\$)/.exec(script.slice(i));
    if (number) { text += number[0]; i += number[0].length; return true; }
    if (script[i] === '/' || (script[i] === '\\' && i + 1 < script.length)) {
      const delimiter = script[i] === '/' ? '/' : script[i + 1], open = script[i] === '/' ? 1 : 2;
      const read = delimited(script, i + open, delimiter);
      if (!read) return false;
      text += `/${read[0]}/`; i = read[1];
      if (script[i] === 'I') { text += 'I'; i++; }
      return true;
    }
    return false;
  };
  if (one() && script[i] === ',') { text += ','; i++; if (!one()) return; }
  if (script[i] === '!') { text += '!'; i++; }
  return [text, i];
}

/** s, d, a, i, c with optional addresses, separated by ; or newlines. */
export function parseSedScript(script: string): SedOp[] | undefined {
  const ops: SedOp[] = [];
  let i = 0;
  while (i < script.length) {
    if (/[\s;]/.test(script[i])) { i++; continue; }
    const at = address(script, i);
    if (!at) return;
    const [where, next] = at;
    i = next;
    while (script[i] === ' ' || script[i] === '\t') i++;
    const command = script[i++];
    if (command === 's') {
      const delimiter = script[i];
      if (!delimiter || /[\s\\\n]/.test(delimiter)) return;
      const pattern = delimited(script, i + 1, delimiter);
      const replacement = pattern && delimited(script, pattern[1], delimiter);
      if (!pattern || !replacement) return;
      const flags = /^[gpIiMme0-9]*/.exec(script.slice(replacement[1]))![0];
      i = replacement[1] + flags.length;
      if (script[i] === 'w') return; // writes another file
      ops.push({ kind: 's', address: where, pattern: pattern[0], replacement: replacement[0], flags });
    } else if (command === 'd') ops.push({ kind: 'd', address: where });
    else if (command === 'a' || command === 'i' || command === 'c') {
      // GNU one-liner `a text`, or POSIX `a\` followed by the text on the next line.
      let end = script.indexOf('\n', i);
      if (end < 0) end = script.length;
      let text = script.slice(i, end).replace(/^\s*\\?\s?/, '');
      if (!text && script[end] === '\n') { const after = script.indexOf('\n', end + 1); text = script.slice(end + 1, after < 0 ? undefined : after); end = after < 0 ? script.length : after; }
      ops.push({ kind: command, address: where, text: text.replace(/\\$/, '') });
      i = end;
    } else return; // p, y, {…}, n, N and the rest are not file edits we can describe
    while (script[i] === ' ' || script[i] === '\t') i++;
    if (i < script.length && !/[;\n]/.test(script[i])) return;
  }
  return ops.length ? ops : undefined;
}

const where = (address: string) => !address ? '' : /^\d+$/.test(address) ? t('shared.sedLine', { line: address }) : address === '$' ? t('shared.sedLastLine')
  : /^\d+,\d+$/.test(address) ? t('shared.sedLines', { range: address.replace(',', '–') }) : t('shared.sedAddress', { address });

/** The in-place sed invocations of a command line, or undefined when there are none. */
export function sedEdit(command: string): SedEdit | undefined {
  const tokens = shellWords(command);
  if (!tokens) return;
  const commands: string[][] = [[]];
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    if ('word' in token) commands.at(-1)!.push(token.word);
    else if (token.op === 'redirect') k++; // its target file is not an edit
    else if (token.op !== 'dup') commands.push([]);
  }
  const result: SedEdit = { files: [], edits: [], notes: [], regex: 'basic' };
  let found = false;
  for (const raw of commands) {
    const words = raw.slice(raw.findIndex(word => !/^[A-Za-z_]\w*=/.test(word)));
    if (!/^(?:\S*\/)?g?sed$/.test(words[0] ?? '')) continue;
    let inPlace = false, extended = false;
    const scripts: string[] = [], rest: string[] = [];
    for (let k = 1; k < words.length; k++) {
      const word = words[k];
      if (word === '--') { rest.push(...words.slice(k + 1)); break; }
      if (word === '-i' || word === '--in-place') {
        inPlace = true;
        // BSD sed takes a backup suffix argument: -i '' or -i .bak
        if (k + 2 < words.length && (words[k + 1] === '' || /^\.[\w.-]*$/.test(words[k + 1]))) k++;
      } else if (/^-i\S+$/.test(word) || word.startsWith('--in-place=')) inPlace = true;
      else if (/^-[Ernsuz]*i$/.test(word) || /^-[Ernsuz]+$/.test(word)) { inPlace ||= word.endsWith('i'); extended ||= /[Er]/.test(word); }
      else if (word === '--regexp-extended') extended = true;
      else if (word === '-e' || word === '--expression') scripts.push(words[++k] ?? '');
      else if (word.startsWith('--expression=')) scripts.push(word.slice('--expression='.length));
      else if (word.startsWith('-') && word !== '-') return; // -f script files, unknown options
      else rest.push(word);
    }
    if (!inPlace) continue;
    if (!scripts.length && rest.length) scripts.push(rest.shift()!);
    if (!rest.length) continue;
    found = true;
    if (extended) result.regex = 'extended';
    for (const file of rest) if (!result.files.includes(file)) result.files.push(file);
    const ops = parseSedScript(scripts.join('\n'));
    if (!ops) { result.notes.push(t('shared.sedUnparsed', { script: scripts.join(' ; ') })); continue; }
    for (const op of ops) {
      if (op.kind === 's') {
        result.edits.push({ old_string: op.pattern, new_string: op.replacement, ...(op.flags.includes('g') && { replace_all: true }) });
        if (op.address) result.notes.push(t('shared.sedSubstituteOnly', { where: where(op.address) }));
      } else if (op.kind === 'd') result.notes.push(t(op.address.startsWith('/') ? 'shared.sedDeleteMatching' : 'shared.sedDelete', { where: where(op.address) || t('shared.sedAllLines') }));
      else {
        result.edits.push({ old_string: '', new_string: op.text });
        result.notes.push(t(({ a: 'shared.sedAppend', i: 'shared.sedInsert', c: 'shared.sedChange' } as const)[op.kind], { where: where(op.address) || t('shared.sedEveryLine') }));
      }
    }
  }
  return found ? result : undefined;
}
