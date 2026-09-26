import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { loadEnvFiles } from '../config/env-files';
import { loadEnv } from '../config/env';
import { INITIAL_KNOWLEDGE } from '../knowledge/initial-content';
import { prepareKnowledgeIndex, indexKnowledge } from '../knowledge/indexing';
import { embeddingKey, embeddingRuntime } from '../llm/embedding';
import { startTelemetry, stopTelemetry } from '../llm/telemetry';
import { openPrismaClient, prismaStores } from '../store/prisma';

/** 精选条目只补缺失项；已有人工编辑和启停状态不被初始化覆盖。 */
async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--index-and-enable'))
    throw new Error('用法：knowledge:seed [--index-and-enable]');
  loadEnvFiles();
  const env = loadEnv();
  const client = openPrismaClient(env.DATABASE_URL);
  const stores = prismaStores(client);
  const indexing = args.includes('--index-and-enable');
  if (indexing) startTelemetry(env);
  try {
    for (const seed of INITIAL_KNOWLEDGE) {
      const existing = await stores.knowledge.find(seed.id);
      if (existing) {
        Logger.log(`已存在，保留：${seed.content.title}`);
        continue;
      }
      const item = await stores.knowledge.saveDraft(seed.id, 0, seed.content);
      const version = item.versions[0]!;
      if (indexing && seed.content.kind === 'strategy') {
        const runtime = embeddingRuntime({ ...env, MODEL_MAX_ATTEMPTS: 1 });
        await prepareKnowledgeIndex(stores, version, runtime);
        await indexKnowledge(stores, version.versionId, runtime);
        await stores.knowledge.activate(
          item.id,
          item.revision,
          version.versionId,
          embeddingKey(runtime),
        );
      }
      Logger.log(
        `${indexing && seed.content.kind === 'strategy' ? '已索引并启用' : '已保存待阅'}：${seed.content.title}`,
      );
    }
  } finally {
    await Promise.all([client.$disconnect(), stopTelemetry()]);
  }
}
void main().catch(() => {
  Logger.error('知识初始化中断；已保存条目可在知识库查看并继续索引。');
  process.exitCode = 1;
});
