import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { SettingsFileValidation, SettingsOverrideSource } from '../shared/conversation-settings';
import { t } from '../shared/i18n';
import type { Workspace } from '../shared/types';
import { quoteShell as q, type Transport } from './transport';

export const SETTINGS_LIMIT = 1024 * 1024;
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);

export function normalizeSettingsPath(input: string | null): string | null {
  if (input === null) return null;
  if (typeof input !== 'string') throw new Error(t('conversationSettings.path'));
  const file = input.trim();
  if (!file) return null;
  if (!(file.startsWith('/') || file.startsWith('~/')) || file.includes('\0'))
    throw new Error(t('conversationSettings.path'));
  return file;
}

export function settingsPathExpression(path: string) {
  return path.startsWith('~/') ? '"$HOME"/' + q(path.slice(2)) : q(path);
}

// V8 omits the position in some messages, including unexpected value tokens.
// Walk the JSON grammar only to locate the token in that case.
function invalidJsonOffset(text: string): number {
  let at = 0;
  const whitespace = /[ \t\r\n]*/y;
  const scalar = /true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const key = /"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  const skip = () => { whitespace.lastIndex = at; whitespace.test(text); at = whitespace.lastIndex; };
  const take = (token: string) => { skip(); if (text[at] !== token) throw at; at++; };
  const match = (token: RegExp) => { token.lastIndex = at; if (!token.test(text)) throw at; at = token.lastIndex; };
  function value() {
    skip();
    if (text[at] === '"') { match(key); return; }
    if (text[at] !== '[' && text[at] !== '{') { match(scalar); return; }
    const map = text[at++] === '{', end = map ? '}' : ']';
    skip();
    if (text[at] !== end) {
      do {
        skip();
        if (map) { match(key); take(':'); }
        value();
        skip();
        if (text[at] !== ',') break;
        at++;
      } while (true);
    }
    take(end);
  }
  try { value(); skip(); return at; }
  catch (error) { return typeof error === 'number' ? error : at; }
}

function jsonError(text: string, error: unknown) {
  const message = error instanceof Error ? error.message : '';
  const position = /position (\d+)/.exec(message);
  const index = position ? Number(position[1]) : /end of JSON/i.test(message) ? text.length : invalidJsonOffset(text);
  const lines = text.slice(0, index).split(/\r\n?|\n/);
  return new Error(t('conversationSettings.json', { line: lines.length, column: lines.at(-1)!.length + 1 }));
}

export async function readSettingsFile(transport: Pick<Transport, 'run'>, ws: Workspace, path: string): Promise<JsonObject> {
  // Keep JSON and native read errors out of the shell arguments and diagnostics.
  const { stdout } = await transport.run(ws, `p=${settingsPathExpression(path)}
if [ ! -e "$p" ]; then
  d="\${p%/*}"
  while [ -n "$d" ] && [ ! -e "$d" ]; do d="\${d%/*}"; done
  if [ -d "\${d:-/}" ] && [ ! -x "\${d:-/}" ]; then printf r; else printf m; fi
elif [ ! -f "$p" ]; then printf f
elif [ ! -r "$p" ]; then printf r
else printf 'o'; head -c ${SETTINGS_LIMIT + 1} 2>/dev/null < "$p"
fi`, { tag: 'settings.file.read', privateContent: true, maxBytes: SETTINGS_LIMIT + 2 }).catch(() => {
    throw new Error(t('conversationSettings.unreadable'));
  });
  const status = String.fromCharCode(stdout[0]);
  if (status === 'm') throw new Error(t('conversationSettings.missing'));
  if (status === 'f') throw new Error(t('conversationSettings.regular'));
  if (status !== 'o') throw new Error(t('conversationSettings.unreadable'));
  if (stdout.length - 1 > SETTINGS_LIMIT) throw new Error(t('conversationSettings.size'));
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(stdout.subarray(1)); }
  catch { throw new Error(t('conversationSettings.json', { line: 1, column: 1 })); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (error) { throw jsonError(text, error); }
  if (!object(parsed)) throw new Error(t('conversationSettings.object'));
  return parsed;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function mergeArray(custom: unknown[], lectern: unknown[]) {
  const seen = new Set<string>();
  return [...custom, ...lectern].filter(value => {
    const json = canonicalJson(value);
    if (seen.has(json)) return false;
    seen.add(json);
    return true;
  });
}

export function mergeSettings(custom: JsonObject, lectern: JsonObject): JsonObject {
  const merged = { ...custom };
  for (const [key, value] of Object.entries(lectern)) {
    const previous = Object.hasOwn(custom, key) ? custom[key] : undefined;
    const result = object(previous) && object(value) ? mergeSettings(previous, value)
      : Array.isArray(previous) && Array.isArray(value) ? mergeArray(previous, value)
      : value;
    Object.defineProperty(merged, key, { value: result, writable: true, enumerable: true, configurable: true });
  }
  return merged;
}

const shown = (value: unknown) => {
  const json = JSON.stringify(value);
  return json.length > 200 ? json.slice(0, 199) + '…' : json;
};

export function settingsOverrides(files: { file: string; settings: JsonObject }[], lectern: JsonObject): SettingsOverrideSource[] {
  return files.map(({ file, settings }) => {
    const items: SettingsOverrideSource['items'] = [];
    function visit(path: string, user: unknown, value: unknown) {
      if (object(value)) {
        for (const [key, child] of Object.entries(value)) {
          if (!object(user)) visit(path + '.' + key, user, child);
          else if (Object.hasOwn(user, key)) visit(path + '.' + key, user[key], child);
        }
      } else if (!isDeepStrictEqual(user, value)) {
        items.push({ key: path, userValue: shown(user), lecternValue: shown(value) });
      }
    }
    for (const [key, value] of Object.entries(lectern)) {
      if (key !== 'hooks' && Object.hasOwn(settings, key)) visit(key, settings[key], value);
    }
    return { file, items };
  }).filter(source => source.items.length > 0);
}

export async function inspectSettingsFiles(transport: Transport, ws: Workspace, location: { cwd: string; claudeDir: string },
  input: string | null, lectern: JsonObject, allSources: boolean): Promise<{ validation: SettingsFileValidation; custom?: JsonObject }> {
  const settingsFile = normalizeSettingsPath(input);
  const custom = settingsFile ? await readSettingsFile(transport, ws, settingsFile) : undefined;
  const sources = allSources ? [`${location.claudeDir}/settings.json`, `${location.cwd}/.claude/settings.json`, `${location.cwd}/.claude/settings.local.json`] : [];
  const files = await Promise.all(sources.map(async file => {
    try { return { file, settings: await readSettingsFile(transport, ws, file) }; }
    catch { return undefined; } // Claude reports invalid files in its own startup screen.
  }));
  return { custom, validation: { settingsFile, overrides: settingsOverrides([
    ...files.filter(entry => entry !== undefined), ...(settingsFile && custom ? [{ file: settingsFile, settings: custom }] : []),
  ], lectern) } };
}

export interface PrivateSettingsFile { path: string; remove(): Promise<void> }

export async function writePrivateSettings(transport: Transport, ws: Workspace, settings: JsonObject, id: string = randomUUID()): Promise<PrivateSettingsFile> {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid settings file ID');
  const name = id + '.json';
  const bytes = Buffer.from(JSON.stringify(settings));
  const script = `exec 2>/dev/null
set -eu
umask 077
root="\${TMPDIR:-/tmp}"
case "$root" in (/*) ;; (*) root=/tmp;; esac
dir="\${root%/}/lectern-settings-$(id -u)"
mkdir "$dir" || :
[ -d "$dir" ] && [ -O "$dir" ] && [ ! -L "$dir" ]
chmod 700 "$dir"
cd -P "$dir"
find . -maxdepth 1 -type f \\( -name '????????-????-????-????-????????????.json' -o -name '.settings.*' \\) -mmin +1440 -exec rm -f {} + || :
tmp=$(mktemp .settings.XXXXXXXX)
trap 'rm -f "$tmp"' EXIT
trap 'exit 1' HUP INT TERM
cat > "$tmp"
[ "$(wc -c < "$tmp" | tr -d '[:space:]')" = "${bytes.length}" ]
chmod 600 "$tmp"
[ ! -d ${q(name)} ]
mv -f "$tmp" ${q(name)}
printf '%s' "$dir/${name}"`;
  try {
    const { stdout } = await transport.run(ws, script, { input: bytes, privateContent: true, tag: 'settings.file.stage', maxBytes: 8192 });
    const path = stdout.toString('utf8');
    if (!path.startsWith('/') || !path.endsWith('/' + name) || /[\x00-\x1f\x7f]/.test(path)) throw new Error('Invalid private settings file path');
    return { path, remove: async () => { await transport.run(ws, `rm -f ${q(path)} 2>/dev/null`, { tag: 'settings.file.remove', maxBytes: 0 }); } };
  } catch { throw new Error(t('conversationSettings.stage')); }
}
