import type { AppEnv } from '../config/env';
import { openaiModelPort } from './openai-model-port';
import { resolveModelCapability } from './model-capability';
import type { ModelAccess, ModelPort } from './model-port';
import { retryingModelPort } from './retrying-model-port';
import type { PromptSource } from './prompt-template';
import { langfusePromptSource } from './langfuse-prompt-source';
import { LOCAL_TURN_PROMPTS } from '../turn/prompt';

/** 未配置 Langfuse 时直接使用本地提示词。 */
export function promptSourceOf(env: AppEnv): PromptSource {
  const { LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY } = env;
  if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) {
    return LOCAL_TURN_PROMPTS;
  }

  return langfusePromptSource({
    baseUrl: LANGFUSE_HOST,
    publicKey: LANGFUSE_PUBLIC_KEY,
    secretKey: LANGFUSE_SECRET_KEY,
  });
}

/** 按环境变量拼出模型端口与接入身份。 */
export function modelRuntimeOf(env: AppEnv): { port: ModelPort; access: ModelAccess } {
  const { MODEL_API_KEY, MODEL_BASE_URL, MODEL_DEFAULT_MODEL } = env;
  // 密钥在这儿拦，不在环境变量契约里拦：不起模型也要能起服务、也能跑测试。
  if (!MODEL_API_KEY) throw new Error('没配 MODEL_API_KEY');

  return {
    port: retryingModelPort(openaiModelPort({ timeoutMs: env.MODEL_REQUEST_TIMEOUT_MS }), {
      attempts: env.MODEL_MAX_ATTEMPTS,
    }),
    access: {
      baseUrl: MODEL_BASE_URL,
      model: MODEL_DEFAULT_MODEL,
      apiKey: MODEL_API_KEY,
      capability: resolveModelCapability(
        MODEL_DEFAULT_MODEL,
        MODEL_BASE_URL,
        env.MODEL_CAPABILITIES,
      ),
    },
  };
}
