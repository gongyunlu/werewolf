import { LOCAL_PROMPTS } from '../prompts/catalog';
import { ACTION_TYPES, ROLES } from '@werewolf/shared';
import { randomUUID } from 'node:crypto';
import { runExperience } from './workflow';
import {
  fixture,
  result,
  access,
  promptSource,
  controlledPort,
  vectorRuntime,
  approveExperience,
} from './testing';
import { EXPERIENCE_CHARACTERS, renderExperiences } from './selection';
import { modelActions } from '../turn/provider';
import { makeState, stubSkills, withRoles } from '../testing/fixtures';
import { initialRetrieval, retrieveExperiences, retrievalQuery } from './retrieval';
import { indexExperience as buildIndex } from './indexing';
import type { EmbeddingRuntime } from '../llm/embedding';
import { embeddingKey } from '../llm/embedding';
import type { GameStores } from '../store/stores';
import type { TurnContext } from '../turn/request';

const context: TurnContext = {
  actor: { playerId: 'p1', seatNo: 1, role: '平民' },
  day: 2,
  task: '投票',
  skill: [],
  options: ['2 号', '3 号'],
  visible: [{ title: '公开信息', lines: ['先有发言，后有查验说法'] }],
};
const scope = { gameId: 'next', boardId: '6p_white_wolf', role: 'villager' };
async function begin(stores: GameStores, key = randomUUID(), selectedScope = scope) {
  const state = initialRetrieval(context, selectedScope, ACTION_TYPES.VOTE, 'vector');
  await stores.actions.begin({
    actionKey: key,
    gameId: selectedScope.gameId,
    phaseInstanceId: 'day',
    actionType: ACTION_TYPES.VOTE,
    actorId: 'p1',
    actionOrdinal: 0,
    ledgerSeq: 0,
    experienceRetrieval: state,
  });
  return { key, state };
}
async function indexExperience(stores: GameStores, id: string, runtime: EmbeddingRuntime) {
  await buildIndex(stores, id, runtime);
  const generation = (await stores.experiences.findGeneration(id))!;
  for (const item of (await stores.experiences.list(generation.agentId)).filter(
    (candidate) => candidate.generationId === id,
  ))
    await approveExperience(stores, item.id, runtime);
}
async function extracted(stores?: GameStores, count = 1) {
  const f = await fixture(stores);
  await runExperience(f.stores, f.row.id, {
    port: controlledPort(
      JSON.stringify({
        ...result,
        experiences: Array.from({ length: count }, (_, i) => ({
          ...result.experiences[0]!,
          title: `时序经验${i}`,
        })),
      }),
    ),
    access,
    promptSource,
    prepare: f.prepare,
  });
  return f;
}

describe('逐行动语义检索', () => {
  it('实际行动材料保留审核过的不适用条件', async () => {
    const f = await extracted();
    const items = await f.stores.experiences.list(f.agent.id);
    expect(renderExperiences(items)).toContain(`不适用条件：${items[0]!.exclusions}`);
  });

  it('未审核经验不参与检索；向量相似度不为正允许空结果', async () => {
    const f = await extracted();
    const first = await begin(f.stores);
    const embedding = vectorRuntime();
    expect(
      (await retrieveExperiences(f.stores, first.key, first.state, embedding)).selected,
    ).toEqual([]);
    expect(embedding.port.generate).not.toHaveBeenCalled();
    await indexExperience(f.stores, f.row.id, vectorRuntime([-1, 0]));
    const next = await begin(f.stores);
    expect((await retrieveExperiences(f.stores, next.key, next.state, embedding)).selected).toEqual(
      [],
    );
    expect(embedding.port.generate).toHaveBeenCalledTimes(1);
  });
  it('共享池按语义排序，不按归属或新旧优先；数量长度有界', async () => {
    const own = await extracted(undefined, 3);
    const shared = await extracted(own.stores, 3);
    await indexExperience(own.stores, own.row.id, vectorRuntime([0.6, 0.8]));
    await indexExperience(own.stores, shared.row.id, vectorRuntime([1, 0]));
    const { key, state } = await begin(own.stores);
    const selected = await retrieveExperiences(own.stores, key, state, vectorRuntime());
    expect(selected.candidates).toHaveLength(6);
    expect(selected.selected).toHaveLength(3);
    expect(selected.selected.every((item) => item.agentId === shared.agent.id)).toBe(true);
    expect(JSON.stringify(selected.selected).length).toBeLessThanOrEqual(EXPERIENCE_CHARACTERS);
    expect(await own.stores.experiences.toggle(own.agent.id, selected.selected[0]!.id, false)).toBe(
      false,
    );
  });

  it('当次结果保存后停用不改变输入，下一行动重新检索，重新启用可再次命中', async () => {
    const f = await extracted();
    const embedding = vectorRuntime();
    await indexExperience(f.stores, f.row.id, embedding);
    const first = await begin(f.stores);
    const saved = await retrieveExperiences(f.stores, first.key, first.state, embedding);
    const id = saved.selected[0]!.id;
    await f.stores.experiences.toggle(f.agent.id, id, false);
    expect(await retrieveExperiences(f.stores, first.key, saved, embedding)).toEqual(saved);
    const second = await begin(f.stores);
    expect(
      (await retrieveExperiences(f.stores, second.key, second.state, embedding)).selected,
    ).toEqual([]);
    expect(embedding.port.generate).toHaveBeenCalledTimes(2);
    await f.stores.experiences.toggle(f.agent.id, id, true, undefined, embeddingKey(embedding));
    const third = await begin(f.stores);
    expect(
      (await retrieveExperiences(f.stores, third.key, third.state, embedding)).selected[0]!.id,
    ).toBe(id);
    expect(embedding.port.generate).toHaveBeenCalledTimes(3);
  });

  it.each([
    { ...scope, boardId: '其他板子' },
    { ...scope, role: 'witch' },
  ])('不适用的板子、角色无调用：%j', async (other) => {
    const f = await extracted();
    const embedding = vectorRuntime();
    const first = await begin(f.stores, undefined, other);
    expect(
      (await retrieveExperiences(f.stores, first.key, first.state, embedding)).selected,
    ).toEqual([]);
    expect(embedding.port.generate).not.toHaveBeenCalled();
  });

  it('来源局不能检索自己的赛后经验；查询只使用玩家已有视角且限制长度', async () => {
    const f = await extracted();
    const embedding = vectorRuntime();
    const first = await begin(f.stores, undefined, { ...scope, gameId: f.gameId });
    expect(
      (await retrieveExperiences(f.stores, first.key, first.state, embedding)).selected,
    ).toEqual([]);
    expect(embedding.port.generate).not.toHaveBeenCalled();
    const query = retrievalQuery(
      { ...context, visible: [{ title: '可见', lines: Array(100).fill('可见信息'.repeat(300)) }] },
      scope.boardId,
    );
    expect(query.length).toBeLessThanOrEqual(6400);
    expect(query).not.toContain(result.experiences[0]!.body);
  });

  it('保存命中失败后复用已存向量；并发恢复不会重复发出请求', async () => {
    const f = await extracted();
    await indexExperience(f.stores, f.row.id, vectorRuntime());
    const first = await begin(f.stores);
    const embedding = vectorRuntime();
    jest.spyOn(f.stores.experiences, 'search').mockRejectedValueOnce(new Error('模拟检索断线'));
    await expect(retrieveExperiences(f.stores, first.key, first.state, embedding)).rejects.toThrow(
      '模拟',
    );
    const resume = (await f.stores.actions.find(first.key))!.experienceRetrieval!;
    expect(resume.status).toBe('failed');
    expect(
      (await retrieveExperiences(f.stores, first.key, resume, embedding)).selected,
    ).toHaveLength(1);
    expect(embedding.port.generate).toHaveBeenCalledTimes(1);
    const next = await begin(f.stores);
    const outcomes = await Promise.allSettled([
      retrieveExperiences(f.stores, next.key, next.state, embedding),
      retrieveExperiences(f.stores, next.key, next.state, embedding),
    ]);
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(embedding.port.generate).toHaveBeenCalledTimes(2);
  });

  it('实际生成、复核都接收相同快照；另一个行动能读取新经验，恢复不重查', async () => {
    const f = await extracted();
    await indexExperience(f.stores, f.row.id, vectorRuntime());
    const receiver = await fixture(f.stores);
    const embedding = vectorRuntime();
    const model = controlledPort((request) =>
      request.prompt.includes('他交上来的结果')
        ? JSON.stringify({ accept: true, issues: '' })
        : '2',
    );
    const generate = jest.spyOn(model, 'generate');
    const runtime = {
      port: model,
      accessFor: () => access,
      memoriesFor: () => [],
      skills: stubSkills(),
      promptSource: LOCAL_PROMPTS,
      embedding,
      referenceModeFor: () => 'vector' as const,
    };
    const state = withRoles(
      { ...makeState(3, false), gameId: receiver.gameId },
      { p1: ROLES.VILLAGER },
    );
    const actions = modelActions(runtime, f.stores);
    actions.observe(state);
    await actions.vote('exile', 'p1', ['p2', 'p3']);
    const outcome = actions.outcomes()[0]!;
    expect(
      generate.mock.calls.every(([request]) =>
        request.prompt.includes(result.experiences[0]!.body),
      ),
    ).toBe(true);
    expect(generate.mock.calls[0]![0].prompt).toContain('他人的经历不能声称为自己亲历');
    const calls = await f.stores.asked.experienceInputs(
      receiver.gameId,
      outcome.snapshot.actionKey,
    );
    expect(calls[0]!.experiences[0]!.agentId).toBe(f.agent.id);
    expect(calls[0]!.dispatched).toBe(true);
    expect(await f.stores.experiences.list(receiver.agent.id)).toEqual([]);
    await f.stores.experiences.toggle(f.agent.id, calls[0]!.experiences[0]!.id, false);
    const resumed = modelActions(runtime, f.stores, state.phaseInstanceId);
    resumed.observe(state);
    await resumed.vote('exile', 'p1', ['p2', 'p3']);
    expect(resumed.outcomes()[0]!.snapshot.context.experiences).toEqual(
      outcome.snapshot.context.experiences,
    );
    expect(embedding.port.generate).toHaveBeenCalledTimes(1);
    await actions.vote('exile', 'p1', ['p2', 'p3']);
    expect(actions.outcomes()[1]!.snapshot.context.experiences).toEqual([]);
    const newSource = await extracted(f.stores);
    await indexExperience(f.stores, newSource.row.id, vectorRuntime());
    await actions.vote('exile', 'p1', ['p2', 'p3']);
    expect(actions.outcomes()[2]!.snapshot.context.experiences![0]!.agentId).toBe(
      newSource.agent.id,
    );
    expect(embedding.port.generate).toHaveBeenCalledTimes(2);
  });
});
