import { openPrismaClient, prismaStores } from '../store/prisma';
import { randomUUID } from 'node:crypto';
import { recordingModelPort } from '../llm/recording-model-port';
import { fixture, result, access, promptSource, controlledPort, vectorRuntime } from './testing';
import { runExperience } from './workflow';
import { indexExperience } from './indexing';
import { initialRetrieval, retrieveExperiences } from './retrieval';

const databaseUrl = process.env.OBSERVATION_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
jest.setTimeout(30_000);

integration('Postgres 个人经验持久恢复', () => {
  it('重连后复用原答复和向量，检索结果可追溯且启停不改变当次输入', async () => {
    let client = openPrismaClient(databaseUrl!);
    const f = await fixture(prismaStores(client));
    const nextId = `${f.gameId}-next`;
    try {
      const model = controlledPort(JSON.stringify(result));
      const generate = jest.spyOn(model, 'generate');
      f.stores.experiences.complete = async () => {
        throw new Error('模拟产物写入失败');
      };
      await expect(
        runExperience(f.stores, f.row.id, {
          port: model,
          access,
          promptSource,
          prepare: f.prepare,
        }),
      ).rejects.toThrow('模拟');
      await client.$disconnect();
      client = openPrismaClient(databaseUrl!);
      const stores = prismaStores(client);
      await runExperience(stores, f.row.id, { port: model, access, promptSource });
      await runExperience(stores, f.row.id);
      expect(generate).toHaveBeenCalledTimes(1);
      const items = await stores.experiences.list(f.agent.id);
      expect(items).toHaveLength(1);
      await stores.games.open({ gameId: nextId, boardId: '6p_white_wolf', roster: [f.seat] });
      const embedding = vectorRuntime();
      jest
        .spyOn(stores.experiences, 'writeVectors')
        .mockRejectedValueOnce(new Error('模拟向量落库失败'));
      await expect(indexExperience(stores, f.row.id, embedding)).rejects.toThrow('模拟');
      await client.$disconnect();
      client = openPrismaClient(databaseUrl!);
      const resumed = prismaStores(client);
      await indexExperience(resumed, f.row.id, embedding);
      expect(embedding.port.generate).toHaveBeenCalledTimes(1);
      const actionKey = `${nextId}/vote`;
      const retrieval = initialRetrieval(
        {
          actor: { playerId: 'p1', seatNo: 1, role: '平民' },
          day: 1,
          task: '投票',
          visible: [],
          options: [],
          skill: [],
        },
        { gameId: nextId, boardId: '6p_white_wolf', role: 'villager' },
      );
      await resumed.actions.begin({
        actionKey,
        gameId: nextId,
        phaseInstanceId: 'day',
        actionType: 'vote',
        actorId: 'p1',
        actionOrdinal: 0,
        ledgerSeq: 0,
        experienceRetrieval: retrieval,
      });
      const selected = await retrieveExperiences(resumed, actionKey, retrieval, embedding);
      expect(selected.selected[0]!.id).toBe(items[0]!.id);
      expect(selected.candidates[0]!.similarity).toBeCloseTo(1);
      expect(await resumed.experiences.search(retrieval.scope, '其他向量空间', [1, 0], 20)).toEqual(
        [],
      );
      const callId = randomUUID();
      const port = recordingModelPort(controlledPort('2'), (asked) =>
        resumed.asked.append(nextId, { ...asked, actionKey }),
      );
      const response = await port.generate(
        { system: '离线验证', prompt: '投票', experiences: selected.selected },
        access,
        { identity: { callId, executionId: randomUUID(), step: 'generate', formatAttempt: 1 } },
      );
      await response.completeObservation!('accepted');
      await resumed.experiences.toggle(f.agent.id, items[0]!.id, false);
      expect(
        await retrieveExperiences(
          resumed,
          actionKey,
          (await resumed.actions.find(actionKey))!.experienceRetrieval!,
          embedding,
        ),
      ).toEqual(selected);
      expect(embedding.port.generate).toHaveBeenCalledTimes(2);
      expect(await resumed.asked.experienceInputs(nextId, actionKey)).toEqual([
        { callId, step: 'generate', dispatched: true, experiences: selected.selected },
      ]);
      expect(
        (
          await resumed.experiences.search(retrieval.scope, selected.embedding!.key, [1, 0], 20)
        ).some((hit) => hit.experience.id === items[0]!.id),
      ).toBe(false);
      const calls = (await resumed.observations.read(f.gameId))!.calls;
      expect(calls).toHaveLength(2);
      expect(calls.every((call) => call.status === 'accepted')).toBe(true);
      expect(
        calls.find((call) => call.step === 'experience_embedding')!.attempts[0]!.usage,
      ).toMatchObject({ total_tokens: 8 });
    } finally {
      await client.agentExperience.deleteMany({ where: { agentId: f.agent.id } });
      await client.experienceGeneration.deleteMany({ where: { agentId: f.agent.id } });
      await client.game.deleteMany({ where: { id: { in: [f.gameId, nextId] } } });
      await client.agent.delete({ where: { id: f.agent.id } });
      await client.$disconnect();
    }
  });
});
