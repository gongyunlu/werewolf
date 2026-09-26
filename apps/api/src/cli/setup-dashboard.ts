import { LangfuseClient } from '@langfuse/client';
import { Logger } from '@nestjs/common';
import { loadEnv } from '../config/env';
import { loadEnvFiles } from '../config/env-files';
import { setupDashboard } from '../llm/dashboard';

/** 只配置原生仪表盘，不启动队列或调用模型。 */
async function main() {
  loadEnvFiles();
  const env = loadEnv();
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) throw new Error('未配置 Langfuse');
  const client = new LangfuseClient({
    baseUrl: env.LANGFUSE_HOST,
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
  });
  const dashboard = await setupDashboard(client.api.unstable);
  Logger.log(
    JSON.stringify({
      id: dashboard.id,
      name: dashboard.name,
      widgets: dashboard.definition.widgets.length,
    }),
    'Langfuse',
  );
}

void main().catch(() => {
  Logger.error('Langfuse 仪表盘配置失败，请检查连接、接口版本或同名配置', 'Langfuse');
  process.exitCode = 1;
});
