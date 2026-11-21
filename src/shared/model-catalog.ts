// The model and effort choices Claude Code offers on a machine, as its SDK
// reports them (initialize + get_settings), without opening the TUI.

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = typeof EFFORT_LEVELS[number];
export const isEffortLevel = (value: unknown): value is EffortLevel =>
  typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value);

/** A model value that can be passed as one argv item: an alias, an ID, or a
 * gateway ID such as `codex/gpt-6-sol` or `claude-fable-5-1[1m]`. Never an option. */
export const MODEL_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/@+[\]-]{0,199}$/;
export const isModelValue = (value: unknown): value is string => typeof value === 'string' && MODEL_VALUE.test(value);

export interface ModelChoice {
  /** What `--model` and `/model` take: `default`, an alias, or a model ID. */
  value: string;
  /** The wire model this row resolves to, when the CLI reports it. */
  resolvedModel?: string;
  /** Exactly the native menu row's name and description. */
  label: string;
  description?: string;
  /** Effort levels the model accepts, in the native slider's order. Empty: no effort control. */
  efforts: EffortLevel[];
}

export interface ModelCatalog {
  /** When the machine was asked (ISO). The list stays until the app quits. */
  observedAt: string;
  /** The Claude Code version that answered. */
  version?: string;
  models: ModelChoice[];
  /** What a new session on this machine starts with when nothing is chosen. */
  defaults: {
    /** The resolved model ID, e.g. claude-opus-5-5. */
    model?: string;
    /** The `model` setting as written, e.g. opus. */
    settingModel?: string;
    effort?: EffortLevel;
    ultracodeAvailable?: boolean;
  };
}

/** A renderer request for a machine's lists, and what it gets back. */
export type ModelCatalogState = { status: 'loading' } | { status: 'ready'; catalog: ModelCatalog } | { status: 'failed'; error: string };

/** Choices made in a new-chat draft; applied only to that session's launch. */
export interface LaunchChoices { model?: string; effort?: EffortLevel }

/** The row a new session starts on: the setting's row, else the `default` row. */
export function defaultModelChoice(catalog: ModelCatalog): ModelChoice | undefined {
  const { settingModel, model } = catalog.defaults;
  return (settingModel !== undefined ? catalog.models.find(row => row.value === settingModel) : undefined)
    ?? catalog.models.find(row => row.value === 'default')
    ?? (model !== undefined ? catalog.models.find(row => row.resolvedModel === model || row.value === model) : undefined);
}

/** Effort levels offered for a model row, or for the default row when none is chosen. */
export function effortsFor(catalog: ModelCatalog, value?: string): EffortLevel[] {
  const row = value === undefined ? defaultModelChoice(catalog) : catalog.models.find(item => item.value === value);
  return row?.efforts ?? [];
}

/** Drop choices the catalog no longer offers (another folder, a changed machine). */
export function validLaunchChoices(catalog: ModelCatalog | undefined, choices: LaunchChoices): LaunchChoices {
  if (!catalog) return {};
  const model = choices.model !== undefined && catalog.models.some(row => row.value === choices.model) ? choices.model : undefined;
  const effort = choices.effort !== undefined && effortsFor(catalog, model).includes(choices.effort) ? choices.effort : undefined;
  return { ...(model !== undefined && model !== 'default' && { model }), ...(effort !== undefined && { effort }) };
}
