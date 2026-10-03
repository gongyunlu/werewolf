import { randomUUID } from 'node:crypto';
import { memoryStores } from '../store/memory';
import { embeddingKey } from '../llm/embedding';
import { newEmbeddingTask } from '../experience/embedding-task';
import { vectorRuntime } from '../experience/testing';
import { INITIAL_KNOWLEDGE } from './initial-content';
import { prepareKnowledgeIndex, indexKnowledge } from './indexing';
import { knowledgeEmbeddingKey, knowledgeText } from './text';

it('知识文本版本改变索引key，旧启用版本必须明确停用并重建', async () => {
  const stores = memoryStores();
  const runtime = vectorRuntime();
  const item = await stores.knowledge.saveDraft(randomUUID(), 0, INITIAL_KNOWLEDGE[0]!.content);
  const version = item.versions[0]!;
  const legacyTask = newEmbeddingTask(JSON.stringify(version.content), runtime);
  await stores.knowledge.saveIndex(
    version,
    { status: 'ready', failure: null, task: legacyTask },
    [1, 0],
  );
  await stores.knowledge.activate(item.id, item.revision, version.versionId, embeddingKey(runtime));
  const old = (await stores.knowledge.version(version.versionId))!;
  expect(knowledgeEmbeddingKey(runtime)).not.toBe(legacyTask.key);
  await expect(prepareKnowledgeIndex(stores, old, runtime)).rejects.toThrow('先停用');
  await stores.knowledge.activate(item.id, item.revision + 1, null, '');
  await prepareKnowledgeIndex(stores, old, runtime);
  await indexKnowledge(stores, version.versionId, runtime);
  const next = (await stores.knowledge.version(version.versionId))!;
  expect(next.state.task!.text).toBe(knowledgeText(version.content));
  expect(next.state.task!.key).toBe(knowledgeEmbeddingKey(runtime));
  expect(runtime.port.generate).toHaveBeenCalledTimes(1);
  await stores.knowledge.activate(
    item.id,
    item.revision + 2,
    version.versionId,
    knowledgeEmbeddingKey(runtime),
  );
});
