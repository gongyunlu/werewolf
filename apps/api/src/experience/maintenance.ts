import { embeddingKey, embeddingRuntime, type EmbeddingRuntime } from '../llm/embedding';
import {
  ExperienceConflictError,
  type ExperienceRecord,
  type ExperienceIndexState,
} from '../store/experiences';
import type { GameStores } from '../store/stores';
import { embedTask, newEmbeddingTask } from './embedding-task';
import { experienceText } from './indexing';

export const experienceIndexJobId = (id: string, version: number) => `experience-${id}-v${version}`;

export async function prepareExperienceIndex(
  stores: GameStores,
  row: ExperienceRecord,
  runtime: EmbeddingRuntime,
) {
  if (row.item.archived) throw new ExperienceConflictError('请先恢复归档经验，再建立索引');
  if (row.state?.status === 'unknown' || row.state?.task?.attempts.at(-1)?.status === 'pending')
    throw new ExperienceConflictError('上次向量请求结果未知，请核查调用记录，不能自动重发');
  const key = embeddingKey(runtime);
  if (row.state?.status === 'ready' && row.embeddingKey === key) return;
  if (row.item.enabled) throw new ExperienceConflictError('请先停用经验，再重建索引');
  await stores.experiences.saveIndex(row, {
    status: 'pending',
    failure: null,
    task:
      row.state?.task?.key === key
        ? row.state.task
        : newEmbeddingTask(experienceText(row.item), runtime),
  });
}

export async function indexExperienceVersion(
  stores: GameStores,
  id: string,
  version: number,
  provided?: EmbeddingRuntime,
) {
  let row = await stores.experiences.find(id);
  // 排队后可能已编辑或归档，无需为不再使用的版本发出请求。
  if (!row || row.item.version !== version || row.item.archived) return;
  if (row.state?.status === 'ready') return;
  if (row.state?.status !== 'pending' || !row.state.task)
    throw new ExperienceConflictError('请先发起此版本的索引');
  const save = async (state: ExperienceIndexState, vector?: number[]) => {
    await stores.experiences.saveIndex(row!, state, vector);
    row = { ...row!, state };
  };
  try {
    const vector = await embedTask(
      stores,
      {
        gameId: row.item.sourceGameId,
        actionKey: null,
        summaryKey: `experience/${id}/v${version}`,
      },
      row.state.task,
      provided ?? embeddingRuntime(),
      (task) => save({ status: 'pending', failure: null, task }),
    );
    await save({ ...row.state!, status: 'ready', failure: null }, vector);
  } catch (error) {
    if (error instanceof ExperienceConflictError) throw error;
    const unknown = row.state?.task?.attempts.at(-1)?.status === 'pending';
    await save({
      ...row.state!,
      status: unknown ? 'unknown' : 'failed',
      failure: unknown
        ? '请求结果未知，已停止自动重发，请核查调用记录'
        : '索引未完成；重试将复用已经保存的向量答复，请核查调用记录',
    });
    throw error;
  }
}
