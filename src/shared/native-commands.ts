import { t, type MessageKey } from './i18n';
// Native slash commands are managed by allow-list. A command typed in the chat box
// must print its result or start an ordinary turn and then return to the prompt;
// anything that opens an interactive panel would leave Lectern waiting forever.
// User-installed skills and custom commands are always allowed.

/** Built-ins the chat box may send as text. */
export const sendableNativeCommands = new Set([
  'compact', 'context', 'cost', 'init', 'review', 'security-review', 'pr-comments', 'release-notes', 'todos', 'rename',
]);
/** Built-ins Lectern answers with its own controls instead of typing them. */
export const routedNativeCommands = { model: 'model', effort: 'effort', rewind: 'rewind', fork: 'fork', branch: 'fork' } as const;
export type RoutedCommand = typeof routedNativeCommands[keyof typeof routedNativeCommands];

/** Names the installed CLI ships. Used only to recognise a built-in; it never grants sending. */
export const builtinCommandNames = new Set(`help compact clear context model effort rewind config permissions status usage
add-dir advisor agents artifacts auto-mode-setup autocompact autofix-pr background branch btw bug cd chrome color copy cost design design-login design-sync desktop diff doctor exit export fast feedback focus fork goal heapdump hooks ide import init insights install-github-app install-slack-app keybindings list-agents login logout mcp memory mobile output-style passes plan plugin powerup pr-comments privacy-settings radio rate-limit-options recap release-notes reload-plugins reload-skills remote-control remote-env rename restart resume review sandbox schedule scroll-speed security-review setup-bedrock setup-vertex skills stats statusline stickers stop subtask tasks team-onboarding teleport terminal-setup theme todos tui ultraplan ultrareview upgrade usage-credits verify vim voice web-setup workflows`.split(/\s+/));

/** The command name when the text starts with one ("/compact keep tests"); a path such as "/tmp/a" is text. */
export function slashCommandName(text: string): string | undefined {
  return /^\/([\w][\w:.-]*)(?:\s|$)/u.exec(text.trimStart())?.[1];
}

export type CommandPolicy =
  | { kind: 'text' }
  | { kind: 'send'; name: string }
  | { kind: 'route'; name: string; target: RoutedCommand }
  | { kind: 'installed'; name: string }
  | { kind: 'block'; name: string; message: string };

const blockedHelp: Record<string, MessageKey> = {
  clear: 'shared.blockedClear',
  exit: 'shared.blockedExit',
  resume: 'shared.blockedResume',
  vim: 'shared.blockedVim',
};

/** What sending this text means. `installed` needs a check against the machine's skills. */
export function commandPolicy(text: string): CommandPolicy {
  const name = slashCommandName(text);
  if (!name) return { kind: 'text' };
  const key = name.toLowerCase();
  if (key in routedNativeCommands) return { kind: 'route', name, target: routedNativeCommands[key as keyof typeof routedNativeCommands] };
  if (sendableNativeCommands.has(key)) return { kind: 'send', name };
  if (builtinCommandNames.has(key)) return { kind: 'block', name,
    message: t('shared.blockedCommand', { name, help: t(blockedHelp[key] ?? 'shared.blockedDefault') }) };
  return { kind: 'installed', name };
}
