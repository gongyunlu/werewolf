import { embeddingRuntime, type EmbeddingRuntime } from '../llm/embedding';
import type { GameStores } from '../store/stores';
import type { ExperienceState } from '../store/experiences';
import { embedTask, newEmbeddingTask } from './embedding-task';

export function indexCompleted(state: ExperienceState): boolean {
  return (
    state.result !== null &&
    (state.result.experiences.length === 0 || state.indexing?.completed === true)
  );
}

export async function indexExperience(
  stores: GameStores,
  id: string,
  provided?: EmbeddingRuntime,
): Promise<void> {
  let row = await stores.experiences.findGeneration(id);
  if (!row?.state.result) throw new Error('先完成经验提炼，再建立向量索引');
  if (indexCompleted(row.state)) return;
  const save = async (indexing: NonNullable<ExperienceState['indexing']>) => {
    const state = { ...row!.state, indexing };
    await stores.experiences.save(row!, state);
    row = { ...row!, state };
  };
  try {
    const runtime = provided ?? embeddingRuntime();
    if (!row.state.indexing?.tasks.length) {
      const items = (await stores.experiences.list(row.agentId)).filter(
        (item) => item.generationId === id,
      );
      await save({
        completed: false,
        failure: null,
        tasks: items.map((item) => ({
          ...newEmbeddingTask(`${item.title}\n适用条件：${item.conditions}\n${item.body}`, runtime),
          experienceId: item.id,
        })),
      });
    }
    const vectors: Array<{ id: string; vector: number[] }> = [];
    for (let i = 0; i < row.state.indexing!.tasks.length; i++) {
      const task = row.state.indexing!.tasks[i]!;
      const vector = await embedTask(
        stores,
        { gameId: row.gameId, actionKey: null, summaryKey: `experience/${id}` },
        task,
        runtime,
        async (next) => {
          const tasks = [...row!.state.indexing!.tasks];
          tasks[i] = { ...next, experienceId: task.experienceId };
          await save({ tasks, completed: false, failure: null });
        },
      );
      vectors.push({ id: task.experienceId, vector });
    }
    await stores.experiences.writeVectors(row.state.indexing!.tasks[0]!.key, vectors);
    await save({ ...row.state.indexing!, completed: true, failure: null });
  } catch (error) {
    await save({
      tasks: [],
      completed: false,
      ...row.state.indexing,
      failure:
        error instanceof Error &&
        (error.message.startsWith('上次向量') || error.message.startsWith('尚未配置'))
          ? error.message
          : '经验向量索引失败，可续跑；已保存的向量答复会复用',
    });
    throw error;
  }
}
