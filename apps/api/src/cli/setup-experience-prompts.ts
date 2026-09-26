import { LangfuseClient } from '@langfuse/client';
import { Logger } from '@nestjs/common';
import { loadEnv } from '../config/env';
import { loadEnvFiles } from '../config/env-files';
import { setupExperiencePrompts } from '../experience/setup-prompts';

/** 只初始化经验模板，不连接业务库、不运行队列或调用模型。 */
async function main() {
  loadEnvFiles();
  const env = loadEnv();
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) throw new Error('未配置 Langfuse');
  const client = new LangfuseClient({
    baseUrl: env.LANGFUSE_HOST,
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
  });
  const templates = await setupExperiencePrompts(client.api.prompts);
  Logger.log(
    JSON.stringify(templates.map(({ name, version, source }) => ({ name, version, source }))),
  );
}

void main().catch(() => {
  Logger.error('经验模板初始化失败，请检查 Langfuse 连接、模板类型及 production 标签');
  process.exitCode = 1;
});
