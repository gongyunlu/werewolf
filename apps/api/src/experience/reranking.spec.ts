import { randomUUID } from 'node:crypto';
import { INITIAL_KNOWLEDGE } from '../knowledge/initial-content';
import { InvalidOutputError } from '../llm/model-port';
import { memoryStores } from '../store/memory';
import { knowledgeDocument } from './retrieval';
import { newRerankTask, parseRerankResponse, rerankReferences, type RerankTask } from './reranking';
import { access, controlledPort } from './testing';

const values = [
  {
    key: 'knowledge/a77c2341-d748-4949-be30-68ac416ff2a3',
    relevance: 2,
    applicable: true,
    reason:
      "适用条件（白天出现预言家声明后的夜晚＋可见发言与本人守护记录）在第3天夜成立；但两名预言家声明者7、8均已出局，'保护预言家'分支失效，仅剩自守/可信好人取舍与不知女巫用药需保留不确定性等部分参考，故非直接可用。",
  },
  {
    key: 'knowledge/d22ee848-c044-46c2-bf33-b8151e73bdd2',
    relevance: 3,
    applicable: true,
    reason:
      '符合中后期守护条件：第3天夜、已有多次出局信息与身份声明。提供本次决策方法——只按本人视角列出可能局面，在2/3/4/5/10/11/12合法项内比较神职与平民生存压力，且不把死亡或报药当作身份/药量事实。',
  },
];
const candidates = values.map(({ key }) => ({
  ...knowledgeDocument({
    id: randomUUID(),
    versionId: key.slice('knowledge/'.length),
    version: 1,
    content: INITIAL_KNOWLEDGE[0]!.content,
  }),
  fusionScore: 1,
}));

function parse(value: unknown) {
  return parseRerankResponse(
    { toolCall: { name: 'submit', arguments: JSON.stringify({ value }) } },
    candidates,
  );
}

describe('重排输出契约', () => {
  it('第三夜守护答复省略重复关系时按无重复处理，不丢失评分和理由', () => {
    expect(parse(values)).toEqual(values.map((row) => ({ ...row, duplicateOf: null })));
  });

  it('显式空关系和合法重复关系保留原意', () => {
    const rows = [
      { ...values[0], duplicateOf: null },
      { ...values[1], duplicateOf: values[0]!.key },
    ];
    expect(parse(rows)).toEqual(rows);
  });

  it('工具定义只将重复关系设为可选，评分、适用性和理由仍必填', () => {
    const task = newRerankTask('第三夜选择守护目标', candidates, {
      access,
      port: controlledPort('[]'),
    });
    expect(task.request.tool!.parameters).toMatchObject({
      properties: {
        value: {
          items: {
            required: ['key', 'relevance', 'applicable', 'reason'],
            properties: { duplicateOf: { type: ['string', 'null'] } },
          },
        },
      },
    });
  });

  it.each(['key', 'relevance', 'applicable', 'reason'])('缺少必填字段 %s 仍然拒绝', (field) => {
    const incomplete = Object.fromEntries(
      Object.entries({ ...values[0], duplicateOf: null }).filter(([key]) => key !== field),
    );
    expect(() => parse([incomplete, { ...values[1], duplicateOf: null }])).toThrow(
      InvalidOutputError,
    );
  });

  it.each([
    { name: '未知候选', patch: { key: 'knowledge/不存在' } },
    { name: '重复候选', patch: { key: values[1]!.key } },
    { name: '未知重复目标', patch: { duplicateOf: 'knowledge/不存在' } },
    { name: '引用自身', patch: { duplicateOf: values[0]!.key } },
    { name: '错误关系类型', patch: { duplicateOf: false } },
  ])('$name 仍然拒绝', ({ patch }) => {
    expect(() =>
      parse([
        { ...values[0], duplicateOf: null, ...patch },
        { ...values[1], duplicateOf: null },
      ]),
    ).toThrow(InvalidOutputError);
  });

  it('漏交候选仍然拒绝', () => {
    expect(() => parse([{ ...values[0], duplicateOf: null }])).toThrow(InvalidOutputError);
  });
});

async function failedTask(value: unknown) {
  const stores = memoryStores();
  const scope = { gameId: 'game', actionKey: 'action' };
  await stores.games.open({ gameId: scope.gameId, boardId: '12p_wolf_king', roster: [] });
  const port = controlledPort(JSON.stringify(values));
  const runtime = { access, port: { generate: jest.fn(port.generate) } };
  const task = newRerankTask('第三夜选择守护目标', candidates, runtime);
  const callId = randomUUID();
  await stores.asked.append(scope.gameId, {
    ...task.request,
    model: task.model,
    actionKey: scope.actionKey,
    observation: {
      callId,
      executionId: randomUUID(),
      step: 'reference_rerank',
      formatAttempt: 1,
      endpointKey: 'offline',
    },
  });
  await stores.asked.finishCall(callId, {
    status: 'invalid_output',
    failureCode: 'invalid_output',
    durationMs: 1,
  });
  task.attempts.push({
    callId,
    status: 'failed',
    durationMs: 1,
    response: {
      content: '',
      reasoning: null,
      toolCall: { name: 'submit', arguments: JSON.stringify({ value }) },
    },
  });
  let saved = task;
  const save = jest.fn(async (next: RerankTask) => {
    saved = next;
  });
  return { stores, scope, task, runtime, save, saved: () => saved };
}

describe('重排中断恢复', () => {
  it('契约修正后复用已保存的答复，不重发请求，也不覆盖原 invalid_output 观测', async () => {
    const f = await failedTask(values);
    const result = await rerankReferences(f.stores, f.scope, f.task, candidates, undefined, f.save);
    expect(result).toEqual(values.map((row) => ({ ...row, duplicateOf: null })));
    expect(f.runtime.port.generate).not.toHaveBeenCalled();
    expect(f.saved().attempts).toHaveLength(1);
    expect(f.saved().attempts[0]!.status).toBe('responded');
    expect((await f.stores.observations.read(f.scope.gameId))!.calls).toMatchObject([
      { status: 'invalid_output', failureCode: 'invalid_output' },
    ]);
  });

  it('人工恢复时旧答复仍缺候选，只发一次新请求', async () => {
    const f = await failedTask([]);
    await expect(
      rerankReferences(f.stores, f.scope, f.task, candidates, f.runtime, f.save),
    ).resolves.toHaveLength(2);
    expect(f.runtime.port.generate).toHaveBeenCalledTimes(1);
    expect(f.saved().attempts.map((row) => row.status)).toEqual(['failed', 'responded']);
  });

  it('新答复仍非法时停止，不在一次恢复中继续格式重试', async () => {
    const f = await failedTask([]);
    f.runtime.port.generate.mockImplementation(controlledPort('[]').generate);
    await expect(
      rerankReferences(f.stores, f.scope, f.task, candidates, f.runtime, f.save),
    ).rejects.toThrow(InvalidOutputError);
    expect(f.runtime.port.generate).toHaveBeenCalledTimes(1);
    expect(f.saved().attempts.map((row) => row.status)).toEqual(['failed', 'failed']);
  });

  it('旧答复仍非法且未提供模型接入时明确失败', async () => {
    const f = await failedTask([]);
    await expect(
      rerankReferences(f.stores, f.scope, f.task, candidates, undefined, f.save),
    ).rejects.toThrow('缺少本次行动的模型接入');
    expect(f.runtime.port.generate).not.toHaveBeenCalled();
  });

  it('pending 的请求结果未知，不能重复发送', async () => {
    const f = await failedTask(values);
    f.task.attempts[0]!.status = 'pending';
    await expect(
      rerankReferences(f.stores, f.scope, f.task, candidates, f.runtime, f.save),
    ).rejects.toThrow('上次重排请求结果未知');
    expect(f.runtime.port.generate).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });
});
