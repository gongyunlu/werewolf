import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

/**
 * 请求体按契约解析，不合就当场 400。
 * zod 抛的不是 HttpException，不在这儿接住，过滤器会把它当内部错误报成 500，错在谁身上就说不清了。
 */
export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestException(parsed.error.issues.map((issue) => issue.message).join('；'));
  }

  return parsed.data;
}
