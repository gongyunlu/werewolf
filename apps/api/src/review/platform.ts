import { setTimeout } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { loadEnv } from '../config/env';
import {
  analysisOf,
  REVIEW_VERSION,
  reviewId,
  unitInput,
  type ReviewAnalysis,
  type ReviewUnit,
} from './contracts';

export interface ReviewProfile {
  evaluatorId: string;
  evaluatorVersion: number;
  ruleId: string;
  fingerprint: string;
}
export interface PlatformGeneration {
  id: string;
  model: string | null;
  level: string;
  startTime: string;
  endTime: string | null;
  usageDetails: Record<string, number>;
  costDetails: Record<string, number>;
  metadata: { attributes?: Record<string, unknown> };
}
interface PlatformTrace {
  observations: (PlatformGeneration & { type: string; input?: unknown })[];
}
export interface ReviewPlatform {
  profile(): Promise<ReviewProfile>;
  exists(unit: ReviewUnit): Promise<boolean>;
  submit(unit: ReviewUnit): Promise<void>;
  result(unit: ReviewUnit, profile: ReviewProfile): Promise<ReviewAnalysis | null>;
  wait(unit: ReviewUnit, profile: ReviewProfile): Promise<ReviewAnalysis>;
  generations(unit: ReviewUnit, profile: ReviewProfile): Promise<PlatformGeneration[]>;
}

interface Score {
  id: string;
  observationId: string;
  comment: string | null;
  executionTraceId: string | null;
  source: string;
  metadata: { job_configuration_id?: string } | null;
}
interface Evaluator {
  id: string;
  name: string;
  version: number;
  scope: string;
  prompt: string;
  outputDefinition: unknown;
  modelConfig: { provider: string; model: string } | null;
}
interface Rule {
  id: string;
  name: string;
  status: string;
  target: string;
  sampling: number;
  filter: unknown;
  mapping: unknown;
  evaluator: { id: string };
}

const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });

/** 当前部署的 4.15 管理接口；不回退到其他 API 或本地模型。 */
export class LangfuseReviewPlatform implements ReviewPlatform {
  constructor(private readonly config: { baseUrl: string; publicKey: string; secretKey: string }) {}

  async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    if (!this.config.publicKey || !this.config.secretKey)
      throw new Error('未配置 Langfuse 复盘接入');
    const options: RequestInit = {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.publicKey}:${this.config.secretKey}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(150_000),
    };
    if (body !== undefined) options.body = JSON.stringify(body);
    const response = await fetch(new URL(path, this.config.baseUrl), options);
    if (!response.ok) throw new PlatformHttpError(response.status);
    return (await response.json()) as T;
  }

  async list<T>(path: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; ; page++) {
      const result = await this.request<{ data: T[]; meta: { totalPages: number } }>(
        `${path}${path.includes('?') ? '&' : '?'}limit=100&page=${page}`,
      );
      if (!Number.isInteger(result.meta.totalPages)) throw new Error('Langfuse 分页响应不完整');
      all.push(...result.data);
      if (page >= result.meta.totalPages) return all;
    }
  }

  async profile(): Promise<ReviewProfile> {
    const health = await this.request<{ version: string }>('/api/public/health');
    if (health.version !== '4.15.0')
      throw new Error('复盘接入要求已验证的 Langfuse 4.15.0，请先核验新版本接口');
    const [evaluators, rules, connections] = await Promise.all([
      this.list<Evaluator>('/api/public/unstable/evaluators'),
      this.list<Rule>('/api/public/unstable/evaluation-rules'),
      this.list<{ provider: string; adapter: string; baseURL?: string; config?: unknown }>(
        '/api/public/llm-connections',
      ),
    ]);
    const evaluator = evaluators.find(
      (item) => item.name === REVIEW_VERSION && item.scope === 'project',
    );
    const rule = rules.find((item) => item.name === REVIEW_VERSION);
    const connection = connections.find(
      (item) => item.provider === evaluator?.modelConfig?.provider,
    );
    if (
      !evaluator ||
      !rule ||
      !connection ||
      rule.status !== 'active' ||
      rule.evaluator.id !== evaluator.id ||
      rule.target !== 'observation' ||
      rule.sampling !== 1 ||
      !isDeepStrictEqual(rule.filter, reviewFilter()) ||
      !isDeepStrictEqual(rule.mapping, [{ variable: 'input', source: 'input' }])
    ) {
      throw new Error('Langfuse 复盘评价器或规则未就绪，请先配置平台');
    }
    return {
      evaluatorId: evaluator.id,
      evaluatorVersion: evaluator.version,
      ruleId: rule.id,
      fingerprint: reviewId(
        JSON.stringify({
          evaluator: {
            id: evaluator.id,
            version: evaluator.version,
            prompt: evaluator.prompt,
            outputDefinition: evaluator.outputDefinition,
            modelConfig: evaluator.modelConfig,
          },
          rule: { id: rule.id, filter: rule.filter, mapping: rule.mapping },
          connection: {
            provider: connection.provider,
            adapter: connection.adapter,
            baseURL: connection.baseURL,
            config: connection.config,
          },
        }),
      ),
    };
  }

  private async trace(id: string): Promise<PlatformTrace | null> {
    try {
      return await this.request<PlatformTrace>(`/api/public/traces/${id}`);
    } catch (error) {
      if (error instanceof PlatformHttpError && error.status === 404) return null;
      throw error;
    }
  }

  async exists(unit: ReviewUnit): Promise<boolean> {
    const observation = (await this.trace(unit.traceId))?.observations.find(
      (item) => item.id === unit.spanId,
    );
    if (!observation) return false;
    const input =
      typeof observation.input === 'string' ? JSON.parse(observation.input) : observation.input;
    const submitted = JSON.parse(JSON.stringify(unitInput(unit)));
    if (!isDeepStrictEqual(input, submitted)) throw new Error('平台复盘输入与冻结证据不一致');
    return true;
  }

  async submit(unit: ReviewUnit): Promise<void> {
    const nanos = BigInt(Date.parse(unit.createdAt)) * 1_000_000n;
    await this.request('/api/public/otel/v1/traces', 'POST', {
      resourceSpans: [
        {
          resource: { attributes: [attribute('service.name', 'werewolf-review')] },
          scopeSpans: [
            {
              scope: { name: 'werewolf-review' },
              spans: [
                {
                  traceId: unit.traceId,
                  spanId: unit.spanId,
                  name: REVIEW_VERSION,
                  kind: 1,
                  startTimeUnixNano: String(nanos),
                  endTimeUnixNano: String(nanos + 1_000_000n),
                  attributes: [
                    attribute('langfuse.observation.type', 'span'),
                    attribute('langfuse.observation.input', JSON.stringify(unitInput(unit))),
                    attribute('langfuse.environment', 'werewolf-review'),
                  ],
                  status: { code: 1 },
                },
              ],
            },
          ],
        },
      ],
    });
  }

  async result(unit: ReviewUnit, profile: ReviewProfile): Promise<ReviewAnalysis | null> {
    const scores = await this.list<Score>(`/api/public/v2/scores?traceId=${unit.traceId}`);
    const score = scores.find(
      (item) =>
        item.observationId === unit.spanId &&
        item.source === 'EVAL' &&
        item.metadata?.job_configuration_id === profile.ruleId,
    );
    if (!score) return null;
    if (!score.comment || !score.executionTraceId)
      throw new Error('平台复盘结果缺少正文或执行来源');
    return analysisOf(unit, score.comment, score.id, score.executionTraceId);
  }

  async wait(unit: ReviewUnit, profile: ReviewProfile): Promise<ReviewAnalysis> {
    const deadline = Date.now() + 120_000;
    do {
      const result = await this.result(unit, profile);
      if (result) return result;
      const observations = (await this.executionTrace(unit, profile))?.observations ?? [];
      const latest = Math.max(
        ...observations.map((item) => Date.parse(item.endTime ?? item.startTime)),
      );
      // 生成成功后仍可能在外层解析失败；较早的失败不能覆盖后来开始的执行。
      if (
        observations.some(
          (item) => item.endTime && item.level === 'ERROR' && Date.parse(item.endTime) === latest,
        )
      )
        throw new Error('Langfuse 原生评价执行失败，请在平台核查后续跑');
      await setTimeout(2_000);
    } while (Date.now() < deadline);
    throw new Error('Langfuse 评价尚未返回；续跑会继续读取，不能重复投递');
  }

  async generations(unit: ReviewUnit, profile: ReviewProfile): Promise<PlatformGeneration[]> {
    return (
      (await this.executionTrace(unit, profile))?.observations.filter(
        (item) => item.type === 'GENERATION',
      ) ?? []
    );
  }

  private executionTrace(unit: ReviewUnit, profile: ReviewProfile): Promise<PlatformTrace | null> {
    // 4.15 的执行追踪标识由规则与目标生成，失败时也能定位，避免漏记失败调用。
    const jobId = reviewId(
      JSON.stringify(['observation-eval', profile.ruleId, unit.traceId, unit.spanId]),
    );
    return this.trace(reviewId(jobId));
  }
}

class PlatformHttpError extends Error {
  constructor(readonly status: number) {
    super(`Langfuse 请求失败（HTTP ${status}）`);
  }
}

export function reviewFilter() {
  return [{ type: 'stringOptions', column: 'name', operator: 'any of', value: [REVIEW_VERSION] }];
}

export function reviewPlatform(): LangfuseReviewPlatform {
  const env = loadEnv();
  return new LangfuseReviewPlatform({
    baseUrl: env.LANGFUSE_HOST,
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
  });
}
