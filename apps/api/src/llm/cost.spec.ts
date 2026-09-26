import { requestAccounting, requestPricing } from './cost';
import type { AttemptCompletion } from './observation';

const access = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };
const result: AttemptCompletion = {
  dispatched: true,
  durationMs: 10,
  httpStatus: 200,
  requestId: null,
  usage: {
    prompt_tokens: 1000,
    completion_tokens: 100,
    total_tokens: 1100,
    prompt_cache_hit_tokens: 800,
    prompt_cache_miss_tokens: 200,
  },
  usageComplete: true,
  thinkingMs: null,
  status: 'succeeded',
  failureCode: null,
};

it.each([
  ['2026-09-28T08:59:59+08:00', 'off_peak'],
  ['2026-09-28T09:00:00+08:00', 'peak'],
  ['2026-09-28T12:00:00+08:00', 'off_peak'],
  ['2026-09-28T14:00:00+08:00', 'peak'],
  ['2026-09-28T18:00:00+08:00', 'off_peak'],
  ['2026-09-25T10:00:00+08:00', 'off_peak'],
  ['2026-10-07T10:00:00+08:00', 'off_peak'],
  ['2026-10-08T10:00:00+08:00', 'peak'],
  ['2026-10-10T10:00:00+08:00', 'off_peak'],
])('北京时间边界、节假日及调休周末：%s', (at, period) => {
  expect(requestPricing(access, new Date(at))).toMatchObject({ period });
});

it('只按官方接入和已核对价格期间取价，套餐不套用按量价格', () => {
  const at = new Date('2026-09-26T10:00:00+08:00');
  expect(requestPricing({ ...access, baseUrl: 'https://proxy.invalid' }, at)).toEqual({
    reason: 'pricing_missing',
  });
  expect(
    requestPricing({ ...access, baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3' }, at),
  ).toEqual({ reason: 'subscription' });
  expect(requestPricing(access, new Date('2027-01-01T00:00:00+08:00'))).toEqual({
    reason: 'pricing_period_unknown',
  });
  expect(requestPricing(access, new Date('2026-09-10T03:59:59Z'))).toEqual({
    reason: 'pricing_period_unknown',
  });
});

it('缓存只占输入的一部分，分时费用可由官方单价核算', () => {
  const off = requestAccounting(
    result,
    requestPricing(access, new Date('2026-09-26T10:00:00+08:00')),
  );
  expect(off.usageDetails).toEqual({ input: 200, input_cached: 800, output: 100, total: 1100 });
  expect(off.costDetails?.total).toBeCloseTo(0.0000924, 12);
  expect(off.metadata).toMatchObject({
    costStatus: 'estimated',
    costCurrency: 'USD',
    costPeriod: 'off_peak',
  });
  const peak = requestAccounting(
    result,
    requestPricing(access, new Date('2026-09-28T10:00:00+08:00')),
  );
  expect(peak.costDetails?.total).toBeCloseTo(0.0001848, 12);
});

it.each([
  { usageComplete: false },
  { usage: { prompt_tokens: 1000, completion_tokens: 100 } },
  { usage: { ...result.usage, prompt_cache_hit_tokens: 1001 } },
  { usage: { ...result.usage, prompt_cache_miss_tokens: 201 } },
  { usage: { ...result.usage, total_tokens: 1101 } },
  { usage: { ...result.usage, prompt_tokens_details: { cached_tokens: 700 } } },
])('缺失、冲突用量不能变成零费用或完整费用：%j', (override) => {
  const accounting = requestAccounting(
    { ...result, ...override },
    requestPricing(access, new Date('2026-09-26')),
  );
  expect(accounting.costDetails).toBeUndefined();
  expect(accounting.metadata.costStatus).toBe('unknown');
});

it('真正的零用量与未知价格分别记录', () => {
  const zero = {
    ...result,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_cache_hit_tokens: 0 },
  };
  const known = requestAccounting(zero, requestPricing(access, new Date('2026-09-26')));
  expect(known.costDetails?.total).toBe(0);
  expect(known.metadata.costStatus).toBe('estimated');
  const unknown = requestAccounting(zero, { reason: 'pricing_missing' });
  expect(unknown.costDetails).toBeUndefined();
  expect(unknown.metadata.costStatus).toBe('unknown');
});
