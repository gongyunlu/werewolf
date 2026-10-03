import type { ReferenceDataset } from './reference-dataset';
import type { ReferenceTrialResult } from './reference-experiment';

/** 每项保留自己的有效分母；空检索不会被记成“零错误”。 */
export function referenceSummary(
  results: readonly ReferenceTrialResult[],
  dataset: ReferenceDataset,
) {
  const groups = new Map<string, ReferenceTrialResult[]>();
  for (const result of results) {
    const sample = dataset.samples.find((row) => row.id === result.sampleId)!;
    for (const key of [
      result.variant,
      `${result.variant}/${sample.boardId}/${sample.role}/${sample.actionType}`,
    ]) {
      const rows = groups.get(key) ?? [];
      rows.push(result);
      groups.set(key, rows);
    }
  }
  return [...groups].map(([group, rows]) => {
    const values = (pick: (row: ReferenceTrialResult) => number | null | undefined) => {
      const numbers = rows
        .map(pick)
        .filter((value): value is number => value !== null && value !== undefined);
      return {
        count: numbers.length,
        mean: numbers.length
          ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length
          : null,
      };
    };
    const durations = rows.map((row) => row.durationMs).toSorted((a, b) => a - b);
    return {
      group,
      samples: rows.length,
      recall: values((row) => row.metrics?.recall),
      selectionRecall: values((row) => row.metrics?.selectionRecall),
      precision: values((row) => row.metrics?.precision),
      ndcgAt5: values((row) => row.metrics?.ndcg),
      inapplicableRate: values((row) => row.metrics?.inapplicableRate),
      emptyCorrect: values((row) => row.metrics?.emptyCorrect),
      judgeRuleViolation: values((row) =>
        row.assessment ? Number(row.assessment.ruleViolation) : null,
      ),
      judgePerspectiveViolation: values((row) =>
        row.assessment ? Number(row.assessment.perspectiveViolation) : null,
      ),
      judgeHistoricalFactMisuse: values((row) =>
        row.assessment ? Number(row.assessment.historicalFactMisuse) : null,
      ),
      judgeStrategyQuality: values((row) => row.assessment?.strategyQuality),
      durationMs: {
        p50: durations[Math.ceil(durations.length * 0.5) - 1],
        p95: durations[Math.ceil(durations.length * 0.95) - 1],
      },
    };
  });
}
