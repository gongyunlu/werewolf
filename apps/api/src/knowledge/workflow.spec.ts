import { randomUUID } from 'node:crypto';
import { KnowledgeContentSchema, KNOWLEDGE_CHARACTERS } from '@werewolf/shared';
import { initialRetrieval, retrieveExperiences } from '../experience/retrieval';
import {
  access,
  controlledPort,
  fixture,
  promptSource,
  result,
  vectorRuntime,
} from '../experience/testing';
import { runExperience } from '../experience/workflow';
import { indexExperience } from '../experience/indexing';
import { embeddingKey } from '../llm/embedding';
import { memoryStores } from '../store/memory';
import type { GameStores } from '../store/stores';
import { makeState, stubSkills, withRoles } from '../testing/fixtures';
import { modelActions } from '../turn/provider';
import { LOCAL_TURN_PROMPTS } from '../turn/prompt';
import { INITIAL_KNOWLEDGE } from './initial-content';
import { indexKnowledge, prepareKnowledgeIndex } from './indexing';

export async function indexed(stores: GameStores, n = 0) {
  const item = await stores.knowledge.saveDraft(randomUUID(), 0, INITIAL_KNOWLEDGE[n]!.content);
  const runtime = vectorRuntime();
  await prepareKnowledgeIndex(stores, item.versions[0]!, runtime);
  await indexKnowledge(stores, item.versions[0]!.versionId, runtime);
  await stores.knowledge.activate(
    item.id,
    item.revision,
    item.versions[0]!.versionId,
    embeddingKey(runtime),
  );
  return { item: (await stores.knowledge.find(item.id))!, runtime };
}
async function begin(stores: GameStores, day = 1) {
  const key = randomUUID();
  const state = initialRetrieval(
    {
      actor: { playerId: 'p1', seatNo: 1, role: '守卫' },
      day,
      task: '选择守护目标',
      visible: [],
      options: ['2号', '空守'],
      skill: [],
    },
    { gameId: 'new-game', boardId: '12p_wolf_king', role: 'guard' },
    'guard_protect',
  );
  await stores.actions.begin({
    actionKey: key,
    gameId: 'new-game',
    phaseInstanceId: 'night',
    actionType: 'guard_protect',
    actorId: 'p1',
    actionOrdinal: 0,
    ledgerSeq: 0,
    experienceRetrieval: state,
  });
  return { key, state };
}

describe('知识版本与逐行动输入', () => {
  it('初始资料有可定位来源、仅8条策略；非行动类型、空范围和非HTTP链接拒绝', () => {
    expect(INITIAL_KNOWLEDGE.filter((e) => e.content.kind === 'strategy')).toHaveLength(8);
    for (const item of INITIAL_KNOWLEDGE)
      expect(KnowledgeContentSchema.safeParse(item.content).success).toBe(true);
    const content = INITIAL_KNOWLEDGE[0]!.content;
    for (const patch of [
      { actionTypes: ['game_ended'] },
      { roles: [] },
      { sources: [{ ...content.sources[0], url: 'javascript:alert(1)' }] },
    ])
      expect(KnowledgeContentSchema.safeParse({ ...content, ...patch }).success).toBe(false);
  });

  it('保存草稿无模型调用，索引后修改开新版本；启用冲突和只读类型不能混入检索', async () => {
    const stores = memoryStores();
    const { item, runtime } = await indexed(stores);
    const old = item.versions[0]!;
    const next = await stores.knowledge.saveDraft(item.id, item.revision, {
      ...old.content,
      body: '修改后的观点',
    });
    expect(next.versions).toHaveLength(2);
    expect(next.activeVersionId).toBe(old.versionId);
    await expect(
      stores.knowledge.activate(
        next.id,
        next.revision,
        next.versions[1]!.versionId,
        embeddingKey(runtime),
      ),
    ).rejects.toThrow('索引');
    await expect(
      stores.knowledge.saveDraft(item.id, item.revision, { ...old.content, body: '过期编辑' }),
    ).rejects.toThrow('已被修改');
    expect(runtime.port.generate).toHaveBeenCalledTimes(1);
    const rule = await stores.knowledge.saveDraft(randomUUID(), 0, INITIAL_KNOWLEDGE[8]!.content);
    await expect(prepareKnowledgeIndex(stores, rule.versions[0]!, runtime)).rejects.toThrow(
      '暂不参与',
    );
  });

  it('向量已返回但保存失败时复用答复；并发索引只发一次，未知请求禁止重发', async () => {
    const stores = memoryStores();
    const item = await stores.knowledge.saveDraft(randomUUID(), 0, INITIAL_KNOWLEDGE[0]!.content);
    const version = item.versions[0]!;
    const runtime = vectorRuntime();
    await prepareKnowledgeIndex(stores, version, runtime);
    const save = stores.knowledge.saveIndex.bind(stores.knowledge);
    jest.spyOn(stores.knowledge, 'saveIndex').mockImplementation(async (row, state, vector) => {
      if (vector) throw new Error('模拟最终落库失败');
      return save(row, state, vector);
    });
    await expect(indexKnowledge(stores, version.versionId, runtime)).rejects.toThrow('模拟');
    jest.restoreAllMocks();
    await prepareKnowledgeIndex(
      stores,
      (await stores.knowledge.version(version.versionId))!,
      runtime,
    );
    await indexKnowledge(stores, version.versionId, runtime);
    expect(runtime.port.generate).toHaveBeenCalledTimes(1);
    const other = await stores.knowledge.saveDraft(randomUUID(), 0, version.content);
    await prepareKnowledgeIndex(stores, other.versions[0]!, runtime);
    const concurrent = await Promise.allSettled([
      indexKnowledge(stores, other.versions[0]!.versionId, runtime),
      indexKnowledge(stores, other.versions[0]!.versionId, runtime),
    ]);
    expect(concurrent.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(runtime.port.generate).toHaveBeenCalledTimes(2);
    const third = await stores.knowledge.saveDraft(randomUUID(), 0, version.content);
    const unknown = vectorRuntime();
    jest.mocked(unknown.port.generate).mockRejectedValue(new Error('网络状态未知'));
    await prepareKnowledgeIndex(stores, third.versions[0]!, unknown);
    await expect(indexKnowledge(stores, third.versions[0]!.versionId, unknown)).rejects.toThrow(
      '未知',
    );
    await expect(
      prepareKnowledgeIndex(
        stores,
        (await stores.knowledge.version(third.versions[0]!.versionId))!,
        unknown,
      ),
    ).rejects.toThrow('未知');
    expect(unknown.port.generate).toHaveBeenCalledTimes(1);
  });

  it('两类材料只嵌入一次查询，独立限额；停用只影响下一行动', async () => {
    const f = await fixture();
    f.input.boardId = '12p_wolf_king';
    f.input.role = 'guard';
    await runExperience(f.stores, f.row.id, {
      port: controlledPort(
        JSON.stringify({ ...result, experiences: Array(3).fill(result.experiences[0]) }),
      ),
      access,
      promptSource,
      prepare: f.prepare,
    });
    await indexExperience(f.stores, f.row.id, vectorRuntime());
    const known = await Promise.all([
      indexed(f.stores, 1),
      indexed(f.stores, 1),
      indexed(f.stores, 2),
    ]);
    const query = vectorRuntime();
    const first = await begin(f.stores, 3);
    const saved = await retrieveExperiences(f.stores, first.key, first.state, query);
    expect(query.port.generate).toHaveBeenCalledTimes(1);
    expect(saved.selected).toHaveLength(3);
    expect(saved.knowledge!.selected).toHaveLength(2);
    expect(saved.knowledge!.candidates).toHaveLength(3);
    expect(JSON.stringify(saved.knowledge!.selected).length).toBeLessThanOrEqual(
      KNOWLEDGE_CHARACTERS,
    );
    for (const k of known) await f.stores.knowledge.activate(k.item.id, k.item.revision, null, '');
    expect(await retrieveExperiences(f.stores, first.key, saved, query)).toEqual(saved);
    const second = await begin(f.stores, 3);
    expect(
      (await retrieveExperiences(f.stores, second.key, second.state, query)).knowledge!.selected,
    ).toEqual([]);
    expect(query.port.generate).toHaveBeenCalledTimes(2);
  });

  it('板型、角色、行动和首日限制生效，不适用时不调用；旧行动不追加知识', async () => {
    const stores = memoryStores();
    await indexed(stores);
    const base = { boardId: '12p_wolf_king', role: 'guard', actionType: 'guard_protect', day: 1 };
    expect(await stores.knowledge.hasCandidates(base)).toBe(true);
    const later = await indexed(stores, 2);
    expect(
      (await stores.knowledge.search(base, embeddingKey(later.runtime), [1, 0], 20)).some(
        (hit) => hit.knowledge.id === later.item.id,
      ),
    ).toBe(false);
    expect(
      (
        await stores.knowledge.search({ ...base, day: 3 }, embeddingKey(later.runtime), [1, 0], 20)
      ).some((hit) => hit.knowledge.id === later.item.id),
    ).toBe(true);
    for (const patch of [
      { boardId: '6p_white_wolf' },
      { role: 'seer' },
      { actionType: 'vote' },
      { day: 2 },
    ])
      expect(await stores.knowledge.hasCandidates({ ...base, ...patch })).toBe(false);
    const query = vectorRuntime();
    const { key, state } = await begin(stores, 2);
    expect((await retrieveExperiences(stores, key, state, query)).knowledge!.selected).toEqual([]);
    expect(query.port.generate).not.toHaveBeenCalled();
    const old = await begin(stores);
    delete old.state.knowledge;
    const legacy = { ...old.state, status: 'completed' as const };
    expect((await retrieveExperiences(stores, old.key, legacy, query)).knowledge).toBeUndefined();
  });

  it('生成、复核、修订接收同版正文；恢复已完成行动不重检索、不重发模型', async () => {
    const stores = memoryStores();
    const { item } = await indexed(stores);
    await stores.games.open({ gameId: 'guard-game', boardId: '12p_wolf_king', roster: [] });
    const model = controlledPort((request) =>
      request.prompt.includes('他交上来的结果')
        ? JSON.stringify({ accept: false, issues: '离线用例要求修订' })
        : '2',
    );
    const generate = jest.spyOn(model, 'generate');
    const query = vectorRuntime();
    const runtime = {
      port: model,
      accessFor: () => access,
      memoriesFor: () => [],
      skills: stubSkills(),
      promptSource: LOCAL_TURN_PROMPTS,
      embedding: query,
    };
    const state = withRoles({ ...makeState(3, false), gameId: 'guard-game' }, { p1: 'guard' });
    const actions = modelActions(runtime, stores);
    actions.observe(state);
    await actions.guardProtect('p1', ['p2', 'p3']);
    const outcome = actions.outcomes()[0]!;
    const inputs = await stores.asked.knowledgeInputs('guard-game', outcome.snapshot.actionKey);
    expect(inputs.map((v) => v.step)).toEqual(['generate', 'critique', 'revise']);
    expect(
      inputs.every(
        (v) => v.dispatched && v.knowledge[0]?.versionId === item.versions[0]!.versionId,
      ),
    ).toBe(true);
    expect(
      generate.mock.calls.every(([request]) =>
        request.prompt.includes(item.versions[0]!.content.body),
      ),
    ).toBe(true);
    await stores.knowledge.activate(item.id, item.revision, null, '');
    const resumed = modelActions(runtime, stores, state.phaseInstanceId);
    resumed.observe(state);
    await resumed.guardProtect('p1', ['p2', 'p3']);
    expect(resumed.outcomes()[0]!.snapshot.context.knowledge).toEqual(
      outcome.snapshot.context.knowledge,
    );
    expect(generate).toHaveBeenCalledTimes(3);
    expect(query.port.generate).toHaveBeenCalledTimes(1);
  });
});
