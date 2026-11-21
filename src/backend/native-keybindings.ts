import type { Workspace } from '../shared/types';
import { quoteShell, type Transport } from './transport';
import { t } from '../shared/i18n';

type BindingsContext = 'Chat' | 'ModelPicker' | 'EffortSlider' | 'Select' | 'Confirmation' | 'Tabs' | 'TextInput' | 'Question' | 'Global';

const actions: Partial<Record<BindingsContext, Record<string, string>>> = {
  Global: { 'ctrl+c': 'app:interrupt' },
  Chat: { enter: 'chat:submit', escape: 'chat:cancel', 'ctrl+x enter': 'chat:queueSubmit', 'ctrl+x ctrl+s': 'chat:sendNow', 'ctrl+enter': 'chat:sendNow', 'ctrl+j': 'chat:newline' },
  ModelPicker: { s: 'modelPicker:thisSessionOnly' },
  EffortSlider: { left: 'effortSlider:decreaseEffort', right: 'effortSlider:increaseEffort', s: 'effortSlider:thisSessionOnly' },
  Select: { up: 'select:previous', down: 'select:next', home: 'select:first', end: 'select:last', pageup: 'select:pageUp', pagedown: 'select:pageDown', enter: 'select:accept', escape: 'select:cancel' },
  Confirmation: { up: 'confirm:previous', down: 'confirm:next', enter: 'confirm:yes', escape: 'confirm:no' },
};

const normalizeChord = (chord: string) => chord.trim().toLowerCase().replace(/\besc\b/g, 'escape').replace(/\breturn\b/g, 'enter');

export function parseNativeKeybindings(raw: string): ((key: string, contexts: BindingsContext[]) => boolean) | undefined {
  try {
    // Claude's editable keymap accepts comments and trailing commas. Preserve
    // quoted strings while ignoring those two JSONC syntax extensions.
    const json = raw.replace(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, token => token.startsWith('"') ? token : ' ')
      .replace(/"(?:\\.|[^"\\])*"|,\s*(?=[}\]])/g, token => token.startsWith('"') ? token : '');
    const { bindings } = JSON.parse(json);
    if (!Array.isArray(bindings) || bindings.some(group => !group || typeof group.context !== 'string'
      || !group.bindings || typeof group.bindings !== 'object' || Array.isArray(group.bindings))) return;
    return (key, contexts) => {
      const chord = normalizeChord(key);
      for (const group of bindings) {
        if (group.context !== 'Global' && !contexts.includes(group.context)) continue;
        const expected = actions[group.context as BindingsContext]?.[chord];
        for (const [configured, action] of Object.entries(group.bindings)) {
          const custom = normalizeChord(configured);
          if (chord.startsWith(custom + ' ')) return false;
          if ((custom === chord || custom.startsWith(chord + ' ')) && (custom !== chord || action !== expected || !expected)) return false;
          if (expected && action === expected && custom !== chord && actions[group.context as BindingsContext]?.[custom] !== expected) return false;
        }
      }
      return true;
    };
  } catch { return; }
}

// Only this public keyboard configuration is inspected. Avoid reading link
// targets, special files or arbitrary settings; a missing file uses defaults.
async function readKeymap(transport: Transport, workspace: Workspace, claudeDir: string) {
  const path = quoteShell(claudeDir + '/keybindings.json');
  const absent = `[ -x ${quoteShell(claudeDir)} ] && [ ! -e ${path} ] && [ ! -L ${path} ]`;
  const regular = `[ -f ${path} ] && [ ! -L ${path} ]`;
  const stat = `stat -c '%d/%i/%s/%y/%z' ${path} 2>/dev/null || stat -f '%d/%i/%z/%.9Fm/%.9Fc' ${path}`;
  const reader = 'my $fh; sysopen($fh, $ARGV[0], O_RDONLY|O_NOFOLLOW|O_NONBLOCK) && -f $fh && -s $fh <= 65536 or exit 1; my $n=sysread($fh,my $data,65537); defined($n) && $n <= 65536 or exit 1; print $data';
  const script = `set -e
if ${absent}; then printf 'missing\\n{"bindings":[]}'
elif ${regular}; then
  revision=$(${stat})
  printf '%s\\n' "$revision"
  if command -v perl >/dev/null 2>&1; then perl -MFcntl=:DEFAULT -e ${quoteShell(reader)} ${path}
  else dd if=${path} iflag=nofollow,nonblock,fullblock bs=65537 count=1 2>/dev/null; fi
  [ "$revision" = "$(${stat})" ]
else exit 1; fi`;
  const { stdout } = await transport.run(workspace, script, { maxBytes: 66048, tag: 'settings.keybindings' });
  const split = stdout.indexOf(10);
  if (split < 1 || split > 512 || stdout.length - split - 1 > 65536) return;
  const revision = stdout.subarray(0, split).toString();
  const allowed = parseNativeKeybindings(stdout.subarray(split + 1).toString());
  const check = revision === 'missing' ? absent : `${regular} && [ "$(${stat})" = ${quoteShell(revision)} ]`;
  return { allowed, guard: `${check} || { echo ${quoteShell(t('backend.keybindingsChanged'))} >&2; exit 1; }\n` };
}

/** Thrown before any input is dispatched: the key's native action could not be confirmed. */
export class KeybindingUnconfirmed extends Error {
  constructor(key: string) { super(t('backend.keybindingUnconfirmed', { key })); this.name = 'KeybindingUnconfirmed'; }
}

/** Read and parse once per native operation. Each input command checks the
 * snapshot's stat identity (or continued absence) immediately before dispatch. */
export class NativeKeybindings {
  private snapshot?: ReturnType<typeof readKeymap>;
  constructor(private readonly transport: Transport, private readonly workspace: Workspace) {}
  async permits(claudeDir: string, key: string, contexts: BindingsContext[]): Promise<boolean> {
    this.snapshot ??= readKeymap(this.transport, this.workspace, claudeDir);
    return (await this.snapshot.catch(() => undefined))?.allowed?.(key, contexts) === true;
  }
  async guard(claudeDir: string, key: string, contexts: BindingsContext[]): Promise<string> {
    if (!await this.permits(claudeDir, key, contexts)) throw new KeybindingUnconfirmed(key);
    return (await this.snapshot)!.guard;
  }
}
