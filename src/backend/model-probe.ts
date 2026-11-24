import { EFFORT_LEVELS, isEffortLevel, isModelValue, type EffortLevel, type LaunchChoices, type ModelCatalog, type ModelChoice } from '../shared/model-catalog';
import { t } from '../shared/i18n';

// Claude Code answers SDK control requests in `-p --input-format stream-json`
// mode. With no prompt there is no model request, and --no-session-persistence
// leaves no transcript; the process exits when stdin closes.
export const PROBE_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'];
export const PROBE_INPUT = [
  { type: 'control_request', request_id: 'lectern-initialize', request: { subtype: 'initialize' } },
  { type: 'control_request', request_id: 'lectern-settings', request: { subtype: 'get_settings' } },
].map(request => JSON.stringify(request)).join('\n') + '\n';

const MAX_MODELS = 200;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, limit: number) => typeof value === 'string' && value.trim() && value.length <= limit ? value.trim() : undefined;

export class ModelProbeError extends Error {}

/** The SDK's model rows, kept only when they can be shown and switched to. */
function models(value: unknown): ModelChoice[] {
  if (!Array.isArray(value)) throw new ModelProbeError(t('backend.noModelList'));
  const rows: ModelChoice[] = [];
  for (const item of value.slice(0, MAX_MODELS)) {
    const row = object(item);
    const label = text(row.displayName, 256), description = typeof row.description === 'string' && row.description.length <= 1024 ? row.description.trim() : undefined;
    if (!isModelValue(row.value) || !label || row.disabled === true) continue;
    const levels = row.supportsEffort === true && Array.isArray(row.supportedEffortLevels) ? row.supportedEffortLevels.filter(isEffortLevel) : [];
    rows.push({ value: row.value, ...(isModelValue(row.resolvedModel) && { resolvedModel: row.resolvedModel }), label,
      ...(description && { description }), efforts: EFFORT_LEVELS.filter(level => levels.includes(level)) });
  }
  if (!rows.length) throw new ModelProbeError(t('backend.emptyModelList'));
  return rows;
}

/** Read the stream-json answer to PROBE_INPUT. Account details (email,
 * organization) are never kept. A CLI without get_settings still yields models. */
export function parseModelProbe(stdout: string, observedAt = new Date().toISOString()): ModelCatalog {
  const responses = new Map<string, Record<string, unknown>>();
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let record: Record<string, unknown>;
    try { record = object(JSON.parse(line)); } catch { continue; }
    const response = object(record.response);
    if (record.type === 'control_response' && typeof response.request_id === 'string') responses.set(response.request_id, response);
  }
  const initialize = responses.get('lectern-initialize');
  if (!initialize) throw new ModelProbeError(t('backend.modelListNoReply'));
  if (initialize.subtype !== 'success') throw new ModelProbeError(t('backend.modelListRejected', { reason: text(initialize.error, 500) ?? t('backend.unknownReason') }));
  const init = object(initialize.response);
  const settings = responses.get('lectern-settings');
  const applied = settings?.subtype === 'success' ? object(object(settings.response).applied) : {};
  const effective = settings?.subtype === 'success' ? object(object(settings.response).effective) : {};
  const effort = applied.effort;
  return {
    observedAt,
    ...(text(init.claude_code_version, 64) && { version: text(init.claude_code_version, 64) }),
    models: models(init.models),
    defaults: {
      ...(isModelValue(applied.model) && { model: applied.model }),
      ...(isModelValue(effective.model) && { settingModel: effective.model }),
      ...(isEffortLevel(effort) && { effort: effort as EffortLevel }),
      ...(typeof applied.ultracodeAvailable === 'boolean' && { ultracodeAvailable: applied.ultracodeAvailable }),
    },
  };
}

/** `--model <value> --effort <level>` for a new session, validated again here
 * because each value becomes an argv item in a shell command on the target. */
export function launchChoiceArgs(choices: LaunchChoices = {}): string[] {
  if (!choices || typeof choices !== 'object') throw new Error(t('backend.invalidLaunchOptions'));
  const { model, effort } = choices;
  if (model !== undefined && !isModelValue(model)) throw new Error(t('backend.invalidModel'));
  if (effort !== undefined && !isEffortLevel(effort)) throw new Error(t('backend.invalidEffort'));
  return [...(model !== undefined && model !== 'default' ? ['--model', model] : []), ...(effort !== undefined ? ['--effort', effort] : [])];
}

/** Claude includes validation errors in a successful get_settings reply. */
export function modelProbeSettingsErrors(stdout: string, privatePath?: string, settingsFile?: string) {
  const issues: import('../shared/conversation-settings').SettingsValidationIssue[] = [];
  // macOS may report the resolved /private path of the temporary file.
  const privateSuffix = privatePath && '/' + privatePath.split('/').slice(-2).join('/');
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let record: Record<string, unknown>;
    try { record = object(JSON.parse(line)); } catch { continue; }
    const response = object(record.response);
    if (record.type !== 'control_response' || response.request_id !== 'lectern-settings') continue;
    const errors = object(response.response).errors;
    if (!Array.isArray(errors)) continue;
    for (const value of errors) {
      const row = object(value);
      if (typeof row.message !== 'string') continue;
      const file = typeof row.file === 'string' ? row.file : '';
      issues.push({ file: privateSuffix && settingsFile && file.endsWith(privateSuffix) ? settingsFile : file,
        path: typeof row.path === 'string' ? row.path : '', message: row.message });
    }
  }
  return issues;
}
