/** A prompt-cache lifetime Claude Code takes for its requests (2.1.242+ accepts only these). */
export type PromptCacheTtl = '5m' | '1h';
/** The prompt-cache lifetimes chosen in Settings → Session: 'default' leaves both to Claude
 * Code (Lectern sets nothing); the others fix the main conversation's and every other
 * request's (subagents, compaction, session titles and the like). */
export type PromptCacheTtlPreset = 'default' | 'both-5m' | 'both-1h' | 'main-1h-other-5m';
export const promptCacheTtlPresets: readonly PromptCacheTtlPreset[] = ['default', 'both-5m', 'both-1h', 'main-1h-other-5m'];
export interface PromptCacheTtls { main: PromptCacheTtl; other: PromptCacheTtl }
const presetTtls: Record<Exclude<PromptCacheTtlPreset, 'default'>, PromptCacheTtls> = {
  'both-5m': { main: '5m', other: '5m' },
  'both-1h': { main: '1h', other: '1h' },
  'main-1h-other-5m': { main: '1h', other: '5m' },
};

/** A stored or received preset, anything else being 'default'. */
export function promptCacheTtlPreset(value: unknown): PromptCacheTtlPreset {
  return promptCacheTtlPresets.find(preset => preset === value) ?? 'default';
}

/** The lifetimes a preset sets, or undefined for 'default' (and anything unknown). */
export function promptCacheTtls(value: unknown): PromptCacheTtls | undefined {
  const preset = promptCacheTtlPreset(value);
  return preset === 'default' ? undefined : presetTtls[preset];
}

/** The preset for the two separate choices (main, other) that development builds of 0.2.2
 * stored; a pair that is not a preset (main 5m with others 1h, one of them unset) is 'default'. */
export function promptCacheTtlPresetOf(main: unknown, other: unknown): PromptCacheTtlPreset {
  return promptCacheTtlPresets.find(preset => {
    const ttls = promptCacheTtls(preset);
    return ttls !== undefined && ttls.main === main && ttls.other === other;
  }) ?? 'default';
}

/** Options for the Claude processes Lectern starts from now on (Settings → Session). */
export interface LaunchPreferences {
  /** Dynamic workflows on, so /effort offers Ultracode. */
  enableWorkflows: boolean;
  /** The prompt-cache lifetimes; 'default' when absent. */
  promptCacheTtlPreset?: PromptCacheTtlPreset;
}

/** Received preferences with every unknown value at its default. */
export function launchPreferences(value: Partial<LaunchPreferences> | undefined): Required<LaunchPreferences> {
  return {
    enableWorkflows: value?.enableWorkflows !== false,
    promptCacheTtlPreset: promptCacheTtlPreset(value?.promptCacheTtlPreset),
  };
}
