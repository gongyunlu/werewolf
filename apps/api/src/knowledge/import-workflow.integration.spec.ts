import { randomUUID } from 'node:crypto';
import { KnowledgeSnapshotSchema } from '@werewolf/shared';
import { openPrismaClient, prismaStores } from '../store/prisma';
import { access, controlledPort, vectorRuntime } from '../experience/testing';
import { knowledgeEmbeddingKey } from './text';
import { recordingModelPort } from '../llm/recording-model-port';
import { importFixture, page, proposed } from './import-testing';
import {
  captureKnowledgePage,
  organizeKnowledgePage,
  prepareOrganization,
} from './import-workflow';
import { indexKnowledge, prepareKnowledgeIndex } from './indexing';

const url = process.env.OBSERVATION_TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
jest.setTimeout(30_000);
integration('Postgres 网页采集与版本同步', () => {
  it('重连复用答复；并发保存原子且幂等；更新切换前后新检索改变，历史行动输入和来源不变', async () => {
    let client = openPrismaClient(url!);
    let stores = prismaStores(client);
    const sourceUrl = `https://example.org/import-test/${randomUUID()}`;
    const gameId = `knowledge-import-${randomUUID()}`;
    const itemIds: string[] = [];
    try {
      const f = await importFixture(stores, { ...page, url: sourceUrl });
      const initialSave = stores.knowledgeImports.save.bind(stores.knowledgeImports);
      jest.spyOn(stores.knowledgeImports, 'save').mockImplementation(async (row, state) => {
        if (state.organization?.status === 'ready') throw new Error('模拟最终保存失败');
        return initialSave(row, state);
      });
      await expect(organizeKnowledgePage(stores, f.id, f.runtime)).rejects.toThrow('最终保存失败');
      await client.$disconnect();
      client = openPrismaClient(url!);
      stores = prismaStores(client);
      await organizeKnowledgePage(stores, f.id, f.runtime);
      expect(f.runtime.port.generate).toHaveBeenCalledTimes(1);
      const originalCapture = (await stores.knowledgeImports.find(f.id))!;
      const c = originalCapture.state.candidates[0]!;
      itemIds.push(c.itemId);
      // 知识已写入后模拟任务结果写入失败，验证两者一起回滚。
      const transaction = client.$transaction.bind(client);
      const intercepted = jest.spyOn(client, '$transaction').mockImplementationOnce(((
        work: (tx: unknown) => Promise<unknown>,
      ) =>
        transaction((tx) =>
          work(
            new Proxy(tx, {
              get(target, key) {
                if (key === 'knowledgeCapture')
                  return new Proxy(target.knowledgeCapture, {
                    get(delegate, method) {
                      return method === 'update'
                        ? async () => {
                            throw new Error('模拟结果落库失败');
                          }
                        : Reflect.get(delegate, method);
                    },
                  });
                return Reflect.get(target, key);
              },
            }),
          ),
        )) as never);
      await expect(stores.knowledgeImports.confirm(f.id, c.id, c.content, 0)).rejects.toThrow(
        '结果落库失败',
      );
      intercepted.mockRestore();
      expect(await stores.knowledge.find(c.itemId)).toBeNull();
      expect((await stores.knowledgeImports.find(f.id))!.state.candidates[0]!.status).toBe(
        'pending',
      );
      await Promise.all([
        stores.knowledgeImports.confirm(f.id, c.id, c.content, 0),
        stores.knowledgeImports.confirm(f.id, c.id, c.content, 0),
      ]);
      let item = (await stores.knowledge.find(c.itemId))!;
      expect(item.revision).toBe(1);
      expect(item.versions).toHaveLength(1);
      const runtime = vectorRuntime();
      const old = item.versions[0]!;
      await prepareKnowledgeIndex(stores, old, runtime);
      await indexKnowledge(stores, old.versionId, runtime);
      await stores.knowledge.activate(
        item.id,
        item.revision,
        old.versionId,
        knowledgeEmbeddingKey(runtime),
      );
      const snapshot = KnowledgeSnapshotSchema.parse(old);
      await stores.games.open({ gameId, boardId: '12p_wolf_king', roster: [] });
      const actionKey = `${gameId}/guard`;
      const callId = randomUUID();
      const port = recordingModelPort(
        controlledPort('2'),
        (asked) => stores.asked.append(gameId, { ...asked, actionKey }),
        { gameId, actionKey },
      );
      const response = await port.generate(
        { system: '离线验证', prompt: '复用快照', knowledge: [snapshot] },
        access,
        { identity: { callId, executionId: randomUUID(), step: 'generate', formatAttempt: 1 } },
      );
      await response.completeObservation?.('accepted');
      const historical = await stores.asked.knowledgeInputs(gameId, actionKey);
      const batch = randomUUID();
      const concurrent = await Promise.all([
        stores.knowledgeImports.open(batch, [sourceUrl]),
        stores.knowledgeImports.open(batch, [sourceUrl]),
      ]);
      expect(concurrent[0]![0]!.id).toBe(concurrent[1]![0]!.id);
      const nextId = concurrent[0]![0]!.id;
      await captureKnowledgePage(stores, nextId, async () => ({
        ...page,
        url: sourceUrl,
        hash: 'updated',
      }));
      item = (await stores.knowledge.find(item.id))!;
      const row = (await stores.knowledgeImports.find(nextId))!;
      expect(row.state.previousId).toBe(f.id);
      await prepareOrganization(
        stores,
        row,
        { ...f.selection, revision: row.revision, targetIds: [item.id] },
        f.runtime,
      );
      await organizeKnowledgePage(stores, nextId, {
        ...f.runtime,
        port: controlledPort(JSON.stringify(proposed(item.id, '新版只保留可核查的守护条件。'))),
      });
      const candidate = (await stores.knowledgeImports.find(nextId))!.state.candidates[0]!;
      await stores.knowledge.saveDraft(item.id, item.revision, {
        ...old.content,
        body: '并发人工编辑',
      });
      await expect(
        stores.knowledgeImports.confirm(
          nextId,
          candidate.id,
          candidate.content,
          candidate.expectedRevision,
        ),
      ).rejects.toThrow('已被修改');
      item = (await stores.knowledge.find(item.id))!;
      await stores.knowledgeImports.confirm(nextId, candidate.id, candidate.content, item.revision);
      item = (await stores.knowledge.find(item.id))!;
      expect(item.activeVersionId).toBe(old.versionId);
      const scope = {
        boardId: '12p_wolf_king',
        role: 'guard',
        actionType: 'guard_protect',
        day: 1,
      };
      const search = async () =>
        (await stores.knowledge.search(scope, knowledgeEmbeddingKey(runtime), [1, 0], 100)).find(
          (h) => h.knowledge.id === item.id,
        )!.knowledge;
      expect((await search()).versionId).toBe(old.versionId);
      const updated = item.versions.at(-1)!;
      await prepareKnowledgeIndex(stores, updated, runtime);
      await indexKnowledge(stores, updated.versionId, runtime);
      await stores.knowledge.activate(
        item.id,
        item.revision,
        updated.versionId,
        knowledgeEmbeddingKey(runtime),
      );
      expect((await search()).versionId).toBe(updated.versionId);
      expect(await stores.asked.knowledgeInputs(gameId, actionKey)).toEqual(historical);
      expect((await stores.knowledgeImports.find(f.id))!.state.snapshot).toEqual(
        originalCapture.state.snapshot,
      );
      expect((await stores.knowledge.version(old.versionId))!.content).toEqual(snapshot.content);
      expect((await stores.asked.captureCalls(f.id)).calls[0]!.attempts[0]!.usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });
    } finally {
      await client.game.deleteMany({ where: { id: gameId } });
      await client.knowledgeItem.updateMany({
        where: { id: { in: itemIds } },
        data: { activeVersionId: null },
      });
      await client.askedPrompt.deleteMany({
        where: {
          OR: [
            { knowledgeVersion: { itemId: { in: itemIds } } },
            { knowledgeCapture: { source: { url: sourceUrl } } },
          ],
        },
      });
      await client.knowledgeVersion.deleteMany({ where: { itemId: { in: itemIds } } });
      await client.knowledgeItem.deleteMany({ where: { id: { in: itemIds } } });
      await client.knowledgeCapture.deleteMany({ where: { source: { url: sourceUrl } } });
      await client.knowledgeSource.deleteMany({ where: { url: sourceUrl } });
      await client.$disconnect();
    }
  });
});
