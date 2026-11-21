import type { JsonRecord } from './jsonl';

export interface ContextUsageObservation {
  /** Uncached input, rather than all input in the request. */
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** Only for a write wholly accounted for by one native TTL bucket. Not an expiry time. */
  cacheCreationTtl?: '5m' | '1h';
  /** Last request's input + cache read + cache creation; never a session sum. */
  totalInputTokens: number;
  /** Kept separately and never included in totalInputTokens. */
  outputTokens?: number;
  model?: string;
  messageId?: string;
  timestamp?: string;
  source: 'jsonl-last-request';
  /** Native transcript samples contain no authoritative capacity field. */
  windowTokens: null;
  usedPercent: null;
}

function object(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function counts(usage: JsonRecord) {
  const inputTokens = tokenCount(usage.input_tokens);
  const cacheReadInputTokens = tokenCount(usage.cache_read_input_tokens);
  const cacheCreationInputTokens = tokenCount(usage.cache_creation_input_tokens);
  if (inputTokens === undefined || cacheReadInputTokens === undefined || cacheCreationInputTokens === undefined) return;
  const totalInputTokens = inputTokens + cacheReadInputTokens + cacheCreationInputTokens;
  if (!Number.isSafeInteger(totalInputTokens)) return;
  const buckets = object(usage.cache_creation);
  const five = buckets.ephemeral_5m_input_tokens, hour = buckets.ephemeral_1h_input_tokens;
  const ttl = cacheCreationInputTokens === 0 ? undefined
    : five === cacheCreationInputTokens && (hour === undefined || hour === 0) ? '5m' as const
    : hour === cacheCreationInputTokens && (five === undefined || five === 0) ? '1h' as const : undefined;
  return { inputTokens, cacheReadInputTokens, cacheCreationInputTokens, totalInputTokens, outputTokens: tokenCount(usage.output_tokens), ...(ttl && { cacheCreationTtl: ttl }) };
}

export function requestUsage(record: JsonRecord): ContextUsageObservation | undefined {
  const message = object(record.message);
  const usage = object(message.usage);
  let selected = counts(usage);
  if (!selected) return;
  if (selected.totalInputTokens > 0 && Array.isArray(usage.iterations)) {
    // Native tests the last non-advisor, non-compaction entry and falls back
    // to top-level usage if that particular iteration is ineligible.
    for (let i = usage.iterations.length - 1; i >= 0; i--) {
      const iteration = object(usage.iterations[i]);
      if (iteration.type === 'advisor_message' || iteration.type === 'compaction') continue;
      const candidate = counts(iteration);
      if ((iteration.type === 'message' || iteration.type === 'fallback_message') && candidate?.totalInputTokens && candidate.outputTokens !== undefined) selected = candidate;
      break;
    }
  }
  return {
    ...selected,
    model: typeof message.model === 'string' ? message.model : undefined,
    messageId: typeof message.id === 'string' ? message.id : undefined,
    timestamp: typeof record.timestamp === 'string' ? record.timestamp : undefined,
    source: 'jsonl-last-request', windowTokens: null, usedPercent: null,
  };
}

