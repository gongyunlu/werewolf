import { ApiErrorBodySchema } from '@werewolf/shared';
import axios from 'axios';
import type { ZodType } from 'zod';

/** 响应体与共享契约不符时使用 */
const SCHEMA_MISMATCH = 'RESPONSE_SCHEMA_MISMATCH';

/** 请求由调用方主动中止。 */
const CANCELED = 'CANCELED';

/**
 * 调用方只需面对这一种错误类型。status 缺失表示压根没拿到响应（网络中断、被取消等）。
 */
export class ApiError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(message: string, options: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'ApiError';
    this.status = options.status;
    this.code = options.code;
  }
}

/** 界面要显示的那一句话。经手的错误都已经过 toApiError，取 message 就够。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}

/** 主动取消不作为网络故障展示。 */
export function isCanceled(error: unknown): boolean {
  return error instanceof ApiError && error.code === CANCELED;
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }

  // 取消不是故障，单独给一个自己的码，调用方按码认，不必去猜 axios 那些常量
  if (axios.isCancel(error)) {
    return new ApiError(error instanceof Error ? error.message : '请求已取消', {
      code: CANCELED,
      cause: error,
    });
  }

  if (axios.isAxiosError(error)) {
    const parsed = ApiErrorBodySchema.safeParse(error.response?.data);
    const body = parsed.success ? parsed.data : undefined;

    return new ApiError(body?.message ?? error.message, {
      status: error.response?.status,
      code: body?.code ?? error.code,
      cause: error,
    });
  }

  return new ApiError(error instanceof Error ? error.message : '未知错误', { cause: error });
}

/** 按共享契约校验响应体。不符说明前后端已经脱节，宁可当场失败，也别让形状错的数据流进界面。 */
export function parseResponse<T>(schema: ZodType<T> | undefined, data: unknown): T {
  if (!schema) {
    return data as T;
  }

  const result = schema.safeParse(data);

  if (!result.success) {
    throw new ApiError('响应结构与约定不符', {
      code: SCHEMA_MISMATCH,
      cause: result.error,
    });
  }

  return result.data;
}
