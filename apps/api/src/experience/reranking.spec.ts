import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { INITIAL_KNOWLEDGE } from '../knowledge/initial-content';
import { InvalidOutputError } from '../llm/model-port';
import { toolOf } from '../llm/structured-output';
import { memoryStores } from '../store/memory';
import { knowledgeDocument } from './retrieval';
import { newRerankTask, parseRerankResponse, rerankReferences, type RerankTask } from './reranking';
import { access, controlledPort, failNextAttemptObservation } from './testing';

const values = [
  {
    key: 'knowledge/a77c2341-d748-4949-be30-68ac416ff2a3',
    relevance: 2,
    applicable: true,
    duplicateOf: null,
    reason:
      "适用条件（白天出现预言家声明后的夜晚＋可见发言与本人守护记录）在第3天夜成立；但两名预言家声明者7、8均已出局，'保护预言家'分支失效，仅剩自守/可信好人取舍与不知女巫用药需保留不确定性等部分参考，故非直接可用。",
  },
  {
    key: 'knowledge/d22ee848-c044-46c2-bf33-b8151e73bdd2',
    relevance: 3,
    applicable: true,
    duplicateOf: null,
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
  it('第三夜守护答复明确提交无重复关系，不丢失评分和理由', () => {
    expect(parse(values)).toEqual(values);
  });

  it('显式空关系和合法重复关系保留原意', () => {
    const rows = [
      { ...values[0], duplicateOf: null },
      { ...values[1], duplicateOf: values[0]!.key },
    ];
    expect(parse(rows)).toEqual(rows);
  });

  it('工具定义的所有字段均必填，重复关系允许为 null', () => {
    const task = newRerankTask('第三夜选择守护目标', candidates, {
      access,
      port: controlledPort('[]'),
    });
    expect(task.request.tool!.parameters).toMatchObject({
      properties: {
        value: {
          items: {
            required: ['key', 'relevance', 'applicable', 'reason', 'duplicateOf'],
            properties: { duplicateOf: { type: ['string', 'null'] } },
          },
        },
      },
    });
  });

  it.each(['key', 'relevance', 'applicable', 'reason', 'duplicateOf'])(
    '缺少必填字段 %s 仍然拒绝',
    (field) => {
      const incomplete = Object.fromEntries(
        Object.entries({ ...values[0], duplicateOf: null }).filter(([key]) => key !== field),
      );
      expect(() => parse([incomplete, { ...values[1], duplicateOf: null }])).toThrow(
        InvalidOutputError,
      );
    },
  );

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

async function failedTask(value: unknown, legacy = false) {
  const stores = memoryStores();
  const scope = { gameId: 'game', actionKey: 'action' };
  await stores.games.open({ gameId: scope.gameId, boardId: '12p_wolf_king', roster: [] });
  const port = controlledPort(JSON.stringify(values));
  const runtime = { access, port: { generate: jest.fn(port.generate) } };
  const task = newRerankTask('第三夜选择守护目标', candidates, runtime);
  if (legacy) {
    task.request.system = task.request.system.replace(
      '每项都必须提交 duplicateOf，无重复关系时填 null。',
      '无重复关系时省略 duplicateOf 或填 null。',
    );
    task.request.tool = toolOf(
      z.array(
        z.object({
          key: z.string(),
          relevance: z.number().int().min(0).max(3),
          applicable: z.boolean(),
          reason: z.string().min(1).max(240),
          duplicateOf: z.string().nullable().optional(),
        }),
      ),
      '提交每条参考材料的适用性与相关性评价',
    );
  }
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
  const legacyValues = values.map(({ key, relevance, applicable, reason }) => ({
    key,
    relevance,
    applicable,
    reason,
  }));

  it.each(['responded', 'failed'] as const)(
    '旧请求的 %s 答复省略重复关系时直接恢复，不再调用模型',
    async (status) => {
      const f = await failedTask(legacyValues, true);
      f.task.attempts[0]!.status = status;
      const request = structuredClone(f.task.request);
      await expect(
        rerankReferences(f.stores, f.scope, f.task, candidates, undefined, f.save),
      ).resolves.toEqual(values);
      expect(f.runtime.port.generate).not.toHaveBeenCalled();
      expect(f.saved().attempts).toHaveLength(1);
      expect(f.saved().attempts[0]!.status).toBe('responded');
      expect(f.saved().request).toEqual(request);
    },
  );

  it('旧请求需要重发时仍按已保存的可选字段契约解析新答复', async () => {
    const f = await failedTask([], true);
    f.runtime.port.generate.mockImplementation(
      controlledPort(JSON.stringify(legacyValues)).generate,
    );
    const request = structuredClone(f.task.request);
    await expect(
      rerankReferences(f.stores, f.scope, f.task, candidates, f.runtime, f.save),
    ).resolves.toEqual(values);
    expect(f.runtime.port.generate).toHaveBeenCalledTimes(1);
    expect(f.runtime.port.generate.mock.calls[0]![0]).toEqual(request);
    expect(f.saved().attempts.map((row) => row.status)).toEqual(['failed', 'responded']);
  });

  it('新请求的已保存答复省略重复关系时仍拒绝', async () => {
    const f = await failedTask(legacyValues);
    f.task.attempts[0]!.status = 'responded';
    await expect(
      rerankReferences(f.stores, f.scope, f.task, candidates, undefined, f.save),
    ).rejects.toThrow(InvalidOutputError);
    expect(f.runtime.port.generate).not.toHaveBeenCalled();
  });

  it('重排题面写入失败未派发，恢复允许第一次模型调用', async () => {
    const f = await failedTask([]);
    jest.spyOn(f.stores.asked, 'append').mockRejectedValueOnce(new Error('模拟题面写入失败'));
    await expect(
      rerankReferences(f.stores, f.scope, f.task, candidates, f.runtime, f.save),
    ).rejects.toThrow();
    expect(f.runtime.port.generate).not.toHaveBeenCalled();
    expect(f.saved().attempts.at(-1)!.status).toBe('failed');
    await expect(
      rerankReferences(f.stores, f.scope, f.saved(), candidates, f.runtime, f.save),
    ).resolves.toHaveLength(2);
    expect(f.runtime.port.generate).toHaveBeenCalledTimes(1);
  });

  it('重排观测失败先抛错，恢复先补用量再返回旧评价', async () => {
    const f = await failedTask([]);
    failNextAttemptObservation(f.stores);
    await expect(
      rerankReferences(f.stores, f.scope, f.task, candidates, f.runtime, f.save),
    ).rejects.toThrow('模型观测写入失败');
    expect(f.saved().attempts.at(-1)).toMatchObject({
      status: 'responded',
      observation: expect.anything(),
    });
    await expect(
      rerankReferences(f.stores, f.scope, f.saved(), candidates, undefined, f.save),
    ).resolves.toHaveLength(2);
    expect(f.runtime.port.generate).toHaveBeenCalledTimes(1);
    expect((await f.stores.observations.read(f.scope.gameId))!.calls.at(-1)).toMatchObject({
      status: 'accepted',
      attempts: [{ status: 'succeeded', usage: { total_tokens: 15 } }],
    });
  });

  it('复用已保存的合法答复，不重发请求，也不覆盖原 invalid_output 观测', async () => {
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
