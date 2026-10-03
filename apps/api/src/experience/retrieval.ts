import {
  ExperienceSnapshotSchema,
  KnowledgeSnapshotSchema,
  KNOWLEDGE_LIMIT,
  KNOWLEDGE_CHARACTERS,
  type ExperienceSnapshot,
  type KnowledgeSnapshot,
} from '@werewolf/shared';
import { embeddingKey, embeddingRuntime, type EmbeddingRuntime } from '../llm/embedding';
import type { StoredExperienceRetrieval } from '../store/actions';
import type { ExperienceScope } from '../store/experiences';
import type { GameStores } from '../store/stores';
import type { TurnContext } from '../turn/request';
import { embedTask, newEmbeddingTask } from './embedding-task';
import { EXPERIENCE_CHARACTERS, EXPERIENCE_LIMIT } from './selection';
import { observeOperation, telemetry } from '../llm/telemetry';
import { experienceText } from './indexing';
import { knowledgeEmbeddingKey, knowledgeText } from '../knowledge/text';
import {
  fuseCandidates,
  rankKeywords,
  selectReferences,
  RETRIEVAL_POLICY,
  type RetrievalCandidate,
  type RetrievalDocument,
} from './retrieval-ranking';
import { newRerankTask, rerankReferences, type RerankRuntime } from './reranking';

/** 对照实验保留原查询裁剪行为。 */
export function originalRetrievalQuery(context: TurnContext, boardId: string): string {
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

/** 本人能力状态和当前合法选项优先保留，过程记录不能挤掉私密事实。 */
export function retrievalQuery(context: TurnContext, boardId: string): string {
  const protectedTitles = new Set(['你手里的牌', '局面', '这一问的说明']);
  const core = [
    `板子：${boardId}；我是${context.actor.role}；第${context.day}天`,
    `当前行动：${context.task}`,
    ...context.visible
      .filter((block) => protectedTitles.has(block.title))
      .flatMap((block) => block.lines.map((line) => `系统记录·${block.title}：${line}`)),
    `合法选项：${context.options.join('；')}`,
    `本次规则：${context.skill
      .map((rule) => rule.slice(0, 400))
      .join('\n')
      .slice(0, 1600)}`,
    ...(context.previousJudgment
      ? [`此前个人猜测（不是已知事实）：${JSON.stringify(context.previousJudgment).slice(0, 600)}`]
      : []),
  ].join('\n');
  const process = context.visible
    .filter((block) => !protectedTitles.has(block.title))
    .flatMap((block) => block.lines.map((line) => `${block.title}：${line.slice(0, 240)}`))
    .slice(-20)
    .join('\n');
  const remaining = Math.max(0, 6300 - core.length);
  return `${core}\n可见过程（发言中的身份主张不是系统事实）：\n${remaining ? process.slice(-remaining) : ''}`.slice(
    0,
    6400,
  );
}

export function initialRetrieval(
  context: TurnContext,
  scope: ExperienceScope,
  actionType?: string,
  mode: 'none' | 'vector' | 'hybrid' = 'hybrid',
): StoredExperienceRetrieval {
  return {
    status: 'pending',
    query: (mode === 'vector' ? originalRetrievalQuery : retrievalQuery)(context, scope.boardId),
    scope: { ...scope, ...(actionType ? { actionType } : {}), day: context.day },
    mode,
    policyVersion: mode === 'hybrid' ? RETRIEVAL_POLICY.version : mode,
    ...(mode === 'hybrid' ? { minRelevance: RETRIEVAL_POLICY.minRelevance } : {}),
    model: null,
    failure: null,
    candidates: [],
    selected: [],
    ...(actionType
      ? { knowledge: { actionType, day: context.day, candidates: [], selected: [] } }
      : {}),
  };
}

export async function retrieveExperiences(
  stores: GameStores,
  actionKey: string,
  initial: StoredExperienceRetrieval,
  provided?: EmbeddingRuntime,
  rerankRuntime?: RerankRuntime,
): Promise<StoredExperienceRetrieval> {
  const reused = initial.status === 'completed';
  return observeOperation(
    reused ? 'references.snapshot' : 'references.retrieve',
    reused ? 'chain' : 'retriever',
    {
      input: {
        query: initial.query,
        scope: initial.scope,
        ...(initial.knowledge
          ? { actionType: initial.knowledge.actionType, day: initial.knowledge.day }
          : {}),
      },
      metadata: { gameId: initial.scope.gameId, actionKey, reused },
    },
    async (span) => {
      const result = await retrieve(stores, actionKey, initial, provided, rerankRuntime);
      telemetry(() =>
        span?.update({
          output: {
            experiences: {
              candidates: result.candidates,
              selected: result.selected,
              count: result.selected.length,
              characters: JSON.stringify(result.selected).length,
              limit: EXPERIENCE_LIMIT,
              characterLimit: EXPERIENCE_CHARACTERS,
            },
            ...(result.knowledge
              ? {
                  knowledge: {
                    candidates: result.knowledge.candidates,
                    selected: result.knowledge.selected,
                    count: result.knowledge.selected.length,
                    characters: JSON.stringify(result.knowledge.selected).length,
                    limit: KNOWLEDGE_LIMIT,
                    characterLimit: KNOWLEDGE_CHARACTERS,
                  },
                }
              : {}),
          },
          metadata: {
            model: result.model,
            policyVersion: result.policyVersion,
            rerankModel: result.rerankModel,
            minRelevance: result.minRelevance,
            embeddingReused: initial.embedding?.attempts.at(-1)?.status === 'responded',
          },
        }),
      );
      return result;
    },
    { sessionId: initial.scope.gameId },
  );
}

async function retrieve(
  stores: GameStores,
  actionKey: string,
  initial: StoredExperienceRetrieval,
  provided?: EmbeddingRuntime,
  rerankRuntime?: RerankRuntime,
): Promise<StoredExperienceRetrieval> {
  if (initial.status === 'completed') return initial;
  let state = initial;
  const save = async (patch: Partial<StoredExperienceRetrieval>) => {
    const next = { ...state, ...patch };
    await stores.actions.saveRetrieval(actionKey, state, next);
    state = next;
  };
  try {
    if (state.mode === 'none') {
      await save({ status: 'completed', failure: null });
      return state;
    }
    if (!state.frozenCandidates) {
      const knowledgeScope = state.knowledge
        ? {
            boardId: state.scope.boardId,
            role: state.scope.role,
            actionType: state.knowledge.actionType,
            day: state.knowledge.day,
          }
        : null;
      const [hasExperiences, hasKnowledge] = await Promise.all([
        stores.experiences.hasCandidates(state.scope),
        knowledgeScope ? stores.knowledge.hasCandidates(knowledgeScope) : false,
      ]);
      if (!state.embedding && !state.frozenCandidates && !hasExperiences && !hasKnowledge) {
        await save({ status: 'completed', failure: null });
        return state;
      }
      const runtime = provided ?? embeddingRuntime();
      if (state.embedding && state.embedding.key !== embeddingKey(runtime))
        throw new Error('向量接入或型号已改变，不能用已保存的查询向量检索另一套索引');
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
      const knowledgeKey = knowledgeEmbeddingKey(runtime);
      const [hits, knowledgeHits, experienceDocuments, knowledgeDocuments] = await Promise.all([
        stores.experiences.search(state.scope, state.embedding!.key, vector, 20),
        knowledgeScope ? stores.knowledge.search(knowledgeScope, knowledgeKey, vector, 20) : [],
        state.mode === 'vector'
          ? []
          : stores.experiences.lexicalCandidates(state.scope, state.embedding!.key),
        state.mode === 'vector' || !knowledgeScope
          ? []
          : stores.knowledge.lexicalCandidates(knowledgeScope, knowledgeKey),
      ]);
      if (!hits.length && hasExperiences)
        throw new Error('适用经验尚未建立当前模型的向量索引，请先完成索引');
      if (knowledgeScope && !knowledgeHits.length && hasKnowledge)
        throw new Error('适用知识尚未建立当前模型与检索文本版本的向量索引，请先完成索引');
      if (state.mode === 'vector') {
        const selected: ExperienceSnapshot[] = [];
        for (const hit of hits) {
          if (hit.similarity <= 0) continue;
          const snapshot = ExperienceSnapshotSchema.parse(hit.experience);
          if (
            selected.length < EXPERIENCE_LIMIT &&
            JSON.stringify([...selected, snapshot]).length <= EXPERIENCE_CHARACTERS
          )
            selected.push(snapshot);
        }
        const knowledge: KnowledgeSnapshot[] = [];
        for (const hit of knowledgeHits) {
          const snapshot = KnowledgeSnapshotSchema.parse(hit.knowledge);
          if (
            hit.similarity > 0 &&
            knowledge.length < KNOWLEDGE_LIMIT &&
            JSON.stringify([...knowledge, snapshot]).length <= KNOWLEDGE_CHARACTERS
          )
            knowledge.push(snapshot);
        }
        await save({
          status: 'completed',
          failure: null,
          selected,
          candidates: hits.map((hit) => ({ id: hit.experience.id, similarity: hit.similarity })),
          ...(state.knowledge
            ? {
                knowledge: {
                  ...state.knowledge,
                  selected: knowledge,
                  candidates: knowledgeHits.map((hit) => ({
                    id: hit.knowledge.id,
                    versionId: hit.knowledge.versionId,
                    similarity: hit.similarity,
                  })),
                },
              }
            : {}),
        });
        return state;
      }
      const vectorHits = [
        ...hits.map((hit) => ({
          document: experienceDocument(ExperienceSnapshotSchema.parse(hit.experience)),
          score: hit.similarity,
        })),
        ...knowledgeHits.map((hit) => ({
          document: knowledgeDocument(KnowledgeSnapshotSchema.parse(hit.knowledge)),
          score: hit.similarity,
        })),
      ]
        .toSorted((a, b) => b.score - a.score || a.document.key.localeCompare(b.document.key))
        .slice(0, RETRIEVAL_POLICY.recallLimit);
      const documents = [
        ...experienceDocuments.map((item) =>
          experienceDocument(ExperienceSnapshotSchema.parse(item)),
        ),
        ...knowledgeDocuments.map((item) => knowledgeDocument(KnowledgeSnapshotSchema.parse(item))),
      ];
      await save({
        frozenCandidates: fuseCandidates(vectorHits, rankKeywords(state.query, documents)),
      });
    }
    if (!state.frozenCandidates!.length) {
      await save({ status: 'completed', failure: null });
      return state;
    }
    if (!state.reranking) {
      if (!rerankRuntime) throw new Error('参考材料重排缺少本次行动的模型接入');
      await save({
        reranking: newRerankTask(state.query, state.frozenCandidates!, rerankRuntime),
        rerankModel: rerankRuntime.access.model,
      });
    }
    const judgments = await rerankReferences(
      stores,
      { gameId: state.scope.gameId, actionKey },
      state.reranking!,
      state.frozenCandidates!,
      rerankRuntime,
      (reranking) => save({ reranking }),
    );
    const result = selectReferences(state.frozenCandidates!, judgments, state.minRelevance);
    const decisions = new Map(result.decisions.map((decision) => [decision.key, decision]));
    const diagnostics = (candidate: RetrievalCandidate) => {
      const decision = decisions.get(candidate.key)!;
      return {
        similarity: candidate.similarity ?? 0,
        keywordScore: candidate.keywordScore,
        vectorRank: candidate.vectorRank,
        keywordRank: candidate.keywordRank,
        fusionScore: candidate.fusionScore,
        rerankScore: decision.relevance,
        applicable: decision.applicable,
        reason: decision.reason,
        rejection: decision.rejection,
        duplicateOf: decision.duplicateOf,
      };
    };
    await save({
      status: 'completed',
      failure: null,
      selected: result.experiences,
      candidates: state
        .frozenCandidates!.filter((row) => row.kind === 'experience')
        .map((row) => ({ id: row.snapshot.id, ...diagnostics(row) })),
      ...(state.knowledge
        ? {
            knowledge: {
              ...state.knowledge,
              selected: result.knowledge,
              candidates: state
                .frozenCandidates!.filter((row) => row.kind === 'knowledge')
                .map((row) => ({
                  id: row.snapshot.id,
                  versionId: row.snapshot.versionId,
                  ...diagnostics(row),
                })),
            },
          }
        : {}),
    });
    return state;
  } catch (error) {
    const failure =
      error instanceof Error &&
      (error.message.startsWith('上次') ||
        error.message.startsWith('适用经验') ||
        error.message.startsWith('适用知识') ||
        error.message.startsWith('参考材料重排') ||
        error.message.startsWith('尚未配置'))
        ? error.message
        : '参考材料检索失败；本次行动尚未继续，恢复时复用已保存的候选和模型答复';
    await save({ status: 'failed', failure });
    throw error;
  }
}

export function experienceDocument(snapshot: ExperienceSnapshot): RetrievalDocument {
  return {
    key: `experience/${snapshot.id}/${snapshot.version}`,
    kind: 'experience',
    text: `${experienceText(snapshot)}${snapshot.exclusions ? `\n不适用条件：${snapshot.exclusions}` : ''}`,
    snapshot,
  };
}

export function knowledgeDocument(snapshot: KnowledgeSnapshot): RetrievalDocument {
  return {
    key: `knowledge/${snapshot.versionId}`,
    kind: 'knowledge',
    text: knowledgeText(snapshot.content),
    snapshot,
  };
}
