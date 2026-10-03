import {
  ExperienceCandidateContentSchema,
  ExperienceContentSchema,
  ExperienceEditableSchema,
} from '@werewolf/shared';
import { embeddingKey } from '../llm/embedding';
import { experienceApplicable } from '../store/experiences';
import { experienceAudit } from './audit';
import { indexExperience } from './indexing';
import {
  access,
  approveExperience,
  controlledPort,
  fixture,
  promptSource,
  result,
  vectorRuntime,
} from './testing';
import { runExperience } from './workflow';

it('生成候选不自动参与检索；审核拒绝越界证据和过期版本，批准不直接启用', async () => {
  const f = await fixture();
  await runExperience(f.stores, f.row.id, {
    port: controlledPort(JSON.stringify(result)),
    access,
    promptSource,
    prepare: f.prepare,
  });
  const item = (await f.stores.experiences.list(f.agent.id))[0]!;
  const runtime = vectorRuntime();
  const scope = {
    gameId: '新局',
    boardId: item.boardId,
    role: item.role,
    actionType: 'vote',
    day: 1,
  };
  await indexExperience(f.stores, f.row.id, runtime);
  expect(item.enabled).toBe(false);
  expect(await f.stores.experiences.hasCandidates(scope)).toBe(false);
  const input = {
    revision: 0,
    version: 1,
    decision: 'approved' as const,
    note: '证据支持时序核对，但不保证站边正确。',
    sourceIds: item.sourceIds,
  };
  await expect(
    f.stores.experiences.review(f.agent.id, item.id, { ...input, sourceIds: ['伪造'] }),
  ).rejects.toThrow('原始证据');
  await expect(
    f.stores.experiences.review(f.agent.id, item.id, { ...input, version: 2 }),
  ).rejects.toThrow('版本已变化');
  await f.stores.experiences.review(f.agent.id, item.id, input);
  expect((await f.stores.experiences.find(item.id))!.item.enabled).toBe(false);
  await f.stores.experiences.toggle(f.agent.id, item.id, true, 1, embeddingKey(runtime));
  expect(await f.stores.experiences.hasCandidates(scope)).toBe(true);
  expect(await f.stores.experiences.lexicalCandidates(scope, embeddingKey(runtime))).toHaveLength(
    1,
  );
  for (const changed of [
    { actionType: 'guard_protect' },
    { day: undefined },
    { actionType: undefined },
    { gameId: item.sourceGameId },
  ]) {
    expect(await f.stores.experiences.hasCandidates({ ...scope, ...changed })).toBe(false);
    expect(
      await f.stores.experiences.lexicalCandidates({ ...scope, ...changed }, embeddingKey(runtime)),
    ).toEqual([]);
  }
  await f.stores.experiences.review(f.agent.id, item.id, {
    ...input,
    revision: 2,
    decision: 'rejected',
    note: '新核对发现条件不足，先停用修订。',
  });
  const rejected = (await f.stores.experiences.find(item.id))!.item;
  expect(rejected.enabled).toBe(false);
  expect(rejected.reviews?.map((review) => review.decision)).toEqual(['approved', 'rejected']);
  await expect(
    f.stores.experiences.toggle(f.agent.id, item.id, true, 3, embeddingKey(runtime)),
  ).rejects.toThrow('先审核');
});

it('审核保留全部回执，编辑后旧批准失效；重复与范围重叠只作为核对提示', async () => {
  const f = await fixture();
  await runExperience(f.stores, f.row.id, {
    port: controlledPort(
      JSON.stringify({
        ...result,
        experiences: [
          result.experiences[0],
          result.experiences[0],
          { ...result.experiences[0], body: '结合公开证据重新核对主张，不能只看最终身份。' },
        ],
      }),
    ),
    access,
    promptSource,
    prepare: f.prepare,
  });
  const item = (await f.stores.experiences.list(f.agent.id))[0]!;
  const runtime = vectorRuntime();
  await indexExperience(f.stores, f.row.id, runtime);
  await approveExperience(f.stores, item.id, runtime);
  const approved = (await f.stores.experiences.find(item.id))!.item;
  const audit = await experienceAudit(f.stores, approved);
  expect(audit.sources[0]!.id).toBe('source-1');
  expect(audit.related).toHaveLength(2);
  const duplicate = (await f.stores.experiences.list(f.agent.id)).find(
    (entry) => entry.body === result.experiences[0]!.body,
  )!;
  expect(
    (await experienceAudit(f.stores, duplicate)).related.some(
      (entry) => entry.reason === 'duplicate',
    ),
  ).toBe(true);
  const editable = ExperienceEditableSchema.parse({
    title: item.title,
    body: '修正后的时序经验',
    conditions: item.conditions,
    actionTypes: item.actionTypes,
    minDay: 2,
    firstDayOnly: false,
    exclusions: item.exclusions,
  });
  await f.stores.experiences.edit(f.agent.id, item.id, 2, editable);
  const edited = (await f.stores.experiences.find(item.id))!.item;
  expect(edited).toMatchObject({ enabled: false, indexed: false, version: 2 });
  expect(edited.reviews).toEqual(approved.reviews);
  expect(edited.history?.[0]?.version).toBe(1);
});

it('旧数据仍可读取但不猜测适用范围，新候选拒绝互相冲突的天数', async () => {
  const legacy = { title: '旧经验', body: '旧做法', conditions: '旧条件', sourceIds: ['证据'] };
  expect(ExperienceContentSchema.safeParse(legacy).success).toBe(true);
  expect(ExperienceCandidateContentSchema.safeParse(legacy).success).toBe(false);
  expect(
    ExperienceCandidateContentSchema.safeParse({
      ...result.experiences[0],
      firstDayOnly: true,
      minDay: 2,
    }).success,
  ).toBe(false);
  const f = await fixture();
  await f.stores.experiences.save(f.row, { ...f.row.state, input: f.input });
  const row = (await f.stores.experiences.findGeneration(f.row.id))!;
  await f.stores.experiences.complete(row, { experiences: [legacy], reason: '旧产物恢复' });
  const item = (await f.stores.experiences.list(f.agent.id))[0]!;
  expect(
    experienceApplicable(item, {
      gameId: '新局',
      boardId: item.boardId,
      role: item.role,
      actionType: 'vote',
      day: 1,
    }),
  ).toBe(false);
  await expect(
    f.stores.experiences.review(f.agent.id, item.id, {
      revision: 0,
      version: 1,
      decision: 'approved',
      note: '核对',
      sourceIds: item.sourceIds,
    }),
  ).rejects.toThrow('补齐');
});
