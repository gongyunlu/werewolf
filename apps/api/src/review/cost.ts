import type { PlatformGeneration } from './platform';

const numberOf = (value: unknown): number | null => {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : null;
};

function hasFinalResponse(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  let reasons: unknown;
  try {
    reasons = JSON.parse(value);
  } catch {
    return false;
  }
  return (
    Array.isArray(reasons) &&
    reasons.length > 0 &&
    reasons.every((reason) =>
      ['stop', 'length', 'tool_calls', 'tool-calls', 'content_filter', 'content-filter'].includes(
        reason,
      ),
    )
  );
}

/** 平台 generation 不保证等于一次 HTTP 尝试，不推算传输重试数。 */
export function nativeCost(generations: PlatformGeneration[]) {
  return {
    source: 'langfuse' as const,
    requestAttempts: null,
    transportRetries: null,
    generations: generations.map((generation) => {
      const attributes = generation.metadata?.attributes ?? {};
      const usage = generation.usageDetails;
      const input = numberOf(attributes['gen_ai.usage.input_tokens']);
      const output = numberOf(attributes['gen_ai.usage.output_tokens']);
      const total = numberOf(usage.total);
      const complete = Boolean(
        generation.endTime &&
        hasFinalResponse(attributes['gen_ai.response.finish_reasons']) &&
        input !== null &&
        output !== null &&
        total === input + output,
      );
      const duration = generation.endTime
        ? Date.parse(generation.endTime) - Date.parse(generation.startTime)
        : null;
      return {
        id: generation.id,
        model: generation.model,
        level: generation.level,
        durationMs:
          duration !== null && Number.isFinite(duration) && duration >= 0 ? duration : null,
        usageComplete: complete,
        tokens: {
          input: complete ? input : null,
          output: complete ? output : null,
          total: complete ? total : null,
          cacheRead: complete ? numberOf(attributes['gen_ai.usage.cache_read.input_tokens']) : null,
        },
        costUsd: complete ? numberOf(generation.costDetails.total) : null,
      };
    }),
    note: '仅为平台已可见的 generation；可能仍在入库。缺失用量或价格为未知，平台内部 HTTP 重试数未知。',
  };
}
