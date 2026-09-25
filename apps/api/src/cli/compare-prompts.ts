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
import type { ModelTool } from '../llm/model-port';
import { openaiModelPort } from '../llm/openai-model-port';
import { runPromptExperiment } from '../llm/prompt-experiment';
import { startTelemetry, stopTelemetry } from '../llm/telemetry';
import { openPrismaClient, prismaStores } from '../store/prisma';
import { preparePromptComparison } from '../turn/prompt-comparison';
import type { TurnOutcome } from '../turn/graph';

async function main() {
  const { values } = parseArgs({
    options: {
      game: { type: 'string' },
      action: { type: 'string' },
      prompt: { type: 'string', default: 'turn/generate-system' },
      baseline: { type: 'string' },
      candidate: { type: 'string' },
      run: { type: 'boolean', default: false },
    },
  });
  if (!values.game)
    throw new Error(
      '用法：prompt:compare --game <对局id>；选好 action 后再加 --action <键> --baseline <版本> --candidate <版本> [--run]',
    );
  loadEnvFiles();
  const env = loadEnv();
  const db = openPrismaClient(env.DATABASE_URL);
  try {
    const stores = prismaStores(db);
    const game = await stores.games.find(values.game);
    if (!game) throw new Error('没有这局对局');
    if (!values.action) {
      const actions = await stores.actions.summaries(values.game);
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
    if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY)
      throw new Error('版本对照需要配置 Langfuse');
    const action = await stores.actions.find(values.action);
    if (!action || action.gameId !== game.gameId || action.status !== 'done')
      throw new Error('需要本局已完成的行动');
    const { snapshot } = action.outcome as TurnOutcome;
    const asked = await db.askedPrompt.findFirst({
      where: {
        gameId: game.gameId,
        actionKey: action.actionKey,
        step: 'generate',
        formatAttempt: 1,
      },
      orderBy: { id: 'asc' },
      select: { tool: true, traceId: true, spanId: true },
    });
    if (!asked) throw new Error('原行动没有生成调用记录');
    const comparison = await preparePromptComparison(
      snapshot,
      promptSourceOf(env),
      {
        name: values.prompt!,
        baseline: Number(values.baseline),
        candidate: Number(values.candidate),
      },
      asked.tool === null ? undefined : (asked.tool as unknown as ModelTool),
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
      sourceActionKey: action.actionKey,
      ...comparison,
      modelConditions: { model: access.model, capability: access.capability, stream: false },
    });
    Logger.log(`已保存固定输入与两份实际请求：${directory}`);
    if (!values.run) {
      Logger.log('预览完成，模型调用 0 次；加 --run 执行一次 A/B。');
      return;
    }
    startTelemetry(env);
    const client = new LangfuseClient({
      baseUrl: env.LANGFUSE_HOST,
      publicKey: env.LANGFUSE_PUBLIC_KEY,
      secretKey: env.LANGFUSE_SECRET_KEY,
    });
    const results = await runPromptExperiment({
      client,
      comparison,
      access,
      // 不套网络重试或格式重试，每个版本只发起一次请求。
      port: openaiModelPort({ timeoutMs: env.MODEL_REQUEST_TIMEOUT_MS }),
      source: {
        gameId: game.gameId,
        actionKey: action.actionKey,
        traceId: asked.traceId ?? undefined,
        observationId: asked.spanId ?? undefined,
      },
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
