import { LangfuseReviewPlatform, reviewFilter, type ReviewProfile } from './platform';
import { REVIEW_VERSION, unitInput, type ReviewUnit } from './contracts';

const profile: ReviewProfile = {
  evaluatorId: 'e',
  evaluatorVersion: 1,
  ruleId: 'cmufrelzb000inr07jh3fghm8',
  fingerprint: 'f',
};
const unit: ReviewUnit = {
  key: 'a',
  step: 'review_decision',
  traceId: '1fb7709016a0c7d26764d85a42d02213',
  spanId: 'a6689ee40075a7da',
  createdAt: '2026-09-25T00:00:00Z',
  task: {},
  sources: [{ id: 'decision/a', origin: { actionKey: 'a', path: 'decision' }, value: 2 }],
};
const page = (data: unknown[], totalPages = 1) => ({ data, meta: { totalPages } });
const platform = () =>
  new LangfuseReviewPlatform({
    baseUrl: 'http://localhost:3100',
    publicKey: 'public',
    secretKey: 'private',
  });
let fetchMock: jest.SpiedFunction<typeof fetch>;
beforeEach(() => {
  fetchMock = jest.spyOn(globalThis, 'fetch');
});
afterEach(() => {
  jest.restoreAllMocks();
});
const reply = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

it('读取分页中指定规则的原生正文，不将类别数值当玩家分数', async () => {
  fetchMock
    .mockResolvedValueOnce(reply(page([{ id: 'other', source: 'API' }], 2)))
    .mockResolvedValueOnce(
      reply(
        page(
          [
            {
              id: 'score',
              observationId: unit.spanId,
              source: 'EVAL',
              value: 0,
              comment: '仅依据最终决定 [E1]',
              executionTraceId: 'execution',
              metadata: { job_configuration_id: profile.ruleId },
            },
          ],
          2,
        ),
      ),
    );
  expect(await platform().result(unit, profile)).toEqual({
    text: '仅依据最终决定 [E1]',
    references: [{ label: 'E1', sourceId: 'decision/a' }],
    scoreId: 'score',
    executionTraceId: 'execution',
  });
  expect(fetchMock.mock.calls[1]![0]!.toString()).toContain('page=2');
  expect(fetchMock.mock.calls.every(([, options]) => options!.method === 'GET')).toBe(true);
});

it('输入必须与已提交证据一致；不因同 trace 存在其他 observation 就认为已提交', async () => {
  fetchMock
    .mockResolvedValueOnce(reply({ observations: [{ id: 'other' }] }))
    .mockResolvedValueOnce(reply({ observations: [{ id: unit.spanId, input: { bad: true } }] }))
    .mockResolvedValueOnce(
      reply({
        observations: [{ id: unit.spanId, input: JSON.parse(JSON.stringify(unitInput(unit))) }],
      }),
    );
  expect(await platform().exists(unit)).toBe(false);
  await expect(platform().exists(unit)).rejects.toThrow('不一致');
  expect(await platform().exists(unit)).toBe(true);
});

it('全局复盘续跑按已发送的 JSON 核对输入，不将被省略的可选字段误判为变化', async () => {
  const outcome: ReviewUnit = {
    ...unit,
    key: 'outcome',
    step: 'review_outcome',
    task: { gaps: [] },
  };
  fetchMock.mockResolvedValueOnce(reply({}));
  await platform().submit(outcome);
  const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
  const wire = body.resourceSpans[0].scopeSpans[0].spans[0].attributes.find(
    (item: { key: string }) => item.key === 'langfuse.observation.input',
  ).value.stringValue as string;
  for (const input of [wire, JSON.parse(wire)]) {
    fetchMock.mockResolvedValueOnce(reply({ observations: [{ id: outcome.spanId, input }] }));
    expect(await platform().exists(outcome)).toBe(true);
  }
  const changed = JSON.parse(wire);
  changed.sources[0].value = 3;
  fetchMock.mockResolvedValueOnce(
    reply({ observations: [{ id: outcome.spanId, input: changed }] }),
  );
  await expect(platform().exists(outcome)).rejects.toThrow('不一致');
});

it('OTLP 提交保留来源含义、短引用、稳定标识，不通过本地模型执行', async () => {
  fetchMock.mockResolvedValueOnce(reply({}));
  await platform().submit(unit);
  const options = fetchMock.mock.calls[0]![1]!;
  const body = JSON.parse(options.body as string);
  const span = body.resourceSpans[0].scopeSpans[0].spans[0];
  expect(span).toMatchObject({ traceId: unit.traceId, spanId: unit.spanId, name: REVIEW_VERSION });
  const input = JSON.parse(
    span.attributes.find((item: { key: string }) => item.key === 'langfuse.observation.input').value
      .stringValue,
  );
  expect(input.sources[0]).toEqual({ id: 'E1', origin: { path: 'decision' }, value: 2 });
});

it('没有 score 的失败也读取原生执行追踪，忽略平台根 span 的默认零用量', async () => {
  fetchMock.mockResolvedValueOnce(
    reply({
      observations: [
        { type: 'SPAN', id: 'root' },
        { type: 'GENERATION', id: 'failed', level: 'ERROR' },
      ],
    }),
  );
  expect(await platform().generations(unit, profile)).toEqual([
    { type: 'GENERATION', id: 'failed', level: 'ERROR' },
  ]);
  expect(
    fetchMock.mock.calls[0]![0]!.toString().endsWith(
      '/api/public/traces/c121209da496d7f057a790662ae6ffc9',
    ),
  ).toBe(true);
});

it('模型生成完成但外层评价解析失败时立即报错，不误报为仍在等待', async () => {
  fetchMock
    .mockRejectedValue(new Error('错误地继续等待'))
    .mockResolvedValueOnce(reply(page([])))
    .mockResolvedValueOnce(
      reply({
        observations: [
          {
            type: 'GENERATION',
            level: 'DEFAULT',
            startTime: '2026-09-25T00:00:00Z',
            endTime: '2026-09-25T00:00:30.000Z',
          },
          {
            type: 'SPAN',
            level: 'ERROR',
            startTime: '2026-09-25T00:00:00Z',
            endTime: '2026-09-25T00:00:30.001Z',
          },
        ],
      }),
    );
  await expect(platform().wait(unit, profile)).rejects.toThrow('原生评价执行失败');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('更晚的执行已开始时不把历史失败当作本次失败，也不自行重投', async () => {
  fetchMock
    .mockResolvedValueOnce(reply(page([])))
    .mockResolvedValueOnce(
      reply({
        observations: [
          {
            type: 'SPAN',
            level: 'ERROR',
            startTime: '2026-09-25T00:00:00Z',
            endTime: '2026-09-25T00:00:30Z',
          },
          {
            type: 'GENERATION',
            level: 'DEFAULT',
            startTime: '2026-09-25T00:01:00Z',
            endTime: null,
          },
        ],
      }),
    )
    .mockResolvedValueOnce(
      reply(
        page([
          {
            id: 'score',
            observationId: unit.spanId,
            source: 'EVAL',
            comment: '判断 [E1]',
            executionTraceId: 'execution',
            metadata: { job_configuration_id: profile.ruleId },
          },
        ]),
      ),
    );
  expect((await platform().wait(unit, profile)).scoreId).toBe('score');
  expect(fetchMock.mock.calls.every(([, options]) => options!.method === 'GET')).toBe(true);
});

it('配置校验阻止规则停用、抽样、输入映射改变和未验证的平台版本', async () => {
  const evaluator = {
    id: 'e',
    name: REVIEW_VERSION,
    version: 1,
    scope: 'project',
    prompt: '{{input}}',
    outputDefinition: {},
    modelConfig: { provider: 'ds', model: 'm' },
  };
  const rule = {
    id: 'r',
    name: REVIEW_VERSION,
    status: 'active',
    target: 'observation',
    sampling: 1,
    filter: reviewFilter(),
    mapping: [{ variable: 'input', source: 'input' }],
    evaluator: { id: 'e' },
  };
  let current = { ...rule };
  fetchMock.mockImplementation(async (url) => {
    const path = new URL(url.toString()).pathname;
    if (path.endsWith('/health')) return reply({ version: '4.15.0' });
    if (path.endsWith('/evaluators')) return reply(page([evaluator]));
    if (path.endsWith('/evaluation-rules')) return reply(page([current]));
    return reply(page([{ provider: 'ds', adapter: 'openai' }]));
  });
  expect((await platform().profile()).evaluatorId).toBe('e');
  for (const change of [{ status: 'inactive' }, { sampling: 0.5 }, { mapping: [] }]) {
    current = { ...rule, ...change };
    await expect(platform().profile()).rejects.toThrow('未就绪');
  }
  fetchMock.mockResolvedValueOnce(reply({ version: '5.0.0' }));
  await expect(platform().profile()).rejects.toThrow('先核验');
});

it('平台错误不泄露响应里的密钥，也不自动重试提交', async () => {
  fetchMock.mockResolvedValueOnce(reply({ secretKey: 'should-not-leak' }, 500));
  await expect(platform().submit(unit)).rejects.toThrow('Langfuse 请求失败（HTTP 500）');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
