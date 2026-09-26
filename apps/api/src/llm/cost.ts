import { endpointOf } from './model-capability';
import type { ModelAccess } from './model-port';
import { tokenUsage, usageIssues, type AttemptCompletion } from './observation';

const source = 'https://api-docs.deepseek.com/quick_start/pricing/';
type Pricing =
  | { reason: 'subscription' | 'pricing_missing' | 'pricing_period_unknown' }
  | { period: 'peak' | 'off_peak'; input: number; cached: number; output: number };

/** 按发送时刻取价；只覆盖已核对的官方接入和价格版本，不套用到同名第三方模型。 */
export function requestPricing(access: Pick<ModelAccess, 'baseUrl' | 'model'>, at: Date): Pricing {
  const endpoint = endpointOf(access.baseUrl);
  if (endpoint === 'https://ark.cn-beijing.volces.com/api/plan/v3')
    return { reason: 'subscription' };
  if (
    !['https://api.deepseek.com', 'https://api.deepseek.com/v1'].includes(endpoint) ||
    access.model !== 'deepseek-flash'
  )
    return { reason: 'pricing_missing' };
  const beijing = new Date(at.getTime() + 8 * 60 * 60 * 1000);
  if (at < new Date('2026-09-10T04:00:00Z') || beijing.getUTCFullYear() !== 2026)
    return { reason: 'pricing_period_unknown' };
  const date = beijing.toISOString().slice(5, 10);
  // 国办发明电〔2025〕7号：当前价格生效后的中秋、国庆假期；调休周末仍按空闲价。
  const holiday = (date >= '09-25' && date <= '09-27') || (date >= '10-01' && date <= '10-07');
  const day = beijing.getUTCDay();
  const hour = beijing.getUTCHours();
  const peak =
    !holiday && day >= 1 && day <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
  return {
    period: peak ? 'peak' : 'off_peak',
    input: (peak ? 0.3 : 0.15) / 1_000_000,
    cached: (peak ? 0.006 : 0.003) / 1_000_000,
    output: (peak ? 1.2 : 0.6) / 1_000_000,
  };
}

/** Langfuse 的细分用量互斥；成本是美元刊例价估算，不代表充值余额的实际扣款。 */
export function requestAccounting(result: AttemptCompletion, pricing?: Pricing) {
  const tokens = tokenUsage(result.usage);
  const usageDetails: Record<string, number> = {};
  if (result.usageComplete) {
    for (const key of ['input', 'output', 'total'] as const)
      if (tokens[key] !== null) usageDetails[key] = tokens[key];
    if (tokens.input !== null && tokens.cacheRead !== null && tokens.cacheRead <= tokens.input) {
      usageDetails.input = tokens.input - tokens.cacheRead;
      usageDetails.input_cached = tokens.cacheRead;
    }
  }
  const unknown = (costReason: string) => ({
    usageDetails,
    costDetails: undefined,
    metadata: { costStatus: 'unknown', costReason },
  });
  if (!pricing) return unknown('pricing_missing');
  if ('reason' in pricing) return unknown(pricing.reason);
  if (
    !result.usageComplete ||
    tokens.input === null ||
    tokens.output === null ||
    tokens.cacheRead === null
  )
    return unknown('usage_missing');
  if (
    usageIssues(result.usage).length ||
    tokens.cacheRead > tokens.input ||
    (tokens.total !== null && tokens.total !== tokens.input + tokens.output) ||
    (result.usage?.prompt_cache_miss_tokens != null &&
      result.usage.prompt_cache_miss_tokens !== tokens.input - tokens.cacheRead) ||
    (tokens.cacheWrite !== null && tokens.cacheWrite !== 0)
  )
    return unknown('usage_invalid');
  const input = (tokens.input - tokens.cacheRead) * pricing.input;
  const cached = tokens.cacheRead * pricing.cached;
  const output = tokens.output * pricing.output;
  return {
    usageDetails,
    costDetails: { input, input_cached: cached, output, total: input + cached + output },
    metadata: {
      costStatus: 'estimated',
      costReason: 'public_price_estimate',
      costCurrency: 'USD',
      costSource: source,
      costPriceVersion: 'deepseek-flash-2026-09-10',
      costPriceCheckedAt: '2026-09-26',
      costPeriod: pricing.period,
      costRates: pricing,
    },
  };
}
