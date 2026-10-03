import type { ExperimentParams, LangfuseClient } from '@langfuse/client';
import type { ExperienceSnapshot } from '@werewolf/shared';
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client';
import {
  access,
  controlledPort,
  result as experienceResult,
  vectorRuntime,
} from '../experience/testing';
import { experienceDocument, knowledgeDocument } from '../experience/retrieval';
import { INITIAL_KNOWLEDGE } from '../knowledge/initial-content';
import { knowledgeEmbeddingKey } from '../knowledge/text';
import { embeddingKey } from '../llm/embedding';
import type { ModelPort } from '../llm/model-port';
import { toolOf } from '../llm/structured-output';
import { LOCAL_PROMPTS, TURN_PROMPT_NAMES } from '../prompts/catalog';
import { memoryStores } from '../store/memory';
import {
  assertCorpus,
  corpusBefore,
  exportReferenceCorpus,
  freezeReferenceStores,
  sealCorpus,
} from './reference-corpus';
import {
  assertDataset,
  exportReferenceDataset,
  sampleCorpus,
  sealDataset,
  stratifiedSamples,
  type ReferenceDataset,
  type ReferenceSample,
} from './reference-dataset';
import {
  referenceMetrics,
  runReferenceExperiment,
  runReferenceTrial,
  trialScores,
  type ReferenceTrialResult,
  type ReferenceVariant,
} from './reference-experiment';
import { referenceSummary } from './reference-summary';

const oldDate = '2026-09-01T00:00:00.000Z';
const actionDate = '2026-09-15T00:00:00.000Z';
const newDate = '2026-10-01T00:00:00.000Z';
const choiceSchema = z.number().int().min(1).max(2);
const experience: ExperienceSnapshot = {
  ...experienceResult.experiences[0]!,
  actionTypes: ['guard_protect'],
  id: 'old-experience',
  agentId: 'agent',
  version: 1,
  generationId: 'generation',
  sourceGameId: 'old-game',
  sourcePlayerId: 'p1',
  boardId: '12p_wolf_king',
  role: 'guard',
};

async function fixture() {
  const embedding = vectorRuntime();
  const knowledge = {
    id: '11111111-1111-4111-a111-111111111111',
    versionId: '22222222-2222-4222-a222-222222222222',
    version: 1,
    content: INITIAL_KNOWLEDGE[0]!.content,
  };
  const corpus = sealCorpus({
    version: 1,
    createdAt: newDate,
    experiences: [
      {
        snapshot: structuredClone(experience),
        embeddingKey: embeddingKey(embedding),
        vector: [1, 0],
        createdAt: oldDate,
      },
    ],
    knowledge: [
      {
        snapshot: structuredClone(knowledge),
        embeddingKey: knowledgeEmbeddingKey(embedding),
        vector: [1, 0],
        createdAt: oldDate,
      },
    ],
  });
  const sample: ReferenceSample = {
    id: 'guard-action',
    source: { gameId: 'held-out', actionKey: 'guard-action', createdAt: actionDate },
    boardId: '12p_wolf_king',
    role: 'guard',
    split: 'test',
    actionType: 'guard_protect',
    preset: 'quality',
    context: {
      task: '第一夜选择守护目标',
      actor: { playerId: 'p1', seatNo: 1, role: '守卫' },
      day: 1,
      visible: [{ title: '你手里的牌', lines: ['你还没守过人。'] }],
      options: ['1号', '2号'],
      skill: ['守卫不能连续两晚守护同一玩家。'],
    },
    schema: z.toJSONSchema(choiceSchema),
    tool: toolOf(choiceSchema, '提交守护目标'),
    model: access.model,
    capability: access.capability,
    labels: {
      [experienceDocument(experience).key]: {
        relevance: 1,
        applicable: true,
        note: '时序经验与首夜守护关系弱',
      },
      [knowledgeDocument(knowledge).key]: {
        relevance: 3,
        applicable: true,
        note: '首夜守护策略适用',
      },
    },
    annotation: { author: '用例审核员', basis: 'human', note: '仅依据行动当时的信息' },
  };
  const templates = await Promise.all(
    Object.values(TURN_PROMPT_NAMES).map((name) => LOCAL_PROMPTS.load(name)),
  );
  return {
    embedding,
    sample,
    knowledge,
    dataset: sealDataset({
      version: 1,
      temporalPolicy: 'frozen-retrospective',
      corpus,
      templates,
      samples: [sample],
    }),
  };
}

function reseal(dataset: ReferenceDataset) {
  const { hash: _hash, ...body } = dataset;
  return sealDataset(body);
}

function model() {
  const generate = jest.fn<ReturnType<ModelPort['generate']>, Parameters<ModelPort['generate']>>(
    async (request, modelAccess, options) => {
      const step = options?.identity?.step;
      const answer =
        step === 'reference_rerank'
          ? JSON.stringify(
              (
                JSON.parse(request.prompt) as { candidates: Array<{ key: string; kind: string }> }
              ).candidates.map(({ key, kind }) => ({
                key,
                relevance: kind === 'knowledge' ? 3 : 1,
                applicable: true,
                reason: '依据首夜行动条件',
                duplicateOf: null,
              })),
            )
          : step === 'critique'
            ? JSON.stringify({ accept: false, issues: '按用例要求核对后修订' })
            : step === 'reference_evaluation'
              ? JSON.stringify({
                  ruleViolation: false,
                  perspectiveViolation: false,
                  historicalFactMisuse: false,
                  strategyQuality: 2,
                  reason: '只使用可见信息与当时合法目标',
                })
              : step === 'revise'
                ? '2'
                : '1';
      return controlledPort(answer).generate(request, modelAccess, options);
    },
  );
  return { generate };
}

describe('冻结参考语料与行动数据集', () => {
  it('正文或向量被篡改时指纹拒绝，同版本重复与无效向量也拒绝', async () => {
    const { dataset } = await fixture();
    expect(assertCorpus(dataset.corpus)).toEqual(dataset.corpus);
    const changed = structuredClone(dataset.corpus);
    changed.experiences[0]!.snapshot.body = '事后改写';
    expect(() => assertCorpus(changed)).toThrow('指纹');
    const { hash: _hash, ...input } = dataset.corpus;
    expect(() =>
      assertCorpus(
        sealCorpus({ ...input, experiences: [input.experiences[0]!, input.experiences[0]!] }),
      ),
    ).toThrow('重复');
    expect(() =>
      assertCorpus(
        sealCorpus({ ...input, experiences: [{ ...input.experiences[0]!, vector: [0, 0] }] }),
      ),
    ).toThrow('范数');
  });

  it('按来源局整局排除，并按时间界线筛掉尚不存在的知识与经验', async () => {
    const { dataset } = await fixture();
    const { hash: _hash, ...input } = dataset.corpus;
    const corpus = sealCorpus({
      ...input,
      experiences: [
        input.experiences[0]!,
        {
          ...input.experiences[0]!,
          snapshot: { ...experience, id: 'held-1', sourceGameId: 'held-out' },
        },
        {
          ...input.experiences[0]!,
          snapshot: { ...experience, id: 'held-2', sourceGameId: 'other-held-out' },
        },
        { ...input.experiences[0]!, snapshot: { ...experience, id: 'future' }, createdAt: newDate },
      ],
      knowledge: [{ ...input.knowledge[0]!, createdAt: newDate }],
    });
    const filtered = corpusBefore(corpus, actionDate, ['held-out', 'other-held-out']);
    expect(filtered.experiences.map((row) => row.snapshot.id)).toEqual(['old-experience']);
    expect(filtered.knowledge).toEqual([]);
    expect(assertCorpus(filtered)).toEqual(filtered);
  });

  it('at-action与frozen-retrospective明确区分，并共同隔离数据集中所有来源局', async () => {
    const { dataset, sample } = await fixture();
    const { hash: _hash, ...input } = dataset.corpus;
    const corpus = sealCorpus({
      ...input,
      experiences: [
        { ...input.experiences[0]!, snapshot: { ...experience, sourceGameId: 'other-held-out' } },
      ],
      knowledge: [{ ...input.knowledge[0]!, createdAt: newDate }],
    });
    dataset.samples.push({
      ...sample,
      id: 'other',
      source: { ...sample.source, gameId: 'other-held-out' },
    });
    dataset.corpus = corpus;
    expect(sampleCorpus({ ...dataset, temporalPolicy: 'at-action' }, sample)).toMatchObject({
      experiences: [],
      knowledge: [],
    });
    const retrospective = sampleCorpus(
      { ...dataset, temporalPolicy: 'frozen-retrospective' },
      sample,
    );
    expect(retrospective.experiences).toEqual([]);
    expect(retrospective.knowledge).toHaveLength(1);
  });

  it('冻结store不读取或受修改后的在线语料影响，返回值修改也不会污染后续检索', async () => {
    const { dataset, embedding } = await fixture();
    const stores = memoryStores();
    const live = jest.spyOn(stores.experiences, 'search');
    const frozen = freezeReferenceStores(stores, dataset.corpus);
    dataset.corpus.experiences[0]!.snapshot.body = '在线被修改';
    const scope = {
      boardId: '12p_wolf_king',
      role: 'guard',
      day: 1,
      actionType: 'guard_protect',
      gameId: 'next',
    };
    const hits = await frozen.experiences.search(scope, embeddingKey(embedding), [1, 0], 20);
    expect(hits[0]!.experience.body).toBe(experience.body);
    hits[0]!.experience.body = '修改检索返回值';
    expect(
      (await frozen.experiences.search(scope, embeddingKey(embedding), [1, 0], 20))[0]!.experience
        .body,
    ).toBe(experience.body);
    expect(
      await frozen.experiences.search(
        { ...scope, actionType: 'vote' },
        embeddingKey(embedding),
        [1, 0],
        20,
      ),
    ).toEqual([]);
    expect(await frozen.experiences.search(scope, '其他索引', [1, 0], 20)).toEqual([]);
    expect(live).not.toHaveBeenCalled();
  });

  it('缺标注、漏标签、跨集同局和预装检索结果都不能当成合格评测集', async () => {
    const { dataset } = await fixture();
    expect(() => assertDataset(dataset, true)).not.toThrow();
    for (const change of [
      (copy: ReferenceDataset) => {
        copy.samples[0]!.annotation = null;
      },
      (copy: ReferenceDataset) => {
        delete copy.samples[0]!.labels![experienceDocument(experience).key];
      },
      (copy: ReferenceDataset) => {
        copy.samples.push({ ...copy.samples[0]!, id: 'second', split: 'development' });
      },
      (copy: ReferenceDataset) => {
        copy.samples[0]!.context.experiences = [experience];
      },
    ]) {
      const copy = structuredClone(dataset);
      change(copy);
      expect(() => assertDataset(reseal(copy), true)).toThrow();
    }
    const edited = structuredClone(dataset);
    edited.samples[0]!.context.task = '修改题目';
    expect(() => assertDataset(edited, true)).toThrow('指纹');
  });

  it('分层选样让少数夜间技能保留下来，导出当前版本不伪造早期可用时间', async () => {
    const { sample, dataset } = await fixture();
    const common = Array.from({ length: 10 }, (_, i) => ({
      ...sample,
      id: `speech-${i}`,
      actionType: 'speech' as const,
    }));
    expect(stratifiedSamples([...common, sample], 2).map((row) => row.actionType)).toEqual([
      'speech',
      'guard_protect',
    ]);
    const db = {
      agentExperience: {
        findMany: jest.fn(async () => [
          {
            content: { ...experience, reviews: [{ version: 1, decision: 'approved' }] },
            version: 1,
            embeddingKey: 'key',
            embedding: [1, 0],
            createdAt: new Date(oldDate),
          },
        ]),
      },
      knowledgeVersion: {
        findMany: jest.fn(async () => [
          {
            id: dataset.corpus.knowledge[0]!.snapshot.versionId,
            itemId: dataset.corpus.knowledge[0]!.snapshot.id,
            version: 1,
            content: dataset.corpus.knowledge[0]!.snapshot.content,
            embeddingKey: 'key',
            embedding: [1, 0],
            createdAt: new Date(oldDate),
          },
        ]),
      },
    } as unknown as PrismaClient;
    const exported = await exportReferenceCorpus(db);
    expect(exported.experiences[0]!.createdAt).toBe(exported.createdAt);
    expect(exported.knowledge[0]!.createdAt).toBe(exported.createdAt);
  });

  it('早期开发集层数超过上限时仍等额抽取后置测试集，并覆盖后续天数', async () => {
    const { sample } = await fixture();
    const samples = (['development', 'test'] as const).flatMap((split) =>
      [1, 2, 3].flatMap((day) =>
        Array.from({ length: 60 }, (_, index) => ({
          ...sample,
          id: `${split}-${day}-${index}`,
          split,
          boardId: `board-${index}`,
          context: { ...sample.context, day },
        })),
      ),
    );
    const selected = stratifiedSamples(samples, 60);
    expect(selected).toHaveLength(60);
    expect(selected.filter((row) => row.split === 'development')).toHaveLength(30);
    expect(selected.filter((row) => row.split === 'test')).toHaveLength(30);
    expect(selected.slice(0, 6).map((row) => [row.split, row.context.day])).toEqual([
      ['development', 1],
      ['test', 1],
      ['development', 2],
      ['test', 2],
      ['development', 3],
      ['test', 3],
    ]);
    for (const split of ['development', 'test']) {
      for (const day of [1, 2, 3]) {
        expect(
          selected.filter((row) => row.split === split && row.context.day === day),
        ).toHaveLength(10);
      }
    }
  });

  it.each([
    [1, 6, 6, 1, 5],
    [6, 1, 6, 5, 1],
    [0, 6, 4, 0, 4],
    [3, 0, 6, 3, 0],
  ])(
    '开发%d条、测试%d条在上限%d时由有余量的一组补齐',
    async (dev, test, limit, expectedDev, expectedTest) => {
      const { sample } = await fixture();
      const samples = (['development', 'test'] as const).flatMap((split, splitIndex) =>
        Array.from({ length: [dev, test][splitIndex]! }, (_, index) => ({
          ...sample,
          id: `${split}-${index}`,
          split,
        })),
      );
      const selected = stratifiedSamples(samples, limit);
      expect(selected.filter((row) => row.split === 'development')).toHaveLength(expectedDev);
      expect(selected.filter((row) => row.split === 'test')).toHaveLength(expectedTest);
      expect(new Set(selected.map((row) => row.id)).size).toBe(selected.length);
    },
  );

  it('各天内部仍按行动分层，不让首日的大量发言遮住技能或后续天数', async () => {
    const { sample } = await fixture();
    const samples = [1, 2].flatMap((day) => [
      ...Array.from({ length: 10 }, (_, index) => ({
        ...sample,
        id: `speech-${day}-${index}`,
        actionType: 'speech' as const,
        context: { ...sample.context, day },
      })),
      { ...sample, id: `guard-${day}`, context: { ...sample.context, day } },
    ]);
    expect(stratifiedSamples(samples, 4).map((row) => [row.context.day, row.actionType])).toEqual([
      [1, 'speech'],
      [2, 'speech'],
      [1, 'guard_protect'],
      [2, 'guard_protect'],
    ]);
  });

  it('导出实际包含指定测试局；测试局没有有效行动时明确报错', async () => {
    const { sample, dataset } = await fixture();
    const actions = ['development-game', 'test-game'].map((gameId) => ({
      actionKey: gameId,
      gameId,
      game: { boardId: sample.boardId },
      createdAt: new Date(actionDate),
      outcome: { snapshot: sample },
      experienceRetrieval: { scope: { role: sample.role } },
    }));
    const db = {
      actionRecord: { findMany: jest.fn(async () => actions) },
      askedPrompt: {
        findMany: jest.fn(async () => actions.map((row) => ({ actionKey: row.actionKey }))),
      },
    } as unknown as PrismaClient;
    const input = {
      db,
      corpus: dataset.corpus,
      gameIds: ['development-game', 'test-game'],
      testGameIds: ['test-game'],
      limit: 2,
      promptSource: LOCAL_PROMPTS,
      temporalPolicy: 'frozen-retrospective' as const,
    };
    const exported = await exportReferenceDataset(input);
    expect(exported.samples.map((row) => row.split)).toEqual(['development', 'test']);
    actions.pop();
    await expect(exportReferenceDataset(input)).rejects.toThrow('指定测试局未导出有效行动样本');
  });
});

describe('参考材料评测指标与完整行动执行', () => {
  it('nDCG固定按5个位置计算，返回一条最优材料不能伪装为满分；空分母不计分', () => {
    const labels = {
      a: { relevance: 3 as const, applicable: true, note: '适用' },
      b: { relevance: 3 as const, applicable: true, note: '适用' },
    };
    expect(referenceMetrics(labels, ['a'], ['a'])).toMatchObject({
      recall: 0.5,
      selectionRecall: 0.5,
      precision: 1,
      ndcg: 1 / (1 + 1 / Math.log2(3)),
    });
    expect(referenceMetrics({}, [], [])).toEqual({
      recall: null,
      selectionRecall: null,
      precision: null,
      ndcg: null,
      inapplicableRate: null,
      emptyCorrect: 1,
    });
    expect(
      referenceMetrics({ a: { relevance: 0, applicable: false, note: '不适用' } }, ['a'], ['a']),
    ).toMatchObject({
      recall: null,
      selectionRecall: null,
      precision: 0,
      ndcg: null,
      inapplicableRate: 1,
      emptyCorrect: 0,
    });
    expect(() => referenceMetrics(labels, ['unknown'], [])).toThrow('没有独立标签');
    expect(() => referenceMetrics(labels, ['a'], ['a', 'a'])).toThrow('重复');
  });

  it('候选召回完整但筛选漏掉直接相关材料时，选中召回率独立下降', () => {
    const labels = {
      a: { relevance: 3 as const, applicable: true, note: '直接相关' },
      b: { relevance: 3 as const, applicable: true, note: '直接相关' },
      c: { relevance: 2 as const, applicable: true, note: '部分相关' },
    };
    expect(referenceMetrics(labels, ['a', 'b', 'c'], ['a', 'c'])).toMatchObject({
      recall: 1,
      selectionRecall: 0.5,
      precision: 0.5,
    });
    expect(referenceMetrics(labels, ['a', 'b'], [])).toMatchObject({
      recall: 1,
      selectionRecall: 0,
      precision: null,
    });
  });

  it.each<ReferenceVariant>(['none', 'vector', 'hybrid', 'curated'])(
    '固定样本的%s变体按真实检索链路执行，模型调用符合模式',
    async (variant) => {
      const { dataset, sample, embedding, knowledge } = await fixture();
      const port = model();
      const trial = await runReferenceTrial({
        dataset,
        sample,
        embedding,
        port,
        access,
        variant,
        stage: 'retrieval',
      });
      const expected =
        variant === 'none'
          ? []
          : variant === 'vector'
            ? [experienceDocument(experience).key, knowledgeDocument(knowledge).key]
            : [knowledgeDocument(knowledge).key];
      expect(trial.selected).toEqual(expected);
      expect(port.generate).toHaveBeenCalledTimes(variant === 'hybrid' ? 1 : 0);
      expect(embedding.port.generate).toHaveBeenCalledTimes(
        ['vector', 'hybrid'].includes(variant) ? 1 : 0,
      );
      expect(trial.corpusHash).toBe(sampleCorpus(dataset, sample).hash);
    },
  );

  it('行动实验实际经过生成、质疑、修订再盲评，同一参考快照贯穿全链路', async () => {
    const { dataset, sample, embedding, knowledge } = await fixture();
    const before = structuredClone(dataset);
    const port = model();
    const trial = await runReferenceTrial({
      dataset,
      sample,
      embedding,
      port,
      access,
      variant: 'curated',
      stage: 'action',
    });
    expect(port.generate.mock.calls.map((call) => call[2]!.identity!.step)).toEqual([
      'generate',
      'critique',
      'revise',
      'reference_evaluation',
    ]);
    expect(trial.outcome!.decision).toBe(2);
    expect(trial.outcome!.snapshot.critique).toMatchObject({ accept: false });
    expect(trial.assessment).toMatchObject({ ruleViolation: false, strategyQuality: 2 });
    expect(trial.calls!.map((call) => call.step)).toEqual([
      'generate',
      'critique',
      'revise',
      'reference_evaluation',
    ]);
    expect(trialScores(trial)).toEqual(
      expect.arrayContaining([
        { name: 'model_requests', value: 4, comment: expect.any(String) },
        { name: 'total_tokens', value: 60, comment: expect.any(String) },
      ]),
    );
    expect(
      port.generate.mock.calls.every(([request]) =>
        request.prompt.includes(knowledge.content.body),
      ),
    ).toBe(true);
    expect(port.generate.mock.calls.at(-1)![0].system).toContain('公开诈身份');
    expect(port.generate.mock.calls.at(-1)![0].prompt).not.toContain('curated');
    expect(dataset).toEqual(before);
    expect(JSON.stringify(trial)).not.toContain('apiKey');
  });

  it('汇总保留各自有效分母，未运行行动评估不计作零违规', async () => {
    const { dataset } = await fixture();
    const base: ReferenceTrialResult = {
      sampleId: dataset.samples[0]!.id,
      variant: 'none',
      corpusHash: dataset.corpus.hash,
      selected: [],
      candidates: [],
      metrics: referenceMetrics({}, [], []),
      retrieval: {},
      durationMs: 10,
    };
    const second = {
      ...base,
      durationMs: 30,
      metrics: {
        recall: 1,
        selectionRecall: 0.5,
        precision: 0.5,
        ndcg: 0.5,
        inapplicableRate: 0,
        emptyCorrect: null,
      },
    };
    const summary = referenceSummary([base, second], dataset).find((row) => row.group === 'none')!;
    expect(summary).toMatchObject({
      samples: 2,
      recall: { count: 1, mean: 1 },
      selectionRecall: { count: 1, mean: 0.5 },
      precision: { count: 1, mean: 0.5 },
      emptyCorrect: { count: 1, mean: 1 },
      judgeRuleViolation: { count: 0, mean: null },
      durationMs: { p50: 10, p95: 30 },
    });
    expect(trialScores(base).map((score) => score.name)).not.toEqual(
      expect.arrayContaining(['recall', 'selectionRecall', 'precision', 'judge_rule_violation']),
    );
    expect(trialScores(base).map((score) => score.name)).not.toContain('selectionRecall');
    expect(trialScores(second)).toEqual(
      expect.arrayContaining([
        { name: 'selectionRecall', value: 0.5, comment: expect.any(String) },
      ]),
    );
  });
});

function platform() {
  const run = jest.fn(async (params: ExperimentParams) => {
    const output = await params.task(params.data[0]);
    const evaluator = params.evaluators![0] as (input: { output: unknown }) => Promise<unknown>;
    const evaluations = await evaluator({ output });
    return {
      runName: params.runName,
      datasetRunId: 'run-id',
      itemResults: [{ output, evaluations, traceId: 'trace-id' }],
    };
  });
  const client = {
    api: { datasets: { create: jest.fn(async () => ({})) } },
    dataset: {
      createItem: jest.fn(async ({ input }: { input: unknown }) => ({
        id: 'item-id',
        datasetId: 'dataset-id',
        input: structuredClone(input),
      })),
    },
    experiment: { run },
  } as unknown as LangfuseClient;
  return { client, run };
}

describe('Langfuse原生参考材料实验', () => {
  it('复用相同数据集条目并写评分结果，任务成功之外还要求关联原生run', async () => {
    const { dataset, embedding } = await fixture();
    const remote = platform();
    const saved: ReferenceTrialResult[] = [];
    const runs = await runReferenceExperiment({
      client: remote.client,
      dataset,
      embedding,
      port: model(),
      accessFor: () => access,
      variants: ['none', 'curated'],
      stage: 'retrieval',
      split: 'test',
      onResult: async (trial) => {
        saved.push(trial);
      },
    });
    expect(runs).toHaveLength(2);
    expect(saved.map((row) => row.variant)).toEqual(['none', 'curated']);
    expect(remote.run.mock.calls[0]![0].data[0]).toBe(remote.run.mock.calls[1]![0].data[0]);
    expect(remote.run.mock.calls[0]![0].metadata!.datasetHash).toBe(dataset.hash);
  });

  it('SDK吞掉失败、遗漏评分或没有原生run时，不能报告成功或继续下一变体', async () => {
    const { dataset, embedding } = await fixture();
    const remote = platform();
    remote.run.mockResolvedValueOnce({ runName: 'failed', itemResults: [] } as never);
    await expect(
      runReferenceExperiment({
        client: remote.client,
        dataset,
        embedding,
        port: model(),
        accessFor: () => access,
        variants: ['none', 'hybrid'],
        stage: 'retrieval',
        split: 'test',
        onResult: async () => {},
      }),
    ).rejects.toThrow();
    expect(remote.run).toHaveBeenCalledTimes(1);
  });

  it('平台改写玩家输入时在发起模型调用前拒绝', async () => {
    const { dataset, embedding } = await fixture();
    const remote = platform();
    jest
      .mocked(remote.client.dataset.createItem)
      .mockResolvedValue({ input: { future: '未来真实身份' } } as never);
    const port = model();
    await expect(
      runReferenceExperiment({
        client: remote.client,
        dataset,
        embedding,
        port,
        accessFor: () => access,
        variants: ['hybrid'],
        stage: 'retrieval',
        split: 'test',
        onResult: async () => {},
      }),
    ).rejects.toThrow();
    expect(port.generate).not.toHaveBeenCalled();
    expect(embedding.port.generate).not.toHaveBeenCalled();
  });

  it('任务已有结果但评分缺失时不继续第二变体', async () => {
    const { dataset, embedding } = await fixture();
    const remote = platform();
    remote.run.mockImplementationOnce(async (params) => ({
      runName: params.runName,
      datasetRunId: 'run-id',
      itemResults: [
        { output: await params.task(params.data[0]), evaluations: [], traceId: 'trace' },
      ],
    }));
    await expect(
      runReferenceExperiment({
        client: remote.client,
        dataset,
        embedding,
        port: model(),
        accessFor: () => access,
        variants: ['none', 'hybrid'],
        stage: 'retrieval',
        split: 'test',
        onResult: async () => {},
      }),
    ).rejects.toThrow('未完成评分');
    expect(remote.run).toHaveBeenCalledTimes(1);
  });
});
