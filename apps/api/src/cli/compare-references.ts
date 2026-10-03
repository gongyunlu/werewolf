import 'reflect-metadata';
import { LangfuseClient } from '@langfuse/client';
import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { seatContextOf } from '../agents/seat-context';
import { loadEnv } from '../config/env';
import { loadEnvFiles } from '../config/env-files';
import { assertDataset, type ReferenceDataset } from '../evaluation/reference-dataset';
import {
  runReferenceExperiment,
  REFERENCE_ACTION_EVALUATOR,
  type ReferenceTrialResult,
} from '../evaluation/reference-experiment';
import { embeddingRuntime } from '../llm/embedding';
import { modelRuntimeOf } from '../llm/from-env';
import type { ModelAccess } from '../llm/model-port';
import { startTelemetry, stopTelemetry } from '../llm/telemetry';
import { openPrismaClient, prismaStores } from '../store/prisma';
import type { RosterSeat } from '../store/games';
import { referenceSummary } from '../evaluation/reference-summary';
import { RETRIEVAL_POLICY } from '../experience/retrieval-ranking';

async function main() {
  const { values } = parseArgs({
    options: {
      dataset: { type: 'string' },
      output: { type: 'string' },
      run: { type: 'boolean', default: false },
      stage: { type: 'string', default: 'retrieval' },
      split: { type: 'string', default: 'test' },
      variants: { type: 'string', default: 'none,vector,hybrid' },
      'min-relevance': { type: 'string', default: String(RETRIEVAL_POLICY.minRelevance) },
    },
  });
  if (!values.dataset)
    throw new Error(
      '用法：references:compare --dataset <已标注数据集.json> [--stage retrieval|action] [--split development|test] [--variants none,vector,hybrid,curated] [--run]',
    );
  const dataset: ReferenceDataset = JSON.parse(await readFile(values.dataset, 'utf8'));
  assertDataset(dataset, true);
  const stage = z.enum(['retrieval', 'action']).parse(values.stage);
  const split = z.enum(['development', 'test']).parse(values.split);
  const variants = z
    .array(z.enum(['none', 'vector', 'hybrid', 'curated']))
    .min(1)
    .parse(values.variants!.split(','));
  if (new Set(variants).size !== variants.length) throw new Error('实验组不能重复');
  const minRelevance = z.number().int().min(1).max(3).parse(Number(values['min-relevance']));
  const samples = dataset.samples.filter((sample) => sample.split === split);
  if (!samples.length) throw new Error('所选分组没有行动');
  loadEnvFiles();
  const env = loadEnv();
  const db = openPrismaClient(env.DATABASE_URL);
  try {
    const stores = prismaStores(db);
    const { port, access: fallback } = modelRuntimeOf(env);
    const gameIds = [...new Set(samples.map((sample) => sample.source.gameId))];
    const games = await db.game.findMany({
      where: { id: { in: gameIds } },
      select: { id: true, roster: true },
    });
    if (games.length !== gameIds.length) throw new Error('来源对局不存在，无法解析原模型接入');
    const seatIds = new Map<string, number>();
    const roster = games.flatMap((game) =>
      (game.roster as unknown as RosterSeat[]).map((seat) => {
        const seatNo = seatIds.size + 1;
        seatIds.set(`${game.id}/${seat.seatNo}`, seatNo);
        return { ...seat, seatNo };
      }),
    );
    const seats = await seatContextOf({ env, roster, agents: stores.agents, fallback });
    const accesses = new Map<string, ModelAccess>();
    for (const sample of samples) {
      const seatNo = seatIds.get(`${sample.source.gameId}/${sample.context.actor.seatNo}`);
      if (!seatNo && roster.length) throw new Error('来源阵容缺少被测座位');
      accesses.set(sample.id, {
        ...seats.accessFor(seatNo ?? null),
        model: sample.model,
        capability: sample.capability,
      });
    }
    const directory = resolve(values.output ?? `docs/reference-experiments/${randomUUID()}`);
    await mkdir(directory, { recursive: true });
    const save = (name: string, value: unknown) =>
      writeFile(resolve(directory, name), JSON.stringify(value, null, 2), 'utf8');
    await save('conditions.json', {
      datasetHash: dataset.hash,
      corpusHash: dataset.corpus.hash,
      temporalPolicy: dataset.temporalPolicy,
      stage,
      split,
      variants,
      minRelevance,
      retrievalPolicy: RETRIEVAL_POLICY,
      actionEvaluatorVersion: REFERENCE_ACTION_EVALUATOR.version,
      samples: samples.map((sample) => {
        const access = accesses.get(sample.id)!;
        return {
          id: sample.id,
          model: access.model,
          endpoint: access.baseUrl,
          capability: access.capability,
        };
      }),
      interpretation:
        '冻结当前语料的回放仅比较当前策略，不证明材料在原行动时可用；agent-reviewed 标签不是人工金标准；curated 使用标签作为输入，只是参考上界。',
    });
    await save('dataset.json', dataset);
    Logger.log(`固定输入已保存：${directory}；${samples.length} 条行动，${variants.length} 组。`);
    if (!values.run) {
      Logger.log('预览完成，模型调用 0 次；加 --run 执行。');
      return;
    }
    if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY)
      throw new Error('评测需要配置 Langfuse');
    startTelemetry(env);
    const results: ReferenceTrialResult[] = [];
    const runs = await runReferenceExperiment({
      client: new LangfuseClient({
        baseUrl: env.LANGFUSE_HOST,
        publicKey: env.LANGFUSE_PUBLIC_KEY,
        secretKey: env.LANGFUSE_SECRET_KEY,
      }),
      dataset,
      variants,
      stage,
      split,
      minRelevance,
      port,
      embedding: embeddingRuntime(env),
      accessFor: (sample) => accesses.get(sample.id)!,
      async onResult(result) {
        const completed = results.push(result);
        await save(
          `${result.variant}-${dataset.samples.findIndex((sample) => sample.id === result.sampleId)}.json`,
          result,
        );
        if (completed % 10 === 0 || completed === samples.length * variants.length)
          Logger.log(`已完成 ${completed}/${samples.length * variants.length}：${result.variant}`);
      },
    });
    await save('summary.json', {
      runs: runs.map((run) => ({ name: run.runName, url: run.datasetRunUrl })),
      groups: referenceSummary(results, dataset),
    });
    Logger.log(
      JSON.stringify(
        referenceSummary(results, dataset).filter((row) => !row.group.includes('/')),
        null,
        2,
      ),
    );
  } finally {
    await Promise.all([db.$disconnect(), stopTelemetry()]);
  }
}

void main().catch((error: unknown) => {
  Logger.error(error instanceof Error ? error.message : '参考材料评测失败');
  process.exitCode = 1;
});
