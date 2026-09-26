import { KNOWLEDGE_CHARACTERS, KnowledgeSnapshotSchema } from '@werewolf/shared';
import { embedTask, newEmbeddingTask } from '../experience/embedding-task';
import { embeddingKey, embeddingRuntime, type EmbeddingRuntime } from '../llm/embedding';
import { KnowledgeConflictError, type KnowledgeRevision } from '../store/knowledge';
import type { GameStores } from '../store/stores';

/** 入队前固定正文；后续编辑创建新版本，不影响排队中的索引。 */
export async function prepareKnowledgeIndex(
  stores: GameStores,
  row: KnowledgeRevision,
  runtime: EmbeddingRuntime,
) {
  if (row.content.kind !== 'strategy')
    throw new KnowledgeConflictError('规则参考和案例暂不参与行动检索');
  if (JSON.stringify([KnowledgeSnapshotSchema.parse(row)]).length > KNOWLEDGE_CHARACTERS)
    throw new KnowledgeConflictError('条目超过单次知识输入预算，请精简正文和来源');
  if (row.state.status === 'unknown' || row.state.task?.attempts.at(-1)?.status === 'pending')
    throw new KnowledgeConflictError('上次向量请求结果未知，请先核查调用记录，不能自动重发');
  if (row.state.status === 'ready' && row.state.task?.key === embeddingKey(runtime)) return;
  if (row.state.task && row.state.task.key !== embeddingKey(runtime)) {
    const item = await stores.knowledge.find(row.id);
    if (item?.activeVersionId === row.versionId)
      throw new KnowledgeConflictError('接入已改变，请先停用此版本再重建索引');
  }
  await stores.knowledge.saveIndex(row, {
    status: 'pending',
    failure: null,
    task:
      row.state.task?.key === embeddingKey(runtime)
        ? row.state.task
        : newEmbeddingTask(JSON.stringify(row.content), runtime),
  });
}

export async function indexKnowledge(
  stores: GameStores,
  versionId: string,
  provided?: EmbeddingRuntime,
) {
  let row = await stores.knowledge.version(versionId);
  if (!row) throw new Error('知识版本不存在');
  if (row.state.status === 'ready') return;
  if (row.state.status !== 'pending' || !row.state.task)
    throw new KnowledgeConflictError('请先发起索引');
  const save = async (state: KnowledgeRevision['state'], vector?: number[]) => {
    await stores.knowledge.saveIndex(row!, state, vector);
    row = { ...row!, state };
  };
  try {
    const vector = await embedTask(
      stores,
      { gameId: null, actionKey: null, knowledgeVersionId: versionId },
      row.state.task,
      provided ?? embeddingRuntime(),
      (task) => save({ status: 'pending', failure: null, task }),
    );
    await save({ ...row.state, status: 'ready', failure: null }, vector);
  } catch (error) {
    if (error instanceof KnowledgeConflictError) throw error;
    const unknown = row.state.task?.attempts.at(-1)?.status === 'pending';
    await save({
      ...row.state,
      status: unknown ? 'unknown' : 'failed',
      failure: unknown
        ? '请求结果未知，已停止自动重发，请核查调用记录'
        : '索引未完成；重试将复用已经保存的向量答复，请核查调用记录',
    });
    throw error;
  }
}
