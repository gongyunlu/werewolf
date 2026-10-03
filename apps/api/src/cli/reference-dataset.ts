import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadEnv } from '../config/env';
import { loadEnvFiles } from '../config/env-files';
import { assertCorpus, exportReferenceCorpus } from '../evaluation/reference-corpus';
import {
  assertDataset,
  exportReferenceDataset,
  sealDataset,
  type ReferenceDataset,
} from '../evaluation/reference-dataset';
import { promptSourceOf } from '../llm/from-env';
import { openPrismaClient } from '../store/prisma';

const annotationsSchema = z.array(
  z.object({
    id: z.string(),
    labels: z.record(
      z.string(),
      z.object({
        relevance: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
        applicable: z.boolean(),
        note: z.string().trim().min(1),
      }),
    ),
    annotation: z.object({
      author: z.string().trim().min(1),
      basis: z.enum(['human', 'agent-reviewed']),
      note: z.string().trim().min(1),
    }),
  }),
);

async function main() {
  const { values } = parseArgs({
    options: {
      games: { type: 'string' },
      'test-games': { type: 'string' },
      limit: { type: 'string', default: '60' },
      corpus: { type: 'string' },
      output: { type: 'string' },
      dataset: { type: 'string' },
      annotations: { type: 'string' },
      temporal: { type: 'string', default: 'frozen-retrospective' },
    },
  });
  if (!values.output)
    throw new Error(
      '必须指定 --output <数据集.json>；导出用 --games <局ID,局ID> --test-games <留出局ID>，合并标注用 --dataset <原数据集> --annotations <标注.json>',
    );
  let dataset: ReferenceDataset;
  if (values.dataset) {
    dataset = JSON.parse(await readFile(values.dataset, 'utf8'));
    assertDataset(dataset);
    if (!values.annotations) throw new Error('合并标注需要 --annotations');
    const annotations = annotationsSchema.parse(
      JSON.parse(await readFile(values.annotations, 'utf8')),
    );
    const byId = new Map(annotations.map((row) => [row.id, row]));
    if (
      byId.size !== annotations.length ||
      byId.size !== dataset.samples.length ||
      dataset.samples.some((sample) => !byId.has(sample.id))
    )
      throw new Error('标注必须逐一覆盖全部行动且不能重复');
    const { hash: _hash, ...body } = dataset;
    dataset = sealDataset({
      ...body,
      samples: dataset.samples.map((sample) => ({ ...sample, ...byId.get(sample.id)! })),
    });
    assertDataset(dataset, true);
  } else {
    if (!values.games || !values['test-games'])
      throw new Error('导出需要 --games 与 --test-games，按整局留出');
    const temporalPolicy = z.enum(['at-action', 'frozen-retrospective']).parse(values.temporal);
    loadEnvFiles();
    const env = loadEnv();
    const db = openPrismaClient(env.DATABASE_URL);
    try {
      const corpus = values.corpus
        ? assertCorpus(JSON.parse(await readFile(values.corpus, 'utf8')))
        : await exportReferenceCorpus(db);
      dataset = await exportReferenceDataset({
        db,
        corpus,
        gameIds: values.games.split(','),
        testGameIds: values['test-games'].split(','),
        limit: Number(values.limit),
        promptSource: promptSourceOf(env),
        temporalPolicy,
      });
    } finally {
      await db.$disconnect();
    }
  }
  const path = resolve(values.output);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(dataset, null, 2), 'utf8');
  Logger.log(
    `已保存 ${dataset.samples.length} 条行动；语料时间策略 ${dataset.temporalPolicy}；指纹 ${dataset.hash}；${path}`,
  );
}

void main().catch((error: unknown) => {
  Logger.error(error instanceof Error ? error.message : '数据集处理失败');
  process.exitCode = 1;
});
