import type { LangfuseClient } from '@langfuse/client';
import { startObservation, type LangfuseGeneration } from '@langfuse/tracing';
import { randomUUID } from 'node:crypto';
import type { ModelAccess, ModelPort } from './model-port';
import { ModelCallError } from './model-port';
import { tokenUsage, type AttemptCompletion } from './observation';
import { requestPricing } from './cost';
import { finishRequest, promptAttributes } from './telemetry';
import { fingerprint, type PromptComparison } from '../turn/prompt-comparison';

/** 原生 dataset + 两个 experiment run；每个 run 只允许一条输入、一次真实请求。 */
export async function runPromptExperiment(input: {
  client: LangfuseClient;
  comparison: PromptComparison;
  port: ModelPort;
  access: ModelAccess;
  source: { gameId: string; actionKey: string; traceId?: string; observationId?: string };
  onResult: (result: Record<string, unknown>) => Promise<void>;
}) {
  // 运行中不再读配置、标签或输入，双方共用同一份接入条件。
  const { comparison, access } = structuredClone({
    comparison: input.comparison,
    access: input.access,
  });
  if (
    access.model !== comparison.input.model ||
    fingerprint(access.capability) !== fingerprint(comparison.input.capability)
  ) {
    throw new Error('模型条件与固定输入不一致');
  }
  const { client, port, source, onResult } = input;
  const pairId = randomUUID();
  const datasetName = `werewolf/prompt-input-${comparison.inputHash.slice(0, 16)}`;
  await client.api.datasets.create({
    name: datasetName,
    description: '同一玩家当时可见输入的单次生成对照',
  });
  const item = await client.dataset.createItem({
    datasetName,
    id: comparison.inputHash,
    input: comparison.input,
    metadata: { sourceGameId: source.gameId, sourceActionKey: source.actionKey },
    sourceTraceId: source.traceId,
    sourceObservationId: source.observationId,
  });
  const conditionsHash = fingerprint({
    input: comparison.input,
    endpoint: access.baseUrl,
    stream: false,
  });
  const results: Record<string, unknown>[] = [];
  for (const variant of comparison.variants) {
    const version = variant.templates.find(
      (template) => template.name === comparison.promptName,
    )!.version;
    let attempt: AttemptCompletion | undefined;
    let dispatched = 0;
    const run = await client.experiment.run({
      name: `${variant.label} ${comparison.promptName} v${version}`,
      runName: `${pairId}-${variant.label}-v${version}`,
      description: '单次生成输出；不执行质疑、修订、行动结算或自动评分',
      data: [item],
      maxConcurrency: 1,
      metadata: {
        pairId,
        inputHash: comparison.inputHash,
        conditionsHash,
        prompts: variant.request.prompts,
        scope: 'single-generation',
      },
      task: async ({ input: datasetInput }) => {
        if (fingerprint(datasetInput) !== comparison.inputHash)
          throw new Error('数据集输入与固定输入不一致');
        let generation: LangfuseGeneration | undefined;
        let pricing: ReturnType<typeof requestPricing> | undefined;
        try {
          const response = await port.generate(variant.request, access, {
            onResponse: (received) =>
              generation?.update({
                output: {
                  content: received.content,
                  toolCall: received.toolCall,
                  reasoning: received.reasoning,
                },
              }),
            startAttempt: async () => ({
              dispatched() {
                pricing = requestPricing(access, new Date());
                dispatched++;
                generation = startObservation(
                  'prompt-comparison.generate',
                  {
                    ...promptAttributes(variant.request),
                    model: access.model,
                    input: {
                      system: variant.request.system,
                      prompt: variant.request.prompt,
                      tool: variant.request.tool,
                    },
                  },
                  { asType: 'generation' },
                );
              },
              async finish(result) {
                attempt = result;
                finishRequest(generation, result, pricing);
              },
            }),
          });
          return {
            content: response.content,
            toolCall: response.toolCall,
            reasoning: response.reasoning,
          };
        } catch (error) {
          // SDK 会记录任务异常，避免把供应商原始错误正文带入实验日志。
          throw new Error(
            `模型请求失败：${error instanceof ModelCallError ? error.code : 'internal'}`,
            { cause: error },
          );
        }
      },
    });
    const result = {
      label: variant.label,
      version,
      pairId,
      datasetName,
      runName: run.runName,
      url: run.datasetRunUrl,
      inputHash: comparison.inputHash,
      conditionsHash,
      prompts: variant.request.prompts,
      modelCalls: dispatched,
      usage: tokenUsage(attempt?.usage ?? null),
      usageComplete: attempt?.usageComplete ?? false,
      durationMs: attempt?.durationMs ?? null,
      results: run.itemResults.map(({ output, traceId }) => ({ output, traceId })),
    };
    results.push(result);
    await onResult(result);
    if (run.itemResults.length !== 1 || !run.datasetRunId) {
      throw new Error('实验未完整完成或未关联到 Langfuse 数据集，请检查已保存结果');
    }
  }
  return results;
}
