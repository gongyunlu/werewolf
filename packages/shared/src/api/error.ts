import { z } from 'zod';

/**
 * 接口失败的统一响应体。
 * 后端异常过滤器按这个形状产出，前端 ApiError 按这个形状解析——两侧共用一份定义。
 */
export const ApiErrorBodySchema = z.object({
  message: z.string(),
  code: z.string(),
});

export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;
