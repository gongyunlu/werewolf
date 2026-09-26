import { LangfuseSpanProcessor } from '@langfuse/otel';
import {
  propagateAttributes,
  startObservation,
  type LangfuseGeneration,
  type LangfuseEmbedding,
  type LangfuseSpan,
} from '@langfuse/tracing';
import { isSpanContextValid, TraceFlags } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { Logger } from '@nestjs/common';
import type { AppEnv } from '../config/env';
import { tokenUsage, type AttemptCompletion, type CallCompletion } from './observation';
import type { ModelRequest } from './model-port';

/** 一次真实请求只有一个 generation，所有组成模板另存完整清单。 */
export function promptAttributes(request: Pick<ModelRequest, 'prompts' | 'primaryPrompt'>) {
  const prompts = request.prompts ?? [];
  const primary = request.primaryPrompt
    ? prompts.find((prompt) => prompt.name === request.primaryPrompt)
    : prompts[0];
  return {
    ...(primary?.source === 'platform' && primary.version !== null
      ? { prompt: { name: primary.name, version: primary.version, isFallback: false } }
      : {}),
    metadata: { prompts },
  };
}

const logger = new Logger('ModelTelemetry');
let sdk: NodeSDK | undefined;

export function startTelemetry(env: AppEnv): void {
  if (sdk || !env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return;
  sdk = telemetry(() => {
    const instance = new NodeSDK({
      serviceName: 'werewolf-api',
      autoDetectResources: false,
      spanProcessors: [
        new LangfuseSpanProcessor({
          publicKey: env.LANGFUSE_PUBLIC_KEY,
          secretKey: env.LANGFUSE_SECRET_KEY,
          baseUrl: env.LANGFUSE_HOST,
          mediaUploadEnabled: false,
        }),
      ],
    });
    instance.start();
    return instance;
  });
}

export async function stopTelemetry(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    logger.warn('观测导出关闭失败，本地调用记录仍保留');
  } finally {
    sdk = undefined;
  }
}

/** 遥测故障不改变业务结果，也不触发模型重试；日志不带供应商正文。 */
export function telemetry<T>(operation: () => T): T | undefined {
  try {
    return operation();
  } catch {
    logger.warn('观测记录失败，本地调用记录仍保留');
    return undefined;
  }
}

export function traceIds(span: LangfuseSpan | LangfuseGeneration | LangfuseEmbedding | undefined) {
  if (!span) return {};
  const context = span.otelSpan.spanContext();
  return isSpanContextValid(context) && (context.traceFlags & TraceFlags.SAMPLED) !== 0
    ? { traceId: context.traceId, spanId: context.spanId }
    : {};
}

export function callSpan(
  gameId: string,
  metadata: Record<string, unknown>,
): LangfuseSpan | undefined {
  if (!sdk) return undefined;
  return telemetry(() =>
    propagateAttributes({ sessionId: gameId }, () => startObservation('model.call', { metadata })),
  );
}

export function requestSpan(
  parent: LangfuseSpan | undefined,
  model: string,
  attemptNo: number,
  metadata: Record<string, unknown>,
  request: Pick<ModelRequest, 'prompts' | 'primaryPrompt' | 'embedding'> = {},
): LangfuseGeneration | LangfuseEmbedding | undefined {
  const attributes = promptAttributes(request);
  const values = {
    model,
    ...attributes,
    metadata: { ...metadata, ...attributes.metadata, attemptNo },
  };
  return (
    parent &&
    telemetry(() =>
      propagateAttributes({ sessionId: String(metadata.gameId) }, () =>
        request.embedding
          ? parent.startObservation('model.request', values, { asType: 'embedding' })
          : parent.startObservation('model.request', values, { asType: 'generation' }),
      ),
    )
  );
}

export function finishRequest(
  span: LangfuseGeneration | LangfuseEmbedding | undefined,
  result: AttemptCompletion,
): void {
  if (!span) return;
  telemetry(() => {
    const tokens = tokenUsage(result.usage);
    const usageDetails = Object.fromEntries(
      ['input', 'output', 'total'].flatMap((key) => {
        const value = tokens[key as 'input' | 'output' | 'total'];
        return result.usageComplete && value !== null ? [[key, value]] : [];
      }),
    );
    span.update({
      usageDetails,
      level: result.status === 'succeeded' ? 'DEFAULT' : 'ERROR',
      statusMessage: result.failureCode ?? undefined,
      metadata: {
        status: result.status,
        durationMs: result.durationMs,
        httpStatus: result.httpStatus,
        requestId: result.requestId,
        usageComplete: result.usageComplete,
        cacheRead: tokens.cacheRead,
        cacheWrite: tokens.cacheWrite,
        reasoning: tokens.reasoning,
      },
    });
    span.end();
  });
}

export function finishCall(span: LangfuseSpan | undefined, result: CallCompletion): void {
  if (!span) return;
  telemetry(() => {
    span.update({
      metadata: { ...result },
      level: result.status === 'accepted' ? 'DEFAULT' : 'ERROR',
      statusMessage: result.failureCode ?? undefined,
    });
    span.end();
  });
}
