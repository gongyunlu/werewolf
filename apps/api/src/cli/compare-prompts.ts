import 'reflect-metadata';
import { LangfuseClient } from '@langfuse/client';
import { Logger } from '@nestjs/common';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { seatContextOf } from '../agents/seat-context';
import { loadEnv } from '../config/env';
import { loadEnvFiles } from '../config/env-files';
import { modelRuntimeOf, promptSourceOf } from '../llm/from-env';
import { openaiModelPort } from '../llm/openai-model-port';
import { runPromptExperiment } from '../llm/prompt-experiment';
import { assertPromptSample, sampleMetadata } from '../llm/prompt-sample';
import { startTelemetry, stopTelemetry } from '../llm/telemetry';
import { openPrismaClient, prismaStores } from '../store/prisma';
import { comparisonInput, preparePromptComparison } from '../turn/prompt-comparison';
import { loadPromptAction } from './prompt-action';

async function main() {
  const { values } = parseArgs({
    options: {
      game: { type: 'string' },
      action: { type: 'string' },
      sample: { type: 'string' },
      prompt: { type: 'string', default: 'turn/generate-system' },
      baseline: { type: 'string' },
      candidate: { type: 'string' },
      run: { type: 'boolean', default: false },
    },
  });
  if (values.sample && (values.game || values.action))
    throw new Error('--sample 不能与 --game 或 --action 同用');
  if (!values.game && !values.sample)
    throw new Error(
      '用法：prompt:compare --game <对局id>；选择 --game <id> --action <键> 或 --sample <样本id>，再加 --baseline <版本> --candidate <版本> [--run]',
    );
  loadEnvFiles();
  const env = loadEnv();
  const needsPlatform = Boolean(values.action || values.sample);
  if (needsPlatform && (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY))
    throw new Error('版本对照需要配置 Langfuse');
  const client = needsPlatform
    ? new LangfuseClient({
        baseUrl: env.LANGFUSE_HOST,
        publicKey: env.LANGFUSE_PUBLIC_KEY,
        secretKey: env.LANGFUSE_SECRET_KEY,
      })
    : undefined;
  const sample = values.sample ? await client!.api.datasetItems.get(values.sample) : undefined;
  const sampleInfo = sample ? sampleMetadata(sample) : undefined;
  const gameId = sampleInfo?.source.gameId ?? values.game!;
  const actionKey = sampleInfo?.source.actionKey ?? values.action;
  const db = openPrismaClient(env.DATABASE_URL);
  try {
    const stores = prismaStores(db);
    if (!actionKey) {
      if (!(await stores.games.find(gameId))) throw new Error('没有这局对局');
      const actions = await stores.actions.summaries(gameId);
      Logger.log(
        JSON.stringify(
          actions
            .filter((action) => action.status === 'done')
            .map((action) => ({
              actionKey: action.actionKey,
              actionType: action.actionType,
              actorId: action.actorId,
            })),
          null,
          2,
        ),
      );
      return;
    }
    const { game, snapshot, tool, source } = await loadPromptAction(db, gameId, actionKey);
    if (sample) assertPromptSample(sample, comparisonInput(snapshot, tool), source);
    const comparison = await preparePromptComparison(
      snapshot,
      promptSourceOf(env),
      {
        name: values.prompt!,
        baseline: Number(values.baseline),
        candidate: Number(values.candidate),
      },
      tool,
    );
    const { access: fallback } = modelRuntimeOf(env);
    const seat = game.roster.find((entry) => entry.seatNo === snapshot.context.actor.seatNo);
    const { accessFor } = await seatContextOf({
      env,
      roster: seat ? [seat] : [],
      agents: stores.agents,
      fallback,
    });
    const access = {
      ...accessFor(snapshot.context.actor.seatNo),
      model: snapshot.model,
      capability: snapshot.capability,
    };
    const directory = resolve(__dirname, '../../../../docs/prompt-comparisons', randomUUID());
    await mkdir(directory, { recursive: true });
    const save = (name: string, value: unknown) =>
      writeFile(resolve(directory, name), JSON.stringify(value, null, 2), 'utf8');
    await save('input.json', {
      sourceGameId: game.gameId,
      sourceActionKey: actionKey,
      ...(sample
        ? { sample: { id: sample.id, datasetName: sample.datasetName, metadata: sample.metadata } }
        : {}),
      ...comparison,
      modelConditions: { model: access.model, capability: access.capability, stream: false },
    });
    Logger.log(`已保存固定输入与两份实际请求：${directory}`);
    if (!values.run) {
      Logger.log('预览完成，模型调用 0 次；加 --run 执行一次 A/B。');
      return;
    }
    startTelemetry(env);
    const results = await runPromptExperiment({
      client: client!,
      comparison,
      access,
      // 不套网络重试或格式重试，每个版本只发起一次请求。
      port: openaiModelPort({ timeoutMs: env.MODEL_REQUEST_TIMEOUT_MS }),
      source,
      datasetItem: sample,
      onResult: (result) => save(`${result.label}.json`, result),
    });
    Logger.log(
      JSON.stringify(
        results.map(({ label, url, modelCalls, usage }) => ({ label, url, modelCalls, usage })),
        null,
        2,
      ),
    );
  } finally {
    await Promise.all([db.$disconnect(), stopTelemetry()]);
  }
}

void main().catch((error: unknown) => {
  Logger.error(error instanceof Error ? error.message : '版本对照失败');
  process.exitCode = 1;
});
