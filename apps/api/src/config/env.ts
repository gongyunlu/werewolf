import { z } from 'zod';

/** 应用级环境变量契约。加变量时同步更新 .env.example，别留只在代码里存在的隐式配置。 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // 后端服务监听端口
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),

  // 对局库。没有默认值：连哪个库是「这一局存哪儿」，不是「服务怎么起」，在这儿再写一份等于把选型藏回代码里。
  DATABASE_URL: z.string().min(1),

  // 队列与事件推送。默认值对着 docker-compose 起在本机的那一个，端口为 6379。
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),

  // 管理写接口的令牌。空着等于把写接口全关上——守卫一律拒，不是放行。
  ADMIN_TOKEN: z.string().default(''),
  // agent 自带密钥的加密主密钥，64 位十六进制。空着不影响读，只在存自带密钥时拦。
  AGENT_SECRET_KEY: z.string().default(''),

  // 提示词平台。三个都空着就整局走本地模板，这是正常的跑法，不起服务也跑得动。
  LANGFUSE_HOST: z.string().default('http://localhost:3100'),
  LANGFUSE_PUBLIC_KEY: z.string().default(''),
  LANGFUSE_SECRET_KEY: z.string().default(''),

  // 模型接入。密钥空着服务照样起得来，真开局时才会拦。
  MODEL_API_KEY: z.string().default(''),
  // 向量化独立选型；端点和密钥留空时沿用应用的默认模型接入。
  EMBEDDING_MODEL: z.string().default(''),
  EMBEDDING_BASE_URL: z.string().default(''),
  EMBEDDING_API_KEY: z.string().default(''),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(2048),
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
