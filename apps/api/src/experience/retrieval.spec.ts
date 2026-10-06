import { randomUUID } from 'node:crypto';
import { ModelCallError } from '../llm/model-port';
import { memoryStores } from '../store/memory';
import { INITIAL_KNOWLEDGE } from '../knowledge/initial-content';
import { prepareKnowledgeIndex, indexKnowledge } from '../knowledge/indexing';
import { knowledgeEmbeddingKey } from '../knowledge/text';
import { access, controlledPort, vectorRuntime } from './testing';
import { initialRetrieval, retrieveExperiences } from './retrieval';
import type { ReferenceJudgment } from './retrieval-ranking';
import * as embeddings from '../llm/embedding';

async function setup(mode: 'hybrid' | 'none' = 'hybrid') {
  const stores = memoryStores();
  const item = await stores.knowledge.saveDraft(randomUUID(), 0, INITIAL_KNOWLEDGE[0]!.content);
  const embedding = vectorRuntime();
  await prepareKnowledgeIndex(stores, item.versions[0]!, embedding);
  await indexKnowledge(stores, item.versions[0]!.versionId, embedding);
  await stores.knowledge.activate(
    item.id,
    item.revision,
    item.versions[0]!.versionId,
    knowledgeEmbeddingKey(embedding),
  );
  const key = randomUUID();
  const state = initialRetrieval(
    {
      actor: { playerId: 'p1', seatNo: 1, role: '守卫' },
      day: 1,
      task: '第一夜选择守护目标',
      skill: ['禁连守'],
      options: ['空守', '2号'],
      visible: [{ title: '你手里的牌', lines: ['你还没守过人。'] }],
    },
    { gameId: 'game', boardId: '12p_wolf_king', role: 'guard' },
    'guard_protect',
    mode,
  );
  await stores.actions.begin({
    actionKey: key,
    gameId: 'game',
    phaseInstanceId: 'night',
    actionType: 'guard_protect',
    actorId: 'p1',
    actionOrdinal: 0,
    ledgerSeq: 0,
    experienceRetrieval: state,
  });
  return { stores, key, state, embedding, item };
}

function rerank(patch: Partial<ReferenceJudgment> = {}) {
  const port = controlledPort((request) =>
    JSON.stringify(
      (JSON.parse(request.prompt) as { candidates: Array<{ key: string }> }).candidates.map(
        ({ key }) => ({
          key,
          relevance: 3,
          applicable: true,
          reason: '适用于第一夜已知局面',
          duplicateOf: null,
          ...patch,
        }),
      ),
    ),
  );
  return { port: { generate: jest.fn(port.generate) }, access };
}

describe('行动混合检索与重排冻结', () => {
  it.each(['provided', 'default'] as const)(
    '行动取消会阻止 %s 向量接入派发请求',
    async (source) => {
      const f = await setup();
      const runtime = vectorRuntime();
      const fallback = jest.spyOn(embeddings, 'embeddingRuntime').mockReturnValue(runtime);
      const controller = new AbortController();
      controller.abort();
      try {
        await expect(
          retrieveExperiences(
            f.stores,
            f.key,
            f.state,
            source === 'provided' ? runtime : undefined,
            rerank(),
            controller.signal,
          ),
        ).rejects.toMatchObject({ code: 'deadline' });
        expect(runtime.port.generate).not.toHaveBeenCalled();
      } finally {
        fallback.mockRestore();
      }
    },
  );

  it('查询向量完成后行动取消，不再派发重排请求', async () => {
    const f = await setup();
    const controller = new AbortController();
    const generate = jest.mocked(f.embedding.port.generate).getMockImplementation()!;
    jest.mocked(f.embedding.port.generate).mockImplementationOnce(async (...args) => {
      const response = await generate(...args);
      controller.abort();
      return response;
    });
    const model = rerank();
    await expect(
      retrieveExperiences(f.stores, f.key, f.state, f.embedding, model, controller.signal),
    ).rejects.toMatchObject({ code: 'deadline' });
    expect(model.port.generate).not.toHaveBeenCalled();
  });

  it('新行动冻结hybrid-v3与门槛2，适用的2分材料进入实际注入', async () => {
    const f = await setup();
    expect(f.state).toMatchObject({ policyVersion: 'hybrid-v3', minRelevance: 2 });
    const saved = await retrieveExperiences(
      f.stores,
      f.key,
      f.state,
      f.embedding,
      rerank({ relevance: 2 }),
    );
    expect(saved.knowledge!.selected).toHaveLength(1);
    expect(saved).toMatchObject({ policyVersion: 'hybrid-v3', minRelevance: 2 });
    expect(saved.knowledge!.candidates[0]).toMatchObject({ rerankScore: 2, rejection: null });
  });

  it('新行动保存各路分数、重排理由、完整候选与实际调用', async () => {
    const f = await setup();
    const model = rerank();
    const saved = await retrieveExperiences(f.stores, f.key, f.state, f.embedding, model);
    expect(saved.knowledge!.selected).toHaveLength(1);
    expect(saved.frozenCandidates).toHaveLength(1);
    expect(saved.knowledge!.candidates[0]).toMatchObject({
      vectorRank: 1,
      keywordRank: 1,
      rerankScore: 3,
      applicable: true,
      rejection: null,
    });
    expect(saved.reranking!.attempts[0]!.status).toBe('responded');
    expect(saved.reranking!.request.prompt).toContain('你还没守过人');
    expect(model.port.generate).toHaveBeenCalledTimes(1);
    expect(model.port.generate.mock.calls[0]![2]!.identity!.step).toBe('reference_rerank');
  });

  it('重排缺少必填的重复关系时停止，保留无效答复供核查', async () => {
    const f = await setup();
    const model = rerank({ duplicateOf: undefined });
    await expect(retrieveExperiences(f.stores, f.key, f.state, f.embedding, model)).rejects.toThrow(
      '不符合要求',
    );
    const saved = (await f.stores.actions.find(f.key))!.experienceRetrieval!;
    expect(saved.status).toBe('failed');
    expect(saved.knowledge!.selected).toHaveLength(0);
    expect(model.port.generate).toHaveBeenCalledTimes(1);
  });

  it.each([{ applicable: false }, { relevance: 1 }])(
    '高向量分数也允许因不适用或主题相近返回空：%j',
    async (patch) => {
      const f = await setup();
      const saved = await retrieveExperiences(f.stores, f.key, f.state, f.embedding, rerank(patch));
      expect(saved.knowledge!.selected).toEqual([]);
      expect(saved.knowledge!.candidates[0]!.reason).toBeTruthy();
    },
  );

  it('none模式不检索、不嵌入、不重排', async () => {
    const f = await setup('none');
    const search = jest.spyOn(f.stores.knowledge, 'hasCandidates');
    const model = rerank();
    const before = jest.mocked(f.embedding.port.generate).mock.calls.length;
    const saved = await retrieveExperiences(f.stores, f.key, f.state, f.embedding, model);
    expect(saved.knowledge!.selected).toEqual([]);
    expect(search).not.toHaveBeenCalled();
    expect(model.port.generate).not.toHaveBeenCalled();
    expect(f.embedding.port.generate).toHaveBeenCalledTimes(before);
  });

  it('完成后停用不改变快照，也不重新查询候选', async () => {
    const f = await setup();
    const model = rerank();
    const saved = await retrieveExperiences(f.stores, f.key, f.state, f.embedding, model);
    await f.stores.knowledge.activate(f.item.id, f.item.revision + 1, null, '');
    jest
      .spyOn(f.stores.knowledge, 'hasCandidates')
      .mockRejectedValue(new Error('不应读取在线知识'));
    expect(await retrieveExperiences(f.stores, f.key, saved)).toEqual(saved);
    expect(model.port.generate).toHaveBeenCalledTimes(1);
  });

  it('最终保存失败后复用冻结候选和重排答复，不依赖已经变更的在线语料', async () => {
    const f = await setup();
    const model = rerank();
    const originalSave = f.stores.actions.saveRetrieval.bind(f.stores.actions);
    jest
      .spyOn(f.stores.actions, 'saveRetrieval')
      .mockImplementation(async (key, previous, next) => {
        if (next.status === 'completed') throw new Error('模拟最终保存失败');
        return originalSave(key, previous, next);
      });
    await expect(retrieveExperiences(f.stores, f.key, f.state, f.embedding, model)).rejects.toThrow(
      '模拟最终',
    );
    const saved = (await f.stores.actions.find(f.key))!.experienceRetrieval!;
    expect(saved.reranking!.attempts[0]!.status).toBe('responded');
    jest.restoreAllMocks();
    jest.spyOn(f.stores.knowledge, 'hasCandidates').mockRejectedValue(new Error('不应重查'));
    const completed = await retrieveExperiences(f.stores, f.key, saved);
    expect(completed.knowledge!.selected).toHaveLength(1);
    expect(model.port.generate).toHaveBeenCalledTimes(1);
  });

  it('重排失败明确停止行动，恢复复用候选，绝不静默改用向量排名', async () => {
    const f = await setup();
    const model = rerank();
    model.port.generate.mockRejectedValueOnce(new ModelCallError('transient', '模拟限流'));
    await expect(retrieveExperiences(f.stores, f.key, f.state, f.embedding, model)).rejects.toThrow(
      '模拟限流',
    );
    const saved = (await f.stores.actions.find(f.key))!.experienceRetrieval!;
    expect(saved.status).toBe('failed');
    expect(saved.knowledge!.selected).toEqual([]);
    jest.spyOn(f.stores.knowledge, 'search').mockRejectedValue(new Error('不应重查'));
    expect(
      (await retrieveExperiences(f.stores, f.key, saved, undefined, model)).knowledge!.selected,
    ).toHaveLength(1);
    expect(model.port.generate).toHaveBeenCalledTimes(2);
  });

  it('未知重排请求禁止重复发送；漏交候选视为无效答复', async () => {
    const f = await setup();
    const model = rerank();
    model.port.generate.mockRejectedValueOnce(new Error('未知传输状态'));
    await expect(retrieveExperiences(f.stores, f.key, f.state, f.embedding, model)).rejects.toThrow(
      '未知传输',
    );
    const saved = (await f.stores.actions.find(f.key))!.experienceRetrieval!;
    await expect(retrieveExperiences(f.stores, f.key, saved, f.embedding, model)).rejects.toThrow(
      '上次重排',
    );
    expect(model.port.generate).toHaveBeenCalledTimes(1);
    const other = await setup();
    await expect(
      retrieveExperiences(other.stores, other.key, other.state, other.embedding, {
        access,
        port: controlledPort('[]'),
      }),
    ).rejects.toThrow('候选编号');
  });

  it('向量答复已保存但尚未冻结候选时，换同维度模型也不能混用知识索引', async () => {
    const f = await setup();
    jest.spyOn(f.stores.knowledge, 'search').mockRejectedValueOnce(new Error('模拟召回中断'));
    await expect(
      retrieveExperiences(f.stores, f.key, f.state, f.embedding, rerank()),
    ).rejects.toThrow('模拟召回');
    const saved = (await f.stores.actions.find(f.key))!.experienceRetrieval!;
    expect(saved.embedding!.attempts[0]!.status).toBe('responded');
    const changed = { ...f.embedding, access: { ...f.embedding.access, model: '另一向量模型' } };
    await expect(retrieveExperiences(f.stores, f.key, saved, changed, rerank())).rejects.toThrow(
      '另一套索引',
    );
  });

  it('重排失败后同名模型换端点或能力不能重试，已有答复仍可独立恢复', async () => {
    const f = await setup();
    const model = rerank();
    model.port.generate.mockRejectedValueOnce(new ModelCallError('transient', '模拟失败'));
    await expect(retrieveExperiences(f.stores, f.key, f.state, f.embedding, model)).rejects.toThrow(
      '模拟失败',
    );
    let saved = (await f.stores.actions.find(f.key))!.experienceRetrieval!;
    await expect(
      retrieveExperiences(f.stores, f.key, saved, undefined, {
        ...model,
        access: { ...access, baseUrl: 'https://other.test/v1' },
      }),
    ).rejects.toThrow('重排接入');
    saved = (await f.stores.actions.find(f.key))!.experienceRetrieval!;
    await expect(
      retrieveExperiences(f.stores, f.key, saved, undefined, {
        ...model,
        access: { ...access, capability: { reasoningOff: { thinking: { type: 'disabled' } } } },
      }),
    ).rejects.toThrow('重排接入');
    expect(model.port.generate).toHaveBeenCalledTimes(1);
  });
});
