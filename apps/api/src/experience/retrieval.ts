import { ExperienceSnapshotSchema } from '@werewolf/shared';
import { embeddingRuntime, type EmbeddingRuntime } from '../llm/embedding';
import type { StoredExperienceRetrieval } from '../store/actions';
import type { ExperienceScope } from '../store/experiences';
import type { GameStores } from '../store/stores';
import type { TurnContext } from '../turn/request';
import { embedTask, newEmbeddingTask } from './embedding-task';
import { EXPERIENCE_CHARACTERS, EXPERIENCE_LIMIT } from './selection';

/** 查询只来自已裁剪的玩家视角，不读取其他玩家私密信息或整局状态。 */
export function retrievalQuery(context: TurnContext, boardId: string): string {
  const visible = context.visible.flatMap((block) =>
    block.lines.map((line) => `${block.title}：${line}`),
  );
  return [
    `板子：${boardId}；我是${context.actor.role}；第${context.day}天`,
    `当前行动：${context.task}`,
    ...visible.slice(-20).map((line) => line.slice(0, 240)),
    ...(context.previousJudgment
      ? [`此前个人判断：${JSON.stringify(context.previousJudgment).slice(0, 600)}`]
      : []),
    `合法选项：${context.options.join('；')}`,
  ]
    .join('\n')
    .slice(0, 6400);
}

export function initialRetrieval(
  context: TurnContext,
  scope: ExperienceScope,
): StoredExperienceRetrieval {
  return {
    status: 'pending',
    query: retrievalQuery(context, scope.boardId),
    scope,
    model: null,
    failure: null,
    candidates: [],
    selected: [],
  };
}

export async function retrieveExperiences(
  stores: GameStores,
  actionKey: string,
  initial: StoredExperienceRetrieval,
  provided?: EmbeddingRuntime,
): Promise<StoredExperienceRetrieval> {
  if (initial.status === 'completed') return initial;
  let state = initial;
  const save = async (patch: Partial<StoredExperienceRetrieval>) => {
    const next = { ...state, ...patch };
    await stores.actions.saveRetrieval(actionKey, state, next);
    state = next;
  };
  try {
    if (!state.embedding && !(await stores.experiences.hasCandidates(state.scope))) {
      await save({ status: 'completed', failure: null });
      return state;
    }
    const runtime = provided ?? embeddingRuntime();
    if (!state.embedding)
      await save({
        embedding: newEmbeddingTask(state.query, runtime),
        model: runtime.access.model,
      });
    const vector = await embedTask(
      stores,
      { gameId: state.scope.gameId, actionKey },
      state.embedding!,
      runtime,
      (embedding) => save({ embedding, status: 'pending', failure: null }),
    );
    const hits = await stores.experiences.search(state.scope, state.embedding!.key, vector, 20);
    if (!hits.length && (await stores.experiences.hasCandidates(state.scope)))
      throw new Error('适用经验尚未建立当前模型的向量索引，请先完成索引');
    const selected = [];
    for (const hit of hits) {
      if (hit.similarity <= 0) continue;
      const snapshot = ExperienceSnapshotSchema.parse(hit.experience);
      if (
        selected.length < EXPERIENCE_LIMIT &&
        JSON.stringify([...selected, snapshot]).length <= EXPERIENCE_CHARACTERS
      )
        selected.push(snapshot);
    }
    await save({
      status: 'completed',
      failure: null,
      selected,
      candidates: hits.map((hit) => ({ id: hit.experience.id, similarity: hit.similarity })),
    });
    return state;
  } catch (error) {
    const failure =
      error instanceof Error &&
      (error.message.startsWith('上次向量') ||
        error.message.startsWith('适用经验') ||
        error.message.startsWith('尚未配置'))
        ? error.message
        : '经验检索失败；本次行动尚未继续，恢复时复用已保存的向量答复';
    await save({ status: 'failed', failure });
    throw error;
  }
}
