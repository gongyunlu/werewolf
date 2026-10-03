import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadEnvFiles } from '../config/env-files';
import { loadEnv } from '../config/env';
import { indexKnowledge, prepareKnowledgeIndex } from '../knowledge/indexing';
import { knowledgeEmbeddingKey, KNOWLEDGE_TEXT_VERSION } from '../knowledge/text';
import { embeddingRuntime } from '../llm/embedding';
import { startTelemetry, stopTelemetry } from '../llm/telemetry';
import { openPrismaClient, prismaStores } from '../store/prisma';

async function main() {
  const { values } = parseArgs({
    options: { run: { type: 'boolean', default: false }, output: { type: 'string' } },
  });
  loadEnvFiles();
  const env = loadEnv();
  const runtime = embeddingRuntime(env);
  const key = knowledgeEmbeddingKey(runtime);
  const client = openPrismaClient(env.DATABASE_URL);
  const stores = prismaStores(client);
  try {
    const candidates = (await stores.knowledge.list()).flatMap((item) => {
      const version = item.versions.find((entry) => entry.versionId === item.activeVersionId);
      return version && version.state.task?.key !== key ? [{ item, version }] : [];
    });
    const report = {
      createdAt: new Date().toISOString(),
      textVersion: KNOWLEDGE_TEXT_VERSION,
      model: runtime.access.model,
      targetKey: key,
      executed: values.run,
      items: candidates.map(({ item, version }) => ({
        id: item.id,
        title: version.content.title,
        versionId: version.versionId,
        version: version.version,
        originalKey: version.state.task?.key ?? null,
        status: 'pending',
        failure: null as string | null,
      })),
    };
    const output = resolve(
      values.output ??
        resolve(__dirname, '../../../../docs/knowledge-reindex', `${Date.now()}.json`),
    );
    await mkdir(dirname(output), { recursive: true });
    const save = () => writeFile(output, JSON.stringify(report, null, 2), 'utf8');
    await save();
    Logger.log(JSON.stringify(report, null, 2));
    if (!values.run) {
      Logger.log(
        `预览完成：${candidates.length} 条启用知识需要重建，模型调用 0 次。报告：${output}；加 --run 执行。`,
      );
      return;
    }
    startTelemetry(env);
    for (const [index, { item, version }] of candidates.entries()) {
      const progress = report.items[index]!;
      try {
        await stores.knowledge.activate(item.id, item.revision, null, '');
        progress.status = 'disabled';
        await save();
        await prepareKnowledgeIndex(stores, version, runtime);
        await indexKnowledge(stores, version.versionId, runtime);
        await stores.knowledge.activate(item.id, item.revision + 1, version.versionId, key);
        progress.status = 'enabled';
        await save();
        Logger.log(`已重建并启用：${version.content.title}（版本 ${version.version}）`);
      } catch (error) {
        progress.status = 'failed';
        progress.failure = error instanceof Error ? error.message : '索引升级失败';
        await save();
        throw new Error(
          `知识索引升级中断：${version.content.title}；已停用的条目保持停用，请按报告在知识库续跑：${output}`,
          { cause: error },
        );
      }
    }
    Logger.log(`索引升级完成，报告：${output}`);
  } finally {
    await Promise.all([client.$disconnect(), stopTelemetry()]);
  }
}

void main().catch((error: unknown) => {
  Logger.error(error instanceof Error ? error.message : '知识索引升级失败');
  process.exitCode = 1;
});
