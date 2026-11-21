import type { CompletionItem } from './types';

// Only built-ins the chat box can use are offered: the allow-listed commands and
// those Lectern answers with its own controls (see native-commands.ts).
const common = 'compact context model effort rewind fork';
const other = 'cost init review security-review pr-comments release-notes todos rename';
const builtin = (names: string): CompletionItem[] => names.split(' ').map(value => ({value, kind:'command', source:'builtin'}));
const frequent = builtin(common), rest = builtin(other);
export function matchingCommands(prefix: string, installed: CompletionItem[] = []): CompletionItem[] {
  const needle = prefix.normalize().toLowerCase(), seen = new Set<string>();
  const rank = (v: string) => !needle ? 0 : v === needle ? 0 : v.startsWith(needle) ? 1 : v.split(':').at(-1)?.startsWith(needle) ? 2 : v.includes(needle) ? 3 : 4;
  return [...frequent, ...installed, ...rest].filter(i => { if (seen.has(i.value)) return false; seen.add(i.value); return true; })
    .map(item => ({item, score:rank(item.value.normalize().toLowerCase())})).filter(r => r.score < 4)
    .sort((a,b) => a.score-b.score).slice(0,40).map(r => r.item);
}
