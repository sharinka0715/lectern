// GitHub Actions annotations: `::error title=…::…` workflow commands that put a
// failed test's name and the first lines of its error on the run page and in the
// check-run annotations API, so a CI failure can be read without the job log.
// GitHub keeps about 10 error annotations per step and 50 per job: callers emit
// the most important first and fold the rest into one summary annotation.
// Outside GitHub Actions (GITHUB_ACTIONS unset) callers print nothing.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const inGitHubActions = process.env.GITHUB_ACTIONS === 'true';
/** Individual error annotations one step emits before folding the rest into one. */
export const ANNOTATIONS_PER_STEP = 8;

const escapeData = text => String(text).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const escapeProperty = text => escapeData(text).replaceAll(':', '%3A').replaceAll(',', '%2C');
const cwd = () => process.cwd().replaceAll('\\', '/');

/** A repository-relative path with forward slashes, or undefined for files outside it. */
export function repoPath(file) {
  if (!file) return undefined;
  const absolute = String(file).startsWith('file:') ? fileURLToPath(String(file)) : String(file);
  const relative = path.relative(process.cwd(), absolute).replaceAll('\\', '/');
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : undefined;
}

/** One workflow command line; `level` is error, warning or notice. */
export function annotation(level, { title, file, line } = {}, message = '') {
  const where = repoPath(file);
  const properties = [where && `file=${escapeProperty(where)}`, where && line && `line=${escapeProperty(line)}`,
    title && `title=${escapeProperty(String(title).replace(/\s+/g, ' ').slice(0, 180))}`].filter(Boolean);
  const body = String(message || title || 'failed').slice(0, 1800);
  return `::${level}${properties.length ? ` ${properties.join(',')}` : ''}::${escapeData(body)}`;
}

const ansi = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
/** Readable lines: no colours, blank lines, caret markers or Node's version footer. */
export function meaningfulLines(text, max = 8) {
  return String(text ?? '').replace(ansi, '').split(/\r?\n/).map(line => line.trimEnd())
    .filter(line => line.trim() && !/^Node\.js v\d/.test(line) && !/^\s*\^+\s*$/.test(line)).slice(0, max);
}

/** A stack frame with the checkout's path and the file: scheme removed. */
const shortFrame = frame => frame.trim().replace(/file:\/\/\/?(?=[A-Za-z]:)/, '').replace('file://', '')
  .replaceAll('\\', '/').replaceAll(`${cwd()}/`, '').replace(/\s*\{$/, '');
const ownFrame = line => /^\s+at /.test(line) && !/node_modules|\(node:|^\s+at node:/.test(line) && /\b(scripts|tests|src)[\\/]/.test(line);

/** An error's message lines (an assertion's diff included), then its first stack frame in this repository. */
export function errorSummary(error, max = 8) {
  if (error == null) return '';
  if (typeof error !== 'object') return meaningfulLines(error, max).join('\n');
  const message = meaningfulLines(error.message || String(error), max - 1);
  const name = error.name && error.name !== 'Error' && !message[0]?.startsWith(error.name) ? `${error.name}: ` : '';
  if (message.length) message[0] = name + message[0];
  const frame = String(error.stack ?? '').split('\n').find(ownFrame);
  return [...message, ...(frame ? [shortFrame(frame)] : [])].join('\n');
}

const errorHeader = /^(\w*(Error|Exception)\b[^:]*:|Error \[|\[test-all\] timed out|\s*✖ )/;
/** What a failed script printed last that explains it: TypeScript errors, Node's
 * report of an uncaught error (header, message, first own frame), a timeout note,
 * else its last lines. */
export function tailSummary(tail, max = 10) {
  const all = meaningfulLines(tail, Infinity);
  const typescript = all.filter(line => /error TS\d+:/.test(line));
  if (typescript.length) return typescript.slice(0, max).map(shortFrame).join('\n');
  // Node reports an uncaught error after the throwing source line and a caret
  // line; what follows is the error even when it has no "Error:" prefix
  // (Playwright's "electron.launch: Timeout 60000ms exceeded.").
  const raw = String(tail ?? '').replace(ansi, '').split(/\r?\n/);
  const caret = raw.findLastIndex(line => /^\s*\^+\s*$/.test(line));
  const lines = caret >= 0 ? meaningfulLines(raw.slice(caret + 1).join('\n'), Infinity) : all;
  const start = caret >= 0 && lines.length ? 0 : lines.findLastIndex(line => errorHeader.test(line) && !/^\s+at /.test(line));
  if (start < 0) return all.slice(-max).join('\n');
  const picked = [];
  let inStack = false;
  for (const line of lines.slice(start)) {
    if (/^\s+at /.test(line)) { inStack = true; if (ownFrame(line)) { picked.push(shortFrame(line)); break; } continue; }
    // After the frames Node prints the error's own properties; they are noise here.
    if (inStack || /^\s*[{}]$/.test(line)) break;
    picked.push(line);
    if (picked.length >= max) break;
  }
  return picked.join('\n');
}

/** Error annotations for a list of failures, the first `limit` in full and the
 * rest named in one summary annotation. Each item is { title, file, line, message }. */
export function failureAnnotations(items, { limit = ANNOTATIONS_PER_STEP, what = 'failures' } = {}) {
  const lines = items.slice(0, limit).map(item => annotation('error', item, item.message));
  const rest = items.slice(limit);
  if (rest.length) {
    lines.push(annotation('error', { title: `${rest.length} more ${what}` }, rest.map(item => item.title).join('\n')));
  }
  return lines;
}
