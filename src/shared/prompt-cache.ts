/** A prompt-cache lifetime Claude Code takes for its requests (2.1.242+ accepts only these). */
export type PromptCacheTtl = '5m' | '1h';
/** A lifetime chosen in Settings → Session; '' leaves it to Claude Code's own default. */
export type PromptCacheTtlChoice = PromptCacheTtl | '';
export const promptCacheTtlChoices: readonly PromptCacheTtlChoice[] = ['', '5m', '1h'];

/** A stored or received choice, anything else being the default (''). */
export function promptCacheTtlChoice(value: unknown): PromptCacheTtlChoice {
  return value === '5m' || value === '1h' ? value : '';
}

/** Options for the Claude processes Lectern starts from now on (Settings → Session). */
export interface LaunchPreferences {
  /** Dynamic workflows on, so /effort offers Ultracode. */
  enableWorkflows: boolean;
  /** The main conversation's prompt-cache lifetime. */
  promptCacheTtl?: PromptCacheTtlChoice;
  /** Every other request's: subagents, compaction, session titles and the like. */
  subagentPromptCacheTtl?: PromptCacheTtlChoice;
}

/** Received preferences with every unknown value at its default. */
export function launchPreferences(value: Partial<LaunchPreferences> | undefined): Required<LaunchPreferences> {
  return {
    enableWorkflows: value?.enableWorkflows !== false,
    promptCacheTtl: promptCacheTtlChoice(value?.promptCacheTtl),
    subagentPromptCacheTtl: promptCacheTtlChoice(value?.subagentPromptCacheTtl),
  };
}
