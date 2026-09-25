import { createHash } from 'node:crypto';
import type { EvidenceGap, EvidenceSource } from './evidence';

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

/** 业务定位信息留在本地映射中，模型只需知道证据字段和事件序号。 */
export function evidenceInput(sources: EvidenceSource[], prefix: string) {
  return sources.map((source, index) => ({
    id: `${prefix}${index + 1}`,
    origin: 'seq' in source.origin ? { seq: source.origin.seq } : { path: source.origin.path },
    value: source.value,
  }));
}

export function unitInput(unit: ReviewUnit) {
  const prefix = unit.step === 'review_player' ? 'D' : unit.step === 'review_outcome' ? 'O' : 'E';
  const task = unit.task as {
    actionType?: string;
    actorId?: string;
    player?: unknown;
    gaps?: EvidenceGap[];
  };
  return {
    step: unit.step,
    task:
      unit.step === 'review_decision'
        ? { actionType: task.actionType, actorId: task.actorId }
        : {
            player: task.player,
            gaps: task.gaps?.map(({ actorId, reason }) => ({ actorId, reason })),
          },
    sources: evidenceInput(unit.sources, prefix),
  };
}

/** 校验引用可定位并映射回冻结证据；段落排版不能证明内容是否有依据。 */
export function analysisOf(
  unit: ReviewUnit,
  text: string,
  scoreId: string,
  executionTraceId: string,
): ReviewAnalysis {
  const citation = /\[(?:证据:([^\]]*)|([A-Z][^\]]*))\]/g;
  const explicit = [...text.matchAll(citation)].map((match) => match[1] ?? match[2]!);
  const bare = [...text.matchAll(/\b([EDO]\d+(?:-[EDO]\d+)?)\b/g)].map((match) => match[1]!);
  const prefix = unit.step === 'review_player' ? 'D' : unit.step === 'review_outcome' ? 'O' : 'E';
  const sources = new Map(
    unit.sources.map((source, index) => [`${prefix}${index + 1}`, source.id]),
  );
  if (unit.step === 'review_player') {
    unit.sources.forEach((source, index) => {
      const value = source.value as { evidence?: { id: string }[] } | null;
      for (const evidence of value?.evidence ?? [])
        sources.set(`D${index + 1}-${evidence.id}`, source.id);
    });
  }
  const expand = (label: string) => {
    const range = label.match(/^([EDO])([1-9]\d*)-\1([1-9]\d*)$/);
    if (!range) return [label];
    const start = Number(range[2]);
    const end = Number(range[3]);
    if (range[1] !== prefix || start > end || end > unit.sources.length)
      throw new Error('平台复盘引用超出本次证据范围');
    return Array.from({ length: end - start + 1 }, (_, index) => `${prefix}${start + index}`);
  };
  // 嵌套引用定位到所属决定，范围引用逐项校验；原正文和既有显式映射不变。
  const labels = [...new Set((explicit.length ? explicit : bare).flatMap(expand))];
  if (!text.trim() || labels.length === 0) throw new Error('平台复盘缺少正文或证据引用');
  for (const label of [...explicit, ...bare].flatMap(expand)) {
    if (!sources.has(label)) throw new Error('平台复盘引用超出本次证据范围');
  }
  const references = labels.map((label) => ({ label, sourceId: sources.get(label)! }));
  return { text, references, scoreId, executionTraceId };
}
