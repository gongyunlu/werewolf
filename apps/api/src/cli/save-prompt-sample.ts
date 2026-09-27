import 'reflect-metadata';
import { LangfuseClient } from '@langfuse/client';
import { Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadEnv } from '../config/env';
import { loadEnvFiles } from '../config/env-files';
import { SampleFeedbackSchema, savePromptSample } from '../llm/prompt-sample';
import { openPrismaClient } from '../store/prisma';
import { loadPromptAction } from './prompt-action';

async function main() {
  const { values } = parseArgs({
    options: {
      game: { type: 'string' },
      action: { type: 'string' },
      category: { type: 'string' },
      'note-file': { type: 'string' },
      dataset: { type: 'string', default: 'werewolf/action-samples' },
    },
  });
  if (!values.game || !values.action || !values['note-file'])
    throw new Error(
      '用法：prompt:sample --game <对局id> --action <行动键> --category <rule|perspective|fact|display|strategy|reference> --note-file <UTF-8说明文件> [--dataset <集合名>]',
    );
  const feedback = SampleFeedbackSchema.parse({
    category: values.category,
    note: await readFile(values['note-file'], 'utf8'),
  });
  loadEnvFiles();
  const env = loadEnv();
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY)
    throw new Error('保存样本需要配置 Langfuse');
  const db = openPrismaClient(env.DATABASE_URL);
  try {
    const original = await loadPromptAction(db, values.game, values.action);
    const client = new LangfuseClient({
      baseUrl: env.LANGFUSE_HOST,
      publicKey: env.LANGFUSE_PUBLIC_KEY,
      secretKey: env.LANGFUSE_SECRET_KEY,
    });
    const item = await savePromptSample({
      client,
      datasetName: values.dataset!,
      ...original,
      feedback,
    });
    Logger.log(
      JSON.stringify({ datasetName: item.datasetName, itemId: item.id, source: original.source }),
    );
    Logger.log('样本已保存，可在 Langfuse 数据集查看；模型调用 0 次。');
  } finally {
    await db.$disconnect();
  }
}

void main().catch((error: unknown) => {
  Logger.error(error instanceof Error ? error.message : '保存样本失败');
  process.exitCode = 1;
});
