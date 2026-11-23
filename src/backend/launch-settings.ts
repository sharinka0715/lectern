import { promptCacheTtlChoice, type PromptCacheTtlChoice } from '../shared/prompt-cache';

/** The per-process settings (`claude --settings <json>`) every Claude that Lectern
 * starts gets: new chats, resumes, the temporary resume behind a rename and the
 * model-list probe. They layer over the user's own settings files for this process
 * only; those files are never written. */
export function launchSettings(options: {
  statusLine?: object; enableWorkflows: boolean;
  promptCacheTtl?: PromptCacheTtlChoice; subagentPromptCacheTtl?: PromptCacheTtlChoice;
}): Record<string, unknown> {
  const env = promptCacheEnv(options);
  return {
    ...options.statusLine,
    // A prompt suggestion fills the empty composer with grey text, which reads
    // as an unsent native draft and blocks chat input.
    promptSuggestionEnabled: false,
    // Pro plans start with dynamic workflows off, which hides /effort's Ultracode.
    ...(options.enableWorkflows && { enableWorkflows: true }),
    // Sessions start in auto mode. As the default mode (rather than
    // `--permission-mode auto`) it also keeps Claude Code 2.1.300+ from asking a
    // user whose own default is manual "Make auto mode your default permission
    // mode?" before the first message. Where auto mode is unavailable (turned off
    // with permissions.disableAutoMode in user, project or managed settings)
    // Claude Code starts in manual mode and tool permissions show as cards.
    permissions: { defaultMode: 'auto' },
    // `env` carries only the prompt-cache lifetimes the user chose in Lectern. Auto
    // mode's safety check stays where Claude Code puts it (on the server, free of
    // charge, with a direct Anthropic connection). Through a gateway that does not pass
    // it through, Claude Code says so in a dialog (the billing notice in 2.1.300–2.1.310,
    // "Auto mode can't check actions" from 2.1.321), which Lectern shows as a card
    // (core/auto-mode-screen.ts). A user who wants the local check sets
    // CLAUDE_CODE_AUTO_MODE_SERVER=0 in their shell or settings themselves.
    ...(env && { env }),
  };
}

/** The variables for the prompt-cache lifetimes chosen in Settings → Session, or
 * undefined when both follow Claude Code's default (then nothing is set).
 * The variables rather than the settings `promptCacheTtl`/`subagentPromptCacheTtl`:
 * either variable, in the user's shell or in their settings' `env`, would override
 * those settings, while this `env` overrides both (settings `env` objects merge,
 * so the user's other variables stay). Only FORCE_PROMPT_CACHING_5M=1 still wins
 * (and, presumably, managed settings). Claude Code 2.1.300–2.1.330 measured with
 * scripts/cc-matrix/probe-cache-ttl.mjs. Like any settings variable, they reach the
 * processes Claude Code starts (tool commands, hooks, a nested `claude`). */
function promptCacheEnv(options: { promptCacheTtl?: PromptCacheTtlChoice; subagentPromptCacheTtl?: PromptCacheTtlChoice }) {
  const main = promptCacheTtlChoice(options.promptCacheTtl), other = promptCacheTtlChoice(options.subagentPromptCacheTtl);
  if (!main && !other) return undefined;
  return {
    ...(main && { CLAUDE_CODE_PROMPT_CACHE_TTL: main }),
    ...(other && { CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: other }),
  };
}
