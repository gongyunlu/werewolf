import { experienceRequest, experienceTool, resolveExperienceSources } from './prompt';
import { fixture, result } from './testing';

it('复盘只提供意见正文，不把评价 ID 和平台观测 ID 混入可引用证据', async () => {
  const { input } = await fixture();
  input.review = {
    text: '先核对当时可见的信息 [D1]',
    references: [{ label: 'D1', sourceId: '旧局/assessment/行动一' }],
    scoreId: '平台评价编号',
    executionTraceId: '平台追踪编号',
  };
  const request = experienceRequest(input);
  expect(request.prompt).toContain('先核对当时可见的信息 [D1]');
  expect(request.prompt).not.toContain('旧局/assessment/行动一');
  expect(request.prompt).not.toContain('平台评价编号');
  expect(request.prompt).not.toContain('平台追踪编号');
});

it('工具只枚举当前原始证据，短编号回存为持久来源 ID', async () => {
  const { input } = await fixture();
  input.sources.push({
    id: '旧局/event/7',
    origin: { seq: 7 },
    value: '赛后狼刀记录',
    perspective: 'post_game',
  });
  const tool = experienceTool(input);
  expect(tool.parameters).toMatchObject({
    properties: {
      value: {
        properties: {
          experiences: { items: { properties: { sourceIds: { items: { enum: ['E1', 'E2'] } } } } },
        },
      },
    },
  });
  const answer = {
    ...result,
    experiences: [{ ...result.experiences[0]!, sourceIds: ['E1', 'E2'] }],
  };
  expect(resolveExperienceSources(input, answer, true).experiences[0]!.sourceIds).toEqual([
    'source-1',
    '旧局/event/7',
  ]);
  expect(answer.experiences[0]!.sourceIds).toEqual(['E1', 'E2']);
});

it.each(['D1', '旧局/assessment/行动一', 'E2', 'source-1'])(
  '新调用拒绝复盘或越界引用 %s，不猜测替换',
  async (id) => {
    const { input } = await fixture();
    const invalid = { ...result, experiences: [{ ...result.experiences[0]!, sourceIds: [id] }] };
    expect(() => resolveExperienceSources(input, invalid, true)).toThrow('经验来源不存在');
  },
);

it('旧答复按完整来源恢复；空产物不要求引用', async () => {
  const { input } = await fixture();
  const old = { ...result, experiences: [{ ...result.experiences[0]!, sourceIds: ['source-1'] }] };
  expect(resolveExperienceSources(input, old, false)).toEqual(old);
  expect(
    resolveExperienceSources(input, { experiences: [], reason: '无新经验' }, true).experiences,
  ).toEqual([]);
});

it('原始证据使用短编号，保留内容、行动归属和信息时点', async () => {
  const { input } = await fixture();
  const before = structuredClone(input);
  const request = experienceRequest(input);
  expect(request.prompt).toContain('"id":"E1"');
  expect(request.prompt).toContain('原始发言中的时序');
  expect(request.prompt).toContain('old-action');
  expect(request.prompt).toContain('at_action');
  expect(request.prompt).not.toContain('source-1');
  expect(input).toEqual(before);
});
