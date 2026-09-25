import { nativeCost } from './cost';
import type { PlatformGeneration } from './platform';

const generation: PlatformGeneration = {
  id: 'a',
  model: 'deepseek-flash',
  level: 'DEFAULT',
  startTime: '2026-09-25T00:00:00Z',
  endTime: '2026-09-25T00:00:05Z',
  usageDetails: { input: 206, input_cached_tokens: 128, output: 805, total: 1139 },
  costDetails: {},
  metadata: {
    attributes: {
      'gen_ai.usage.input_tokens': '334',
      'gen_ai.usage.output_tokens': '805',
      'gen_ai.usage.cache_read.input_tokens': '128',
      'gen_ai.response.finish_reasons': '["stop"]',
    },
  },
};
it('输入包含命中缓存的 token，计完整生成耗时，不将缺价视作免费', () => {
  expect(nativeCost([generation])).toMatchObject({
    requestAttempts: null,
    transportRetries: null,
    generations: [
      {
        usageComplete: true,
        tokens: { input: 334, output: 805, total: 1139, cacheRead: 128 },
        durationMs: 5000,
        costUsd: null,
      },
    ],
  });
});
it('无最终用量、失败或中途累计不能当作最终账单；保留失败生成记录', () => {
  const result = nativeCost([
    { ...generation, endTime: null },
    { ...generation, id: 'b', level: 'ERROR', metadata: {} },
    { ...generation, id: 'c', usageDetails: {}, metadata: {} },
  ]);
  expect(result.generations).toHaveLength(3);
  for (const item of result.generations)
    expect(item).toMatchObject({
      usageComplete: false,
      tokens: { input: null, output: null, total: null },
    });
});

it('响应已完整返回但内容校验失败时，保留实际消耗的最终用量', () => {
  expect(nativeCost([{ ...generation, level: 'ERROR' }]).generations[0]).toMatchObject({
    usageComplete: true,
    tokens: { total: 1139 },
  });
  expect(
    nativeCost([
      {
        ...generation,
        metadata: {
          attributes: { ...generation.metadata.attributes, 'gen_ai.response.finish_reasons': '[]' },
        },
      },
    ]).generations[0]!.usageComplete,
  ).toBe(false);
});
