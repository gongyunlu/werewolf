import { LangfuseSpanProcessor } from '@langfuse/otel';
import {
  propagateAttributes,
  startObservation,
  type LangfuseGeneration,
  type LangfuseEmbedding,
  type LangfuseSpan,
  type LangfuseAgent,
  type LangfuseChain,
  type LangfuseRetriever,
  type LangfuseSpanAttributes,
  type PropagateAttributesParams,
} from '@langfuse/tracing';
import { context, trace, isSpanContextValid, TraceFlags } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { Logger } from '@nestjs/common';
import type { AppEnv } from '../config/env';
import { tokenUsage, type AttemptCompletion, type CallCompletion } from './observation';
import { ModelCallError, type ModelRequest, type ModelResponse } from './model-port';
import { requestAccounting, type requestPricing } from './cost';

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
let deployment: Pick<LangfuseSpanAttributes, 'environment' | 'version'> = {};

export function startTelemetry(env: AppEnv): void {
  if (sdk || !env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return;
  deployment = {
    environment: env.NODE_ENV,
    ...(env.LANGFUSE_RELEASE ? { version: env.LANGFUSE_RELEASE } : {}),
  };
  sdk = telemetry(() => {
    const instance = new NodeSDK({
      serviceName: 'werewolf-api',
      autoDetectResources: false,
      spanProcessors: [
        new LangfuseSpanProcessor({
          publicKey: env.LANGFUSE_PUBLIC_KEY,
          secretKey: env.LANGFUSE_SECRET_KEY,
          baseUrl: env.LANGFUSE_HOST,
          environment: env.NODE_ENV,
          release: env.LANGFUSE_RELEASE || undefined,
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

/** 只隔离观测故障；业务回调始终只执行一次，原始异常继续向上传递。 */
export async function observeOperation<T>(
  name: string,
  asType: 'agent' | 'chain' | 'retriever',
  attributes: LangfuseSpanAttributes,
  operation: (span: LangfuseAgent | LangfuseChain | LangfuseRetriever | undefined) => Promise<T>,
  propagation: PropagateAttributesParams = {},
): Promise<T> {
  const observed = sdk
    ? telemetry(() =>
        propagateAttributes({ ...deployment, ...propagation }, () => {
          const span =
            asType === 'agent'
              ? startObservation(name, attributes, { asType: 'agent' })
              : asType === 'retriever'
                ? startObservation(name, attributes, { asType: 'retriever' })
                : startObservation(name, attributes, { asType: 'chain' });
          return { span, active: trace.setSpan(context.active(), span.otelSpan) };
        }),
      )
    : undefined;
  if (!observed) return operation(undefined);
  const { span, active } = observed;
  const run = async () => {
    try {
      return await operation(span);
    } catch (error) {
      telemetry(() =>
        span.update({
          level: error instanceof ModelCallError && error.code === 'deadline' ? 'WARNING' : 'ERROR',
          statusMessage: error instanceof ModelCallError ? error.code : 'operation_failed',
        }),
      );
      throw error;
    } finally {
      telemetry(() => span.end());
    }
  };
  return context.with(active, run);
}

export function traceIds(span: LangfuseSpan | LangfuseGeneration | LangfuseEmbedding | undefined) {
  if (!span) return {};
  const identity = span.otelSpan.spanContext();
  return isSpanContextValid(identity) && (identity.traceFlags & TraceFlags.SAMPLED) !== 0
    ? { traceId: identity.traceId, spanId: identity.spanId }
    : {};
}

export function callSpan(
  gameId: string | null,
  metadata: Record<string, unknown>,
): LangfuseSpan | undefined {
  if (!sdk) return undefined;
  return telemetry(() =>
    propagateAttributes(
      { sessionId: gameId ?? `knowledge/${String(metadata.knowledgeVersionId)}` },
      () => startObservation('model.call', { ...deployment, metadata }),
    ),
  );
}

export function requestSpan(
  parent: LangfuseSpan | undefined,
  model: string,
  attemptNo: number,
  metadata: Record<string, unknown>,
  request: Pick<ModelRequest, 'prompts' | 'primaryPrompt' | 'embedding'> = {},
  body?: string,
): LangfuseGeneration | LangfuseEmbedding | undefined {
  const attributes = promptAttributes(request);
  const values = {
    ...deployment,
    model,
    ...attributes,
    metadata: {
      ...metadata,
      ...attributes.metadata,
      attemptNo,
      transportRetry: attemptNo > 1,
      costStatus: 'unknown',
      costReason: 'request_pending',
      usageComplete: false,
    },
  };
  return (
    parent &&
    telemetry(() => {
      const captured = { ...values, ...(body === undefined ? {} : { input: JSON.parse(body) }) };
      return propagateAttributes(
        {
          sessionId:
            metadata.gameId == null
              ? `knowledge/${String(metadata.knowledgeVersionId)}`
              : String(metadata.gameId),
        },
        () =>
          request.embedding
            ? parent.startObservation(`model.request.${String(metadata.step)}`, captured, {
                asType: 'embedding',
              })
            : parent.startObservation(`model.request.${String(metadata.step)}`, captured, {
                asType: 'generation',
              }),
      );
    })
  );
}

export function recordResponse(
  span: LangfuseGeneration | LangfuseEmbedding | undefined,
  response: ModelResponse,
): void {
  telemetry(() =>
    span?.update({
      output: response.vector
        ? { dimensions: response.vector.length }
        : {
            role: 'assistant',
            content: response.content,
            ...(response.toolCall
              ? { tool_calls: [{ type: 'function', function: response.toolCall }] }
              : {}),
            ...(response.reasoning === null ? {} : { reasoning_content: response.reasoning }),
          },
    }),
  );
}

export function finishRequest(
  span: LangfuseGeneration | LangfuseEmbedding | undefined,
  result: AttemptCompletion,
  pricing?: ReturnType<typeof requestPricing>,
): void {
  if (!span) return;
  telemetry(() => {
    const tokens = tokenUsage(result.usage);
    const accounting = requestAccounting(result, pricing);
    span.update({
      usageDetails: accounting.usageDetails,
      costDetails: accounting.costDetails,
      level:
        result.status === 'succeeded'
          ? 'DEFAULT'
          : result.status === 'cancelled'
            ? 'WARNING'
            : 'ERROR',
      statusMessage: result.failureCode ?? undefined,
      metadata: {
        ...accounting.metadata,
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
