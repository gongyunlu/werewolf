import { createHash } from 'node:crypto';
import type { EvidenceSource } from './evidence';

export const REVIEW_VERSION = 'langfuse-review-v1';
export const REVIEW_STEPS = ['review_decision', 'review_player', 'review_outcome'] as const;
export type ReviewStep = (typeof REVIEW_STEPS)[number];
export const reviewId = (value: string) =>
  createHash('sha256').update(value).digest('hex').slice(0, 32);

export interface ReviewUnit {
  key: string;
  step: ReviewStep;
  traceId: string;
  spanId: string;
  createdAt: string;
  sources: EvidenceSource[];
  task: unknown;
}

export interface ReviewAnalysis {
  text: string;
  references: { label: string; sourceId: string }[];
  scoreId: string;
  executionTraceId: string;
}

export function unitInput(unit: ReviewUnit) {
  const prefix = unit.step === 'review_player' ? 'D' : unit.step === 'review_outcome' ? 'O' : 'E';
  return {
    step: unit.step,
    task: unit.task,
    sources: unit.sources.map((source, index) => ({
      id: `${prefix}${index + 1}`,
      origin: source.origin,
      value: source.value,
    })),
  };
}

/** 正文使用短引用，读取时映射回冻结的业务证据。 */
export function analysisOf(
  unit: ReviewUnit,
  text: string,
  scoreId: string,
  executionTraceId: string,
): ReviewAnalysis {
  const citation = /\[(?:证据:([^\]]*)|([A-Z][^\]]*))\]/g;
  const labels = [...new Set([...text.matchAll(citation)].map((match) => match[1] ?? match[2]!))];
  const input = unitInput(unit);
  if (!text.trim() || labels.length === 0) throw new Error('平台复盘缺少正文或证据引用');
  const paragraphs = text
    .trim()
    .split(/\n\s*\n/)
    .filter((paragraph) => !/^#{1,6} [^\n]+$/.test(paragraph));
  if (paragraphs.some((paragraph) => [...paragraph.matchAll(citation)].length === 0))
    throw new Error('平台复盘段落缺少证据引用');
  const references = labels.map((label) => {
    const index = input.sources.findIndex((source) => source.id === label);
    if (index < 0) throw new Error('平台复盘引用超出本次证据范围');
    return { label, sourceId: unit.sources[index]!.id };
  });
  return { text, references, scoreId, executionTraceId };
}
