import { ExperienceEditableSchema } from '@werewolf/shared';
import { embeddingKey } from '../llm/embedding';
import { ModelCallError } from '../llm/model-port';
import {
  fixture,
  result,
  access,
  promptSource,
  controlledPort,
  vectorRuntime,
  approveExperience,
  failNextAttemptObservation,
} from './testing';
import { runExperience } from './workflow';
import { indexExperience } from './indexing';
import { indexExperienceVersion, prepareExperienceIndex } from './maintenance';
import { initialRetrieval, retrieveExperiences } from './retrieval';

export async function maintenanceFixture() {
  const f = await fixture();
  await runExperience(f.stores, f.row.id, {
    port: controlledPort(JSON.stringify(result)),
    access,
    promptSource,
    prepare: f.prepare,
  });
  const item = (await f.stores.experiences.list(f.agent.id))[0]!;
  const content = {
    title: '更正时序',
    body: '以当时可见记录核对先后，不用赛后信息替代。',
    conditions: '解释较早行为时',
    actionTypes: ['speech', 'vote'] as Array<'speech' | 'vote'>,
    minDay: 1,
    firstDayOnly: false,
    exclusions: '没有当时可见依据时不适用',
  };
  return { ...f, item, content };
}

describe('经验编辑与归档', () => {
  it('新版索引用量写入失败保持失败，恢复补记用量而不重发', async () => {
    const f = await maintenanceFixture();
    await f.stores.experiences.edit(f.agent.id, f.item.id, 0, f.content);
    const runtime = vectorRuntime();
    await prepareExperienceIndex(f.stores, (await f.stores.experiences.find(f.item.id))!, runtime);
    failNextAttemptObservation(f.stores);
    await expect(indexExperienceVersion(f.stores, f.item.id, 2, runtime)).rejects.toThrow(
      '模型观测写入失败',
    );
    expect((await f.stores.experiences.find(f.item.id))!.state!.status).toBe('failed');
    await prepareExperienceIndex(f.stores, (await f.stores.experiences.find(f.item.id))!, runtime);
    await indexExperienceVersion(f.stores, f.item.id, 2, runtime);
    expect((await f.stores.experiences.find(f.item.id))!.state!.status).toBe('ready');
    expect(runtime.port.generate).toHaveBeenCalledTimes(1);
    expect(
      (await f.stores.observations.read(f.gameId))!.calls.filter(
        (call) => call.step === 'experience_embedding',
      ),
    ).toMatchObject([
      { status: 'accepted', attempts: [{ status: 'succeeded', usage: { total_tokens: 8 } }] },
    ]);
  });

  it('初次索引后重建与启用交错，不清空已经启用的向量', async () => {
    const f = await maintenanceFixture();
    const runtime = vectorRuntime();
    await indexExperience(f.stores, f.row.id, runtime);
    await f.stores.experiences.review(f.agent.id, f.item.id, {
      revision: 0,
      version: 1,
      decision: 'approved',
      note: '已核对证据',
      sourceIds: f.item.sourceIds,
    });
    const beforeEnable = (await f.stores.experiences.find(f.item.id))!;
    expect(beforeEnable.state).toBeNull();
    await f.stores.experiences.toggle(f.agent.id, f.item.id, true, 1, embeddingKey(runtime));
    await expect(prepareExperienceIndex(f.stores, beforeEnable, runtime)).rejects.toThrow('已变化');
    expect((await f.stores.experiences.find(f.item.id))!.item).toMatchObject({
      enabled: true,
      indexed: true,
    });
  });

  it('原始版本切换向量接入后可以重建索引，迟到的提炼索引不覆盖新接入', async () => {
    const f = await maintenanceFixture();
    const original = vectorRuntime();
    await indexExperience(f.stores, f.row.id, original);
    const next = vectorRuntime([0, 1]);
    next.access = { ...next.access, model: '新向量模型' };
    await expect(
      f.stores.experiences.toggle(f.agent.id, f.item.id, true, 0, embeddingKey(next)),
    ).rejects.toThrow('索引');
    await prepareExperienceIndex(f.stores, (await f.stores.experiences.find(f.item.id))!, next);
    await indexExperienceVersion(f.stores, f.item.id, 1, next);
    await f.stores.experiences.writeVectors(embeddingKey(original), [
      { id: f.item.id, vector: [1, 0] },
    ]);
    expect((await f.stores.experiences.find(f.item.id))!.embeddingKey).toBe(embeddingKey(next));
    await approveExperience(f.stores, f.item.id, next);
    expect((await f.stores.experiences.find(f.item.id))!.item).toMatchObject({
      version: 1,
      enabled: true,
    });
    expect(next.port.generate).toHaveBeenCalledTimes(1);
  });
  it('拒绝空白、超长与不可编辑字段；保存不同字段均产生新版，原来源保持不变', async () => {
    const f = await maintenanceFixture();
    for (const content of [
      { ...f.content, body: ' ' },
      { ...f.content, title: '字'.repeat(65) },
      { ...f.content, body: '字'.repeat(601) },
      { ...f.content, conditions: '字'.repeat(241) },
      { ...f.content, sourceIds: ['伪造来源'] },
      { ...f.content, role: 'witch' },
    ])
      expect(ExperienceEditableSchema.safeParse(content).success).toBe(false);
    await f.stores.experiences.edit(f.agent.id, f.item.id, 0, f.content);
    const row = (await f.stores.experiences.find(f.item.id))!;
    expect(row.item).toMatchObject({
      ...f.content,
      enabled: false,
      version: 2,
      revision: 1,
      sourceIds: f.item.sourceIds,
      agentId: f.agent.id,
      sourceGameId: f.gameId,
      generationId: f.row.id,
      role: f.item.role,
      boardId: f.item.boardId,
    });
    expect(row.item.history).toHaveLength(1);
    expect(row.item.history![0]).toMatchObject({ version: 1, body: f.item.body });
    await f.stores.experiences.edit(f.agent.id, f.item.id, 1, f.content);
    expect((await f.stores.experiences.find(f.item.id))!.item.version).toBe(2);
    await expect(f.stores.experiences.edit(f.agent.id, f.item.id, 0, f.content)).rejects.toThrow(
      '已被修改',
    );
    expect(await f.stores.experiences.edit('其他归属', f.item.id, 1, f.content)).toBe(false);
  });

  it('编辑清除旧向量，原始索引迟到不覆盖新版；新版显式索引启用后才参与检索', async () => {
    const f = await maintenanceFixture();
    const runtime = vectorRuntime();
    const scope = {
      gameId: 'next',
      boardId: f.item.boardId,
      role: f.item.role,
      actionType: 'vote',
      day: 1,
    };
    await indexExperience(f.stores, f.row.id, runtime);
    const source = await f.stores.experiences.findGeneration(f.row.id);
    await f.stores.experiences.edit(f.agent.id, f.item.id, 0, f.content);
    await f.stores.experiences.writeVectors(embeddingKey(runtime), [
      { id: f.item.id, vector: [1, 0] },
    ]);
    expect((await f.stores.experiences.find(f.item.id))!.item.indexed).toBe(false);
    expect(await f.stores.experiences.hasCandidates(scope)).toBe(false);
    expect(await f.stores.experiences.search(scope, embeddingKey(runtime), [1, 0], 20)).toEqual([]);
    await expect(
      f.stores.experiences.toggle(f.agent.id, f.item.id, true, 1, embeddingKey(runtime)),
    ).rejects.toThrow('先完成');
    await prepareExperienceIndex(f.stores, (await f.stores.experiences.find(f.item.id))!, runtime);
    await indexExperienceVersion(f.stores, f.item.id, 2, runtime);
    expect((await f.stores.experiences.find(f.item.id))!.item.enabled).toBe(false);
    expect(jest.mocked(runtime.port.generate).mock.calls.at(-1)![0].prompt).toContain(
      f.content.body,
    );
    await approveExperience(f.stores, f.item.id, runtime);
    const hits = await f.stores.experiences.search(scope, embeddingKey(runtime), [1, 0], 20);
    expect(hits[0]!.experience).toMatchObject({ version: 2, body: f.content.body });
    for (const other of [
      { ...scope, role: 'witch' },
      { ...scope, boardId: '别的板子' },
      { ...scope, gameId: f.gameId },
    ])
      expect(await f.stores.experiences.hasCandidates(other)).toBe(false);
    expect(await f.stores.experiences.findGeneration(f.row.id)).toEqual(source);
  });

  it('索引失败可见且答复落库后续跑不重发；未知请求禁止重发', async () => {
    const f = await maintenanceFixture();
    await f.stores.experiences.edit(f.agent.id, f.item.id, 0, f.content);
    const runtime = vectorRuntime();
    await prepareExperienceIndex(f.stores, (await f.stores.experiences.find(f.item.id))!, runtime);
    const save = f.stores.experiences.saveIndex.bind(f.stores.experiences);
    jest.spyOn(f.stores.experiences, 'saveIndex').mockImplementation(async (row, state, vector) => {
      if (vector) throw new Error('模拟向量提交失败');
      return save(row, state, vector);
    });
    await expect(indexExperienceVersion(f.stores, f.item.id, 2, runtime)).rejects.toThrow('模拟');
    expect((await f.stores.experiences.list(f.agent.id))[0]).toMatchObject({
      indexStatus: 'failed',
      indexFailure: expect.stringContaining('复用'),
    });
    jest.mocked(f.stores.experiences.saveIndex).mockImplementation(save);
    await prepareExperienceIndex(f.stores, (await f.stores.experiences.find(f.item.id))!, runtime);
    await indexExperienceVersion(f.stores, f.item.id, 2, runtime);
    expect(runtime.port.generate).toHaveBeenCalledTimes(1);
    await f.stores.experiences.edit(f.agent.id, f.item.id, 1, { ...f.content, title: '再次更正' });
    await prepareExperienceIndex(f.stores, (await f.stores.experiences.find(f.item.id))!, runtime);
    jest.mocked(runtime.port.generate).mockRejectedValueOnce(new Error('传输结果未知'));
    await expect(indexExperienceVersion(f.stores, f.item.id, 3, runtime)).rejects.toThrow('未知');
    const unknown = (await f.stores.experiences.find(f.item.id))!;
    expect(unknown.item.indexStatus).toBe('unknown');
    await expect(prepareExperienceIndex(f.stores, unknown, runtime)).rejects.toThrow(
      '不能自动重发',
    );
    expect(runtime.port.generate).toHaveBeenCalledTimes(2);
  });

  it('明确失败允许新请求；重复 worker 只发一次，旧版本回写被拒绝', async () => {
    const f = await maintenanceFixture();
    const runtime = vectorRuntime();
    await f.stores.experiences.edit(f.agent.id, f.item.id, 0, f.content);
    await prepareExperienceIndex(f.stores, (await f.stores.experiences.find(f.item.id))!, runtime);
    jest
      .mocked(runtime.port.generate)
      .mockRejectedValueOnce(new ModelCallError('transient', '明确失败'));
    await expect(indexExperienceVersion(f.stores, f.item.id, 2, runtime)).rejects.toThrow(
      '明确失败',
    );
    await prepareExperienceIndex(f.stores, (await f.stores.experiences.find(f.item.id))!, runtime);
    const outcomes = await Promise.allSettled([
      indexExperienceVersion(f.stores, f.item.id, 2, runtime),
      indexExperienceVersion(f.stores, f.item.id, 2, runtime),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(runtime.port.generate).toHaveBeenCalledTimes(2);
    const old = (await f.stores.experiences.find(f.item.id))!;
    await f.stores.experiences.edit(f.agent.id, f.item.id, 1, {
      ...f.content,
      conditions: '仅限公开可见信息',
    });
    await expect(f.stores.experiences.saveIndex(old, old.state!, [1, 0])).rejects.toThrow('已变化');
    await indexExperienceVersion(f.stores, f.item.id, 2, runtime);
    expect(runtime.port.generate).toHaveBeenCalledTimes(2);
  });

  it('归档排除新行动，恢复后停用；已保存行动快照不变，归档期间不能编辑和启用', async () => {
    const f = await maintenanceFixture();
    const runtime = vectorRuntime();
    await indexExperience(f.stores, f.row.id, runtime);
    await approveExperience(f.stores, f.item.id, runtime);
    const scope = {
      gameId: 'next',
      boardId: f.item.boardId,
      role: f.item.role,
      actionType: 'vote',
      day: 1,
    };
    const initial = initialRetrieval(
      {
        actor: { playerId: 'p1', seatNo: 1, role: '平民' },
        day: 1,
        task: '投票',
        visible: [],
        options: [],
        skill: [],
      },
      scope,
      'vote',
      'vector',
    );
    await f.stores.actions.begin({
      gameId: 'next',
      actionKey: 'next/vote',
      phaseInstanceId: 'day',
      actionType: 'vote',
      actorId: 'p1',
      actionOrdinal: 0,
      ledgerSeq: 0,
      experienceRetrieval: initial,
    });
    const saved = await retrieveExperiences(f.stores, 'next/vote', initial, runtime);
    await f.stores.experiences.edit(f.agent.id, f.item.id, 2, f.content);
    await f.stores.experiences.archive(f.agent.id, f.item.id, 3, true);
    expect(await f.stores.experiences.hasCandidates(scope)).toBe(false);
    await expect(f.stores.experiences.toggle(f.agent.id, f.item.id, true)).rejects.toThrow('归档');
    await expect(f.stores.experiences.edit(f.agent.id, f.item.id, 4, f.content)).rejects.toThrow(
      '恢复',
    );
    await expect(
      prepareExperienceIndex(f.stores, (await f.stores.experiences.find(f.item.id))!, runtime),
    ).rejects.toThrow('恢复');
    expect(await retrieveExperiences(f.stores, 'next/vote', saved, runtime)).toEqual(saved);
    expect((await f.stores.actions.find('next/vote'))!.experienceRetrieval).toEqual(saved);
    expect(saved.selected[0]!.body).toBe(f.item.body);
    expect(runtime.port.generate).toHaveBeenCalledTimes(2);
    await f.stores.experiences.archive(f.agent.id, f.item.id, 4, false);
    expect((await f.stores.experiences.find(f.item.id))!.item).toMatchObject({
      archived: false,
      enabled: false,
      revision: 5,
    });
  });
});
