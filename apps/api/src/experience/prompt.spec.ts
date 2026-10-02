import { EXPERIENCE_PROMPTS, LOCAL_PROMPTS } from '../prompts/catalog';
import {
  experiencePrompts,
  experienceRequest,
  experienceTool,
  resolveExperienceSources,
} from './prompt';
import { snapshotPromptSource, type PromptSource } from '../prompts/template';
import { fixture, result } from './testing';

it('经验请求保留完整文本、短引用和模板来源', async () => {
  const { input } = await fixture();
  input.seat.agentId = '固定玩家';
  expect(experienceRequest(input)).toMatchSnapshot();
});

describe('经验模板来源', () => {
  it('普通源失败时回退本地，固定快照缺失时抛错', async () => {
    const offline: PromptSource = {
      async load() {
        throw new Error('平台离线');
      },
    };
    expect(await experiencePrompts(offline)).toEqual(await experiencePrompts(LOCAL_PROMPTS));
    await expect(experiencePrompts(snapshotPromptSource([]))).rejects.toThrow('固定快照没有');
  });

  it('成功加载的模板缺少契约变量时不回退', async () => {
    const broken: PromptSource = {
      async load(name) {
        const template = await LOCAL_PROMPTS.load(name);
        return { ...template, text: '删除了全部变量', source: 'platform', version: 7 };
      },
    };
    await expect(experiencePrompts(broken)).rejects.toThrow('缺少必需变量');
  });

  it('远端版本保留来源，新增未知变量在真实渲染时报错', async () => {
    const { input } = await fixture();
    const platform: PromptSource = {
      async load(name) {
        return { ...(await LOCAL_PROMPTS.load(name)), source: 'platform', version: 7 };
      },
    };
    input.prompts = await experiencePrompts(platform);
    expect(experienceRequest(input).prompts).toEqual(
      Object.values(EXPERIENCE_PROMPTS).map((name) => ({ name, source: 'platform', version: 7 })),
    );
    input.prompts[0]!.text += '\n{{unknown}}';
    expect(() => experienceRequest(input)).toThrow('缺少变量: unknown');
  });
});

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
