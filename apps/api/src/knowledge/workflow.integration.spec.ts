import { randomUUID } from 'node:crypto';
import { KnowledgeSnapshotSchema } from '@werewolf/shared';
import { openPrismaClient, prismaStores } from '../store/prisma';
import { embeddingKey } from '../llm/embedding';
import { access, controlledPort, vectorRuntime } from '../experience/testing';
import { recordingModelPort } from '../llm/recording-model-port';
import { INITIAL_KNOWLEDGE } from './initial-content';
import { prepareKnowledgeIndex, indexKnowledge } from './indexing';
import { renderKnowledge } from './render';

const url = process.env.OBSERVATION_TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
jest.setTimeout(30_000);

integration('Postgres 知识版本、索引与追溯', () => {
  it('草稿与索引互斥；重连后复用向量答复，独立调用不挂在游戏；停用保留旧输入', async () => {
    let client = openPrismaClient(url!);
    const itemId = randomUUID();
    const gameId = `knowledge-test-${randomUUID()}`;
    try {
      let stores = prismaStores(client);
      const item = await stores.knowledge.saveDraft(itemId, 0, INITIAL_KNOWLEDGE[0]!.content);
      const version = item.versions[0]!;
      const runtime = vectorRuntime();
      const contested = await Promise.allSettled([
        prepareKnowledgeIndex(stores, version, runtime),
        stores.knowledge.saveDraft(itemId, item.revision, {
          ...version.content,
          body: '并发编辑正文',
        }),
      ]);
      expect(contested.some((r) => r.status === 'fulfilled')).toBe(true);
      const stored = (await stores.knowledge.find(itemId))!;
      const toIndex =
        stored.versions.find((v) => v.state.status === 'pending') ?? stored.versions.at(-1)!;
      if (toIndex.state.status === 'draft') await prepareKnowledgeIndex(stores, toIndex, runtime);
      const save = stores.knowledge.saveIndex.bind(stores.knowledge);
      jest.spyOn(stores.knowledge, 'saveIndex').mockImplementation(async (v, state, vector) => {
        if (vector) throw new Error('模拟最终向量入库失败');
        return save(v, state, vector);
      });
      await expect(indexKnowledge(stores, toIndex.versionId, runtime)).rejects.toThrow('模拟');
      await client.$disconnect();
      client = openPrismaClient(url!);
      stores = prismaStores(client);
      await prepareKnowledgeIndex(
        stores,
        (await stores.knowledge.version(toIndex.versionId))!,
        runtime,
      );
      await indexKnowledge(stores, toIndex.versionId, runtime);
      expect(runtime.port.generate).toHaveBeenCalledTimes(1);
      let current = (await stores.knowledge.find(itemId))!;
      await stores.knowledge.activate(
        itemId,
        current.revision,
        toIndex.versionId,
        embeddingKey(runtime),
      );
      const scope = {
        boardId: '12p_wolf_king',
        role: 'guard',
        actionType: 'guard_protect',
        day: 1,
      };
      expect(
        (await stores.knowledge.search(scope, embeddingKey(runtime), [1, 0], 20)).some(
          (h) => h.knowledge.id === itemId,
        ),
      ).toBe(true);
      const calls = await stores.asked.knowledgeCalls(toIndex.versionId);
      expect(calls.calls).toHaveLength(1);
      expect(calls.calls[0]!.attempts[0]!.usage).toEqual({ prompt_tokens: 8, total_tokens: 8 });
      expect(
        await client.askedPrompt.findMany({
          where: { knowledgeVersionId: toIndex.versionId },
          select: { gameId: true },
        }),
      ).toEqual([{ gameId: null }]);
      await stores.games.open({ gameId, boardId: scope.boardId, roster: [] });
      const snapshot = KnowledgeSnapshotSchema.parse(
        (await stores.knowledge.version(toIndex.versionId))!,
      );
      const key = `${gameId}/guard`;
      const callId = randomUUID();
      const port = recordingModelPort(
        controlledPort('2'),
        (asked) => stores.asked.append(gameId, { ...asked, actionKey: key }),
        { gameId, actionKey: key },
      );
      const response = await port.generate(
        { system: '离线验证', prompt: renderKnowledge([snapshot]), knowledge: [snapshot] },
        access,
        { identity: { callId, executionId: randomUUID(), step: 'generate', formatAttempt: 1 } },
      );
      await response.completeObservation?.('accepted');
      current = (await stores.knowledge.find(itemId))!;
      await stores.knowledge.activate(itemId, current.revision, null, '');
      expect((await stores.asked.knowledgeInputs(gameId, key))[0]).toEqual({
        callId,
        step: 'generate',
        dispatched: true,
        knowledge: [snapshot],
      });
      expect(
        (await stores.knowledge.search(scope, embeddingKey(runtime), [1, 0], 20)).some(
          (h) => h.knowledge.id === itemId,
        ),
      ).toBe(false);
      await expect(
        stores.asked.append(null, { model: '无归属', system: '', prompt: '', actionKey: null }),
      ).rejects.toThrow('归属');
    } finally {
      await client.knowledgeItem.updateMany({
        where: { id: itemId },
        data: { activeVersionId: null },
      });
      await client.askedPrompt.deleteMany({ where: { knowledgeVersion: { itemId } } });
      await client.knowledgeVersion.deleteMany({ where: { itemId } });
      await client.knowledgeItem.deleteMany({ where: { id: itemId } });
      await client.game.deleteMany({ where: { id: gameId } });
      await client.$disconnect();
    }
  });
});
