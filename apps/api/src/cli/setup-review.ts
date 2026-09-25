import { loadEnvFiles } from '../config/env-files';
import { Logger } from '@nestjs/common';
import { REVIEW_VERSION } from '../review/contracts';
import { REVIEW_DEFINITION } from '../review/definition';
import { reviewFilter, reviewPlatform } from '../review/platform';

/** 只配置 Langfuse；不会启动应用、消费队列或连接业务库。创建与启用会触发平台预检调用。 */
async function main() {
  loadEnvFiles();
  const [provider, model] = process.argv.slice(2);
  if (!provider || !model) throw new Error('用法：review:setup <Langfuse 已有连接名称> <模型名称>');
  const platform = reviewPlatform();
  const evaluators = await platform.list<{
    id: string;
    name: string;
    scope: string;
    modelConfig: { provider: string; model: string };
  }>('/api/public/unstable/evaluators');
  const existing = evaluators.find(
    (item) => item.name === REVIEW_VERSION && item.scope === 'project',
  );
  if (
    existing &&
    (existing.modelConfig.provider !== provider || existing.modelConfig.model !== model)
  )
    throw new Error('同名评价器模型不同，请在平台核查；不会自动覆盖');
  if (!existing)
    await platform.request('/api/public/unstable/evaluators', 'POST', {
      ...REVIEW_DEFINITION,
      modelConfig: { provider, model },
    });
  const rules = await platform.list<{ name: string }>('/api/public/unstable/evaluation-rules');
  if (!rules.some((item) => item.name === REVIEW_VERSION))
    await platform.request('/api/public/unstable/evaluation-rules', 'POST', {
      name: REVIEW_VERSION,
      evaluator: { name: REVIEW_VERSION, scope: 'project', type: 'llm_as_judge' },
      target: 'observation',
      enabled: true,
      sampling: 1,
      filter: reviewFilter(),
      mapping: [{ variable: 'input', source: 'input' }],
    });
  Logger.log(JSON.stringify(await platform.profile()), 'Langfuse');
}

main().catch((error: unknown) => {
  Logger.error(error instanceof Error ? error.message : '平台配置失败', 'Langfuse');
  process.exitCode = 1;
});
