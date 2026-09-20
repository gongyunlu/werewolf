import { z } from 'zod';

/** 应用级环境变量契约。加变量时同步更新 .env.example，别留只在代码里存在的隐式配置。 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // 后端服务监听端口
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3201),

  // 提示词平台。三个都空着就整局走本地模板，这是正常的跑法，不起服务也跑得动。
  LANGFUSE_HOST: z.string().default('http://localhost:3100'),
  LANGFUSE_PUBLIC_KEY: z.string().default(''),
  LANGFUSE_SECRET_KEY: z.string().default(''),

  // 模型接入。密钥空着服务照样起得来，真开局时才会拦。
  MODEL_API_KEY: z.string().default(''),
  // 下面这几项没有默认值：它们是「这一局是谁在答」，不是「服务怎么起」。
  // 在这儿再写一份默认，等于把选型藏回代码里——换型号要改 TS，漏配也不吭声。
  MODEL_BASE_URL: z.url(),
  MODEL_DEFAULT_MODEL: z.string().min(1),
  // 能力声明，JSON 数组，按「端点 + 型号」写。格式见 model-capability.ts。查不到就抛，不猜。
  MODEL_CAPABILITIES: z.string(),
  MODEL_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1).describe('模型调用超时毫秒数'),
  MODEL_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .min(1)
    .describe('模型调用失败时最多重试几次，含第一次'),
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    throw new Error(`环境变量校验失败：${result.error.message}`);
  }

  return result.data;
}
