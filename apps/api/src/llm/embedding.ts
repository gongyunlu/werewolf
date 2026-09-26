import { createHash } from 'node:crypto';
import { loadEnv, type AppEnv } from '../config/env';
import { openaiModelPort } from './openai-model-port';
import { retryingModelPort } from './retrying-model-port';
import { ModelCallError, type ModelAccess, type ModelPort } from './model-port';

export interface EmbeddingRuntime {
  port: ModelPort;
  access: ModelAccess;
  dimensions: number;
}

export function embeddingRuntime(env: AppEnv = loadEnv()): EmbeddingRuntime {
  if (!env.EMBEDDING_MODEL) throw new Error('尚未配置 EMBEDDING_MODEL，无法建立或检索经验向量');
  return {
    port: retryingModelPort(openaiModelPort({ timeoutMs: env.MODEL_REQUEST_TIMEOUT_MS }), {
      attempts: env.MODEL_MAX_ATTEMPTS,
    }),
    access: {
      model: env.EMBEDDING_MODEL,
      baseUrl: env.EMBEDDING_BASE_URL || env.MODEL_BASE_URL,
      apiKey: env.EMBEDDING_API_KEY || env.MODEL_API_KEY,
      capability: { reasoningOff: null },
    },
    dimensions: env.EMBEDDING_DIMENSIONS,
  };
}

export function embeddingKey(runtime: Pick<EmbeddingRuntime, 'access' | 'dimensions'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        runtime.access.baseUrl.replace(/\/$/, ''),
        runtime.access.model,
        runtime.dimensions,
      ]),
    )
    .digest('hex');
}

export function validVector(value: unknown, dimensions: number): asserts value is number[] {
  if (
    !Array.isArray(value) ||
    value.length !== dimensions ||
    value.some((item) => typeof item !== 'number' || !Number.isFinite(item)) ||
    !value.some((item) => item !== 0)
  )
    throw new ModelCallError('invalid_output', '向量维度、数值或范数不正确');
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  validVector(a, b.length);
  validVector(b, a.length);
  return (
    a.reduce((sum, value, i) => sum + value * b[i]!, 0) /
    Math.sqrt(
      a.reduce((sum, value) => sum + value * value, 0) *
        b.reduce((sum, value) => sum + value * value, 0),
    )
  );
}
