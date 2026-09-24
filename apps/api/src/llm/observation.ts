/** 一次实际节点执行的身份；格式重问沿用它，恢复重跑重新生成。 */
export interface CallIdentity {
  callId: string;
  executionId: string;
  step: string;
  formatAttempt: number;
  taskId?: string;
  checkpointId?: string;
}

export interface CallCompletion {
  status: 'accepted' | 'invalid_output' | 'failed' | 'cancelled';
  failureCode: string | null;
  durationMs: number;
}

/** 只保存用量对象，不包含请求正文或供应商错误正文。 */
export interface RequestMetrics {
  dispatched: boolean;
  durationMs: number;
  httpStatus: number | null;
  requestId: string | null;
  usage: Record<string, unknown> | null;
  usageComplete: boolean;
  thinkingMs: number | null;
}

export interface AttemptCompletion extends RequestMetrics {
  traceId?: string;
  spanId?: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  failureCode: string | null;
}

/** 本地写入失败直接抛出，不参与模型重试。 */
export interface CallRecording {
  finish(result: CallCompletion): Promise<void>;
  startAttempt(attemptNo: number): Promise<void>;
  finishAttempt(attemptNo: number, result: AttemptCompletion): Promise<void>;
}

export interface TokenUsage {
  input: number | null;
  output: number | null;
  total: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function detail(value: unknown, key: string): number | null {
  return value !== null && typeof value === 'object'
    ? count((value as Record<string, unknown>)[key])
    : null;
}

/** 缓存与推理是细分值，不与输入、输出相加；未报告的 total 也不自行推算。 */
export function tokenUsage(raw: Record<string, unknown> | null): TokenUsage {
  return {
    input: count(raw?.prompt_tokens),
    output: count(raw?.completion_tokens),
    total: count(raw?.total_tokens),
    cacheRead:
      detail(raw?.prompt_tokens_details, 'cached_tokens') ?? count(raw?.prompt_cache_hit_tokens),
    cacheWrite: detail(raw?.prompt_tokens_details, 'cache_creation_tokens'),
    reasoning: detail(raw?.completion_tokens_details, 'reasoning_tokens'),
  };
}

export function usageObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function usageIssues(raw: Record<string, unknown> | null): string[] {
  if (!raw) return [];
  const issues: string[] = [];
  const check = (object: Record<string, unknown>, key: string, path = key) => {
    if (object[key] != null && count(object[key]) === null) issues.push(`${path}:invalid`);
  };
  for (const key of [
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
    'prompt_cache_hit_tokens',
    'prompt_cache_miss_tokens',
  ])
    check(raw, key);
  for (const [key, fields] of Object.entries({
    prompt_tokens_details: ['cached_tokens', 'cache_creation_tokens'],
    completion_tokens_details: ['reasoning_tokens'],
  })) {
    if (raw[key] == null) continue;
    const nested = usageObject(raw[key]);
    if (!nested) issues.push(`${key}:invalid`);
    else for (const field of fields) check(nested, field, `${key}.${field}`);
  }
  const standard = detail(raw.prompt_tokens_details, 'cached_tokens');
  const provider = count(raw.prompt_cache_hit_tokens);
  if (standard !== null && provider !== null && standard !== provider)
    issues.push('cacheRead:conflict');
  return issues;
}
