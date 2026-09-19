import { z } from 'zod';

/** 应用级环境变量契约。加变量时同步更新 .env.example，别留只在代码里存在的隐式配置。 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // 后端服务监听端口
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3201),
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    throw new Error(`环境变量校验失败：${result.error.message}`);
  }

  return result.data;
}
