import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Logger } from '@nestjs/common';
import {
  assertDataset,
  sampleCorpus,
  type ReferenceDataset,
} from '../evaluation/reference-dataset';
import { referenceMetrics, type ReferenceTrialResult } from '../evaluation/reference-experiment';
import { referenceSummary } from '../evaluation/reference-summary';
import { parseRerankResponse } from '../experience/reranking';
import { selectReferences } from '../experience/retrieval-ranking';
import type { StoredExperienceRetrieval } from '../store/actions';

async function main() {
  const { values } = parseArgs({
    options: {
      dataset: { type: 'string' },
      results: { type: 'string' },
      output: { type: 'string' },
    },
  });
  if (!values.dataset || !values.results || !values.output)
    throw new Error(
      '用法：references:calibrate --dataset <已标注数据集> --results <开发集结果目录> --output <报告.json>',
    );
  const dataset: ReferenceDataset = JSON.parse(await readFile(values.dataset, 'utf8'));
  assertDataset(dataset, true);
  const conditions = JSON.parse(
    await readFile(resolve(values.results, 'conditions.json'), 'utf8'),
  ) as { datasetHash: string; split: string };
  if (conditions.datasetHash !== dataset.hash || conditions.split !== 'development')
    throw new Error('结果目录必须来自这份冻结数据集的开发集');
  const files = (await readdir(values.results)).filter((name) => /^hybrid-\d+\.json$/.test(name));
  if (!files.length) throw new Error('没有 hybrid 结果');
  const results: ReferenceTrialResult[] = await Promise.all(
    files.map(async (name) => JSON.parse(await readFile(resolve(values.results!, name), 'utf8'))),
  );
  const development = dataset.samples.filter((sample) => sample.split === 'development');
  if (
    results.length !== development.length ||
    new Set(results.map((row) => row.sampleId)).size !== development.length
  )
    throw new Error('必须使用完整开发集结果，不能挑选少数样本调参');
  for (const result of results) {
    const sample = development.find((row) => row.id === result.sampleId);
    if (
      !sample ||
      result.variant !== 'hybrid' ||
      result.corpusHash !== sampleCorpus(dataset, sample).hash
    )
      throw new Error('只能用同一冻结语料的开发集调参，不能混入测试集');
  }
  const thresholds = [2, 3].map((threshold) => {
    const rescored = results.map((result) => {
      const sample = development.find((row) => row.id === result.sampleId)!;
      const retrieval = result.retrieval as StoredExperienceRetrieval;
      if (retrieval.status !== 'completed') throw new Error('重排未完成，不能用于阈值对照');
      const candidates = retrieval.frozenCandidates ?? [];
      const judgments = candidates.length
        ? parseRerankResponse(retrieval.reranking!.attempts.at(-1)!.response!, candidates)
        : [];
      const selected = selectReferences(candidates, judgments, threshold)
        .decisions.filter((decision) => decision.selected)
        .map((decision) => decision.key);
      const { assessment: _assessment, outcome: _outcome, ...retrievalResult } = result;
      return {
        ...retrievalResult,
        selected,
        metrics: referenceMetrics(sample.labels!, result.candidates, selected),
      };
    });
    return { threshold, groups: referenceSummary(rescored, dataset) };
  });
  const path = resolve(values.output);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify(
      {
        datasetHash: dataset.hash,
        thresholds,
        note: '复用冻结重排答复，模型调用0次。阈值仅改变选材；不能据此推断完整行动或胜率。选定阈值后再运行整局隔离的测试集。',
      },
      null,
      2,
    ),
    'utf8',
  );
  Logger.log(`开发集阈值对照已保存：${path}`);
}

void main().catch((error: unknown) => {
  Logger.error(error instanceof Error ? error.message : '阈值对照失败');
  process.exitCode = 1;
});
