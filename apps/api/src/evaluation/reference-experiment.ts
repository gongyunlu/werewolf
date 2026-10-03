import { randomUUID } from 'node:crypto';
import type { Evaluation, LangfuseClient } from '@langfuse/client';
import { z } from 'zod';
import type { BoardId } from '../boards/boards';
import { phaseInstanceId } from '../core/identity';
import {
  initialRetrieval,
  retrieveExperiences,
  experienceDocument,
  knowledgeDocument,
} from '../experience/retrieval';
import { RETRIEVAL_POLICY, selectReferences } from '../experience/retrieval-ranking';
import { parseRerankResponse } from '../experience/reranking';
import type { EmbeddingRuntime } from '../llm/embedding';
import type { ModelAccess, ModelPort } from '../llm/model-port';
import { recordingModelPort } from '../llm/recording-model-port';
import { tokenUsage } from '../llm/observation';
import type { CallRow } from '../store/observations';
import { parseStructured, toolOf } from '../llm/structured-output';
import { snapshotPromptSource } from '../prompts/template';
import { gameSkills } from '../skills/game-skills';
import { memoryStores } from '../store/memory';
import { runActionGraph, type TurnOutcome } from '../turn/graph';
import { fingerprint } from '../turn/prompt-comparison';
import { freezeReferenceStores } from './reference-corpus';
import {
  assertDataset,
  sampleCorpus,
  type ReferenceDataset,
  type ReferenceSample,
  type ReferenceLabel,
} from './reference-dataset';

export type ReferenceVariant = 'none' | 'vector' | 'hybrid' | 'curated';
export interface ReferenceMetrics {
  recall: number | null;
  selectionRecall: number | null;
  precision: number | null;
  ndcg: number | null;
  inapplicableRate: number | null;
  emptyCorrect: number | null;
}

export function referenceMetrics(
  labels: Record<string, ReferenceLabel>,
  candidates: readonly string[],
  selected: readonly string[],
): ReferenceMetrics {
  const relevant = Object.entries(labels)
    .filter(([, label]) => label.applicable && label.relevance === 3)
    .map(([key]) => key);
  for (const key of [...candidates, ...selected])
    if (!labels[key]) throw new Error(`结果 ${key} 没有独立标签`);
  if (new Set(selected).size !== selected.length) throw new Error('选中结果含重复引用');
  const gain = (key: string) => (labels[key]!.applicable ? 2 ** labels[key]!.relevance - 1 : 0);
  const dcg = (keys: readonly string[]) =>
    keys.reduce((sum, key, index) => sum + gain(key) / Math.log2(index + 2), 0);
  const ideal = Object.keys(labels)
    .toSorted((a, b) => gain(b) - gain(a))
    .slice(0, 5);
  return {
    recall: relevant.length
      ? relevant.filter((key) => candidates.includes(key)).length / relevant.length
      : null,
    selectionRecall: relevant.length
      ? relevant.filter((key) => selected.includes(key)).length / relevant.length
      : null,
    precision: selected.length
      ? selected.filter((key) => relevant.includes(key)).length / selected.length
      : null,
    ndcg: ideal.length && dcg(ideal) > 0 ? dcg(selected.slice(0, 5)) / dcg(ideal) : null,
    inapplicableRate: selected.length
      ? selected.filter((key) => !labels[key]!.applicable).length / selected.length
      : null,
    // 无直接相关（3分）材料时的空选率；门槛2允许部分有用材料，因此该字段不表示正确率。
    emptyCorrect: relevant.length ? null : Number(selected.length === 0),
  };
}

const actionAssessmentSchema = z.object({
  ruleViolation: z.boolean(),
  perspectiveViolation: z.boolean(),
  historicalFactMisuse: z.boolean(),
  strategyQuality: z.number().int().min(0).max(3),
  reason: z.string().min(1),
});

export const REFERENCE_ACTION_EVALUATOR = {
  version: 'reference-action-v2',
  system:
    '你是狼人杀行动评估者。仅依据行动当时的输入和规则盲评，不知实验组别，不按终局身份倒推。公开诈身份、试探、条件假设不算事实错误；不因打法不同就判违规。规则违规包括能力、时序、资格、票权和终局规则。行动包含未来方案时，逐项核对所提技能的使用时点、资格和前提；将规则中不存在的窗口当作可执行安排属于规则错误，不能因为当前输出只是发言而豁免。区分合法的条件方案与即使条件成立也无法执行的方案。历史经验不能成为本局事实。策略质量0=无法成立，1=有明显遗漏，2=合理取舍，3=依据充分且能处理主要风险。结论是评估意见，不代表因果证明。用中文简要指出输入依据及无法确认的疑点。',
} as const;

export interface ReferenceTrialResult {
  sampleId: string;
  variant: ReferenceVariant;
  corpusHash: string;
  selected: string[];
  candidates: string[];
  metrics: ReferenceMetrics | null;
  retrieval: unknown;
  durationMs: number;
  calls?: CallRow[];
  outcome?: TurnOutcome;
  assessment?: z.infer<typeof actionAssessmentSchema>;
  assessmentVersion?: string;
}

export async function runReferenceTrial(input: {
  dataset: ReferenceDataset;
  sample: ReferenceSample;
  variant: ReferenceVariant;
  stage: 'retrieval' | 'action';
  embedding: EmbeddingRuntime;
  port: ModelPort;
  access: ModelAccess;
  minRelevance?: number;
}): Promise<ReferenceTrialResult> {
  const { dataset, sample, variant, access, port } = input;
  const started = performance.now();
  const corpus = sampleCorpus(dataset, sample);
  const stores = freezeReferenceStores(memoryStores(), corpus);
  const gameId = `reference-eval-${randomUUID()}`;
  const actionKey = `${gameId}/${sample.id}`;
  const context = structuredClone(sample.context);
  await stores.games.open({ gameId, boardId: sample.boardId, roster: [] });
  const initial = initialRetrieval(
    context,
    { boardId: sample.boardId, role: sample.role, gameId },
    sample.actionType,
    variant === 'curated' ? 'none' : variant,
  );
  if (input.minRelevance !== undefined) initial.minRelevance = input.minRelevance;
  await stores.actions.begin({
    actionKey,
    gameId,
    actionType: sample.actionType,
    actorId: context.actor.playerId,
    actionOrdinal: 0,
    phaseInstanceId: 'evaluation',
    ledgerSeq: 0,
    experienceRetrieval: initial,
  });
  let retrieval = await retrieveExperiences(stores, actionKey, initial, input.embedding, {
    port,
    access,
  });
  let rankedKeys: string[] | undefined;
  if (variant === 'curated') {
    if (!sample.labels) throw new Error('精选材料对照需要先完成独立标注');
    const documents = [
      ...corpus.experiences.map((row) => experienceDocument(row.snapshot)),
      ...corpus.knowledge.map((row) => knowledgeDocument(row.snapshot)),
    ];
    const chosen = selectReferences(
      documents.map((doc) => ({ ...doc, fusionScore: 0 })),
      documents.map((doc) => ({
        key: doc.key,
        relevance: sample.labels![doc.key]!.relevance,
        applicable: sample.labels![doc.key]!.applicable,
        reason: sample.labels![doc.key]!.note,
        duplicateOf: null,
      })),
    );
    rankedKeys = chosen.decisions.filter((row) => row.selected).map((row) => row.key);
    retrieval = {
      ...retrieval,
      selected: chosen.experiences,
      knowledge: {
        actionType: sample.actionType,
        day: context.day,
        candidates: [],
        selected: chosen.knowledge,
      },
    };
  }
  context.experiences = retrieval.selected;
  context.knowledge = retrieval.knowledge?.selected ?? [];
  if (retrieval.frozenCandidates?.length && retrieval.reranking) {
    const judgments = parseRerankResponse(
      retrieval.reranking.attempts.at(-1)!.response!,
      retrieval.frozenCandidates,
    );
    rankedKeys = selectReferences(retrieval.frozenCandidates, judgments, retrieval.minRelevance)
      .decisions.filter((row) => row.selected)
      .map((row) => row.key);
  }
  const injected = [
    ...context.experiences.map((row) => experienceDocument(row).key),
    ...context.knowledge.map((row) => knowledgeDocument(row).key),
  ];
  const scores = new Map([
    ...retrieval.candidates.map(
      (row) =>
        [
          experienceDocument(
            corpus.experiences.find((entry) => entry.snapshot.id === row.id)!.snapshot,
          ).key,
          row.similarity,
        ] as const,
    ),
    ...(retrieval.knowledge?.candidates.map(
      (row) => [`knowledge/${row.versionId}`, row.similarity] as const,
    ) ?? []),
  ]);
  const selected =
    rankedKeys ??
    injected.toSorted((a, b) => scores.get(b)! - scores.get(a)! || a.localeCompare(b));
  const candidates =
    variant === 'curated'
      ? selected
      : [
          ...retrieval.candidates.map(
            (row) =>
              experienceDocument(
                corpus.experiences.find((entry) => entry.snapshot.id === row.id)!.snapshot,
              ).key,
          ),
          ...(retrieval.knowledge?.candidates.map((row) => `knowledge/${row.versionId}`) ?? []),
        ];
  const result: ReferenceTrialResult = {
    sampleId: sample.id,
    variant,
    corpusHash: corpus.hash,
    selected,
    candidates,
    metrics: sample.labels ? referenceMetrics(sample.labels, candidates, selected) : null,
    retrieval,
    durationMs: performance.now() - started,
  };
  if (input.stage === 'action') {
    const recorded = recordingModelPort(
      port,
      (asked) => stores.asked.append(gameId, { ...asked, actionKey }),
      { gameId, actionKey },
    );
    result.outcome = await runActionGraph(
      {
        port: recorded,
        accessFor: () => access,
        memoriesFor: () => [],
        skills: gameSkills(sample.boardId as BoardId),
        promptSource: snapshotPromptSource(dataset.templates),
      },
      {
        scope: { gameId, phaseInstanceId: phaseInstanceId(0, 'evaluation') },
        actionType: sample.actionType,
        actorId: context.actor.playerId,
        actionOrdinal: 0,
        preset: sample.preset,
        context,
        ...(sample.schema ? { schema: z.fromJSONSchema(sample.schema) } : {}),
      },
    );
    const assessment = await recorded.generate(
      {
        system: REFERENCE_ACTION_EVALUATOR.system,
        prompt: JSON.stringify({
          context,
          schema: sample.schema,
          decision: result.outcome.decision,
          reasoning: result.outcome.snapshot.reasoning,
        }),
        tool: toolOf(actionAssessmentSchema, '评估本次行动的规则、视角、历史事实误用及策略质量'),
      },
      access,
      {
        identity: {
          callId: randomUUID(),
          executionId: gameId,
          step: 'reference_evaluation',
          formatAttempt: 1,
        },
      },
    );
    try {
      if (!assessment.toolCall) throw new Error('行动评估没有返回结构化结果');
      result.assessment = parseStructured(
        assessment.toolCall.arguments,
        actionAssessmentSchema,
        '行动评估',
      );
      result.assessmentVersion = REFERENCE_ACTION_EVALUATOR.version;
      await assessment.completeObservation?.('accepted');
    } catch (error) {
      await assessment.completeObservation?.('invalid_output');
      throw error;
    }
  }
  result.durationMs = performance.now() - started;
  result.calls = (await stores.observations.read(gameId))!.calls;
  return result;
}

export function trialScores(result: ReferenceTrialResult): Evaluation[] {
  const values: Record<string, number | null> = {
    duration_ms: result.durationMs,
    selected_count: result.selected.length,
    ...result.metrics,
  };
  const attempts = result.calls
    ?.flatMap((call) => call.attempts)
    .filter((attempt) => attempt.dispatched);
  if (attempts) {
    values.model_requests = attempts.length;
    values.total_tokens = attempts.every(
      (attempt) => attempt.usageComplete && tokenUsage(attempt.usage).total !== null,
    )
      ? attempts.reduce((sum, attempt) => sum + tokenUsage(attempt.usage).total!, 0)
      : null;
  }
  if (result.assessment)
    Object.assign(values, {
      judge_rule_violation: Number(result.assessment.ruleViolation),
      judge_perspective_violation: Number(result.assessment.perspectiveViolation),
      judge_historical_fact_misuse: Number(result.assessment.historicalFactMisuse),
      judge_strategy_quality: result.assessment.strategyQuality,
    });
  return Object.entries(values).flatMap(([name, value]) =>
    value === null
      ? []
      : [
          {
            name,
            value,
            comment: name.startsWith('judge_')
              ? result.assessment!.reason
              : '固定行动与语料版本；空分母不计分',
          },
        ],
  );
}

export async function runReferenceExperiment(input: {
  client: LangfuseClient;
  dataset: ReferenceDataset;
  variants: ReferenceVariant[];
  stage: 'retrieval' | 'action';
  split: 'development' | 'test';
  embedding: EmbeddingRuntime;
  port: ModelPort;
  accessFor: (sample: ReferenceSample) => ModelAccess;
  onResult: (result: ReferenceTrialResult) => Promise<void>;
  minRelevance?: number;
}) {
  assertDataset(input.dataset, true);
  const samples = input.dataset.samples.filter((sample) => sample.split === input.split);
  if (!samples.length) throw new Error('所选数据分组没有样本');
  const frozen = new Map(
    samples.map((sample) => [
      sample.id,
      { sample: structuredClone(sample), access: structuredClone(input.accessFor(sample)) },
    ]),
  );
  const datasetName = `werewolf/references-${input.dataset.hash.slice(0, 16)}`;
  await input.client.api.datasets.create({
    name: datasetName,
    description: '固定玩家视角、按来源对局隔离的参考材料评测',
  });
  const items = await Promise.all(
    samples.map((sample) =>
      input.client.dataset.createItem({
        datasetName,
        id: fingerprint({ datasetName, id: sample.id }),
        input: sample,
        expectedOutput: sample.labels,
        metadata: {
          annotation: sample.annotation,
          split: sample.split,
          corpusHash: sampleCorpus(input.dataset, sample).hash,
        },
        sourceTraceId: sample.source.traceId,
        sourceObservationId: sample.source.observationId,
      }),
    ),
  );
  const runs = [];
  const pairId = randomUUID();
  for (const variant of input.variants) {
    const run = await input.client.experiment.run({
      name: `${input.stage}/${variant}`,
      runName: `${pairId}-${variant}`,
      data: items,
      maxConcurrency: 2,
      metadata: {
        datasetHash: input.dataset.hash,
        corpusHash: input.dataset.corpus.hash,
        templatesHash: fingerprint(input.dataset.templates),
        split: input.split,
        variant,
        stage: input.stage,
        minRelevance: input.minRelevance ?? RETRIEVAL_POLICY.minRelevance,
        evaluatorVersion: 'references-v1',
        actionEvaluatorVersion: REFERENCE_ACTION_EVALUATOR.version,
      },
      task: async ({ input: value }) => {
        const entry = frozen.get((value as ReferenceSample).id);
        if (!entry || fingerprint(value) !== fingerprint(entry.sample))
          throw new Error('平台数据集输入与本地冻结样本不一致');
        const result = await runReferenceTrial({
          ...input,
          sample: entry.sample,
          variant,
          access: entry.access,
        });
        await input.onResult(result);
        return result;
      },
      evaluators: [async ({ output }) => trialScores(output as ReferenceTrialResult)],
    });
    runs.push(run);
    if (
      run.itemResults.length !== samples.length ||
      !run.datasetRunId ||
      run.itemResults.some(
        (result) =>
          !result.output ||
          trialScores(result.output as ReferenceTrialResult).some(
            (score) =>
              !result.evaluations.some(
                (evaluation) => evaluation.name === score.name && evaluation.value === score.value,
              ),
          ),
      )
    )
      throw new Error('实验存在失败样本或未完成评分，不能按通过处理；请检查已保存结果');
  }
  return runs;
}
