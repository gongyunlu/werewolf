import type { AppEnv } from '../config/env';
import { openaiModelPort } from './openai-model-port';
import { resolveModelCapability } from './model-capability';
import type { ModelAccess, ModelPort } from './model-port';
import { retryingModelPort } from './retrying-model-port';
import type { PromptSource } from './prompt-template';
import { langfusePromptSource } from './langfuse-prompt-source';

/**
 * 按环境变量拼出提示词源。
 * 凭据没配齐就给一份取不到的源：冻结那一步会整局落到本地模板上，
 * 这是不起平台的正常跑法，不该拦着不让开局。
 */
export function promptSourceOf(env: AppEnv): PromptSource {
  const { LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY } = env;
  if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) {
    return {
      load: () => Promise.reject(new Error('没配 LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY')),
    };
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
  if (!MODEL_API_KEY) throw new Error('MODEL_API_KEY 缺失');

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
