import type { ReviewReport, ReviewSource, ReviewTarget, ReviewUnit } from '@werewolf/shared';
import { actionTypeName } from './labels';

export const REVIEW_STATUS_NAMES: Record<string, string> = {
  not_started: '尚未生成',
  waiting: '排队中',
  prioritized: '排队中',
  delayed: '等待重试',
  'waiting-children': '等待前置任务',
  paused: '队列已暂停',
  active: '生成中',
  completed: '已完成',
  failed: '生成失败',
  interrupted: '已中断',
  unknown: '任务状态未知',
};

export function decisionTitle(target: ReviewTarget) {
  const day = target.sources.find(
    (source) => 'path' in source.origin && source.origin.path === 'context/day',
  )?.value;
  return `${typeof day === 'number' ? `第 ${day} 天 · ` : ''}${actionTypeName(target.actionType)}`;
}

export function sourceTitle(source: ReviewSource) {
  if ('seq' in source.origin) return `事件 #${source.origin.seq}`;
  const path = source.origin.path;
  const names: Record<string, string> = {
    'context/task': '当时任务',
    'context/actor': '行动者身份',
    'context/day': '对局天数',
    decision: '最终提交的决定',
    reasoning: '当时记录的理由',
    schema: '合法行动格式',
    review: '对应决策分析',
    'game/winner': '最终胜方',
    'game/finalState': '终局状态',
    boardRules: '本局规则',
  };
  if (path.startsWith('context/visible/')) return '当时可见信息';
  if (path.startsWith('context/options/')) return '当时合法选项';
  if (path.startsWith('context/skill/')) return '当时规则与行动指引';
  return names[path] ?? path;
}

/** 编号只在所属分析内有效，不能跨玩家或跨决定查找同名引用。 */
export function citationLabels(unit: ReviewUnit, label: string): string[] {
  const range = label.match(/^([EDO])([1-9]\d*)-\1([1-9]\d*)$/);
  if (!range) return [label];
  const start = Number(range[2]);
  const end = Number(range[3]);
  if (start > end || end > unit.sources.length) return [];
  return Array.from({ length: end - start + 1 }, (_, index) => `${range[1]}${start + index}`);
}

export function resolveCitation(report: ReviewReport, unit: ReviewUnit, label: string) {
  const prefix = unit.step === 'review_player' ? 'D' : unit.step === 'review_outcome' ? 'O' : 'E';
  const parsed = label.match(/^([EDO])([1-9]\d*)(?:-(E[1-9]\d*))?$/);
  if (!parsed || parsed[1] !== prefix || (parsed[3] && prefix !== 'D')) return null;
  const reference = unit.result?.references.find((item) => item.label === label);
  const source = reference
    ? unit.sources.find((item) => item.id === reference.sourceId)
    : unit.sources[Number(parsed[2]) - 1];
  if (!source) return null;
  const actionKey = 'actionKey' in source.origin ? source.origin.actionKey : null;
  const decision = report.units.find((item) => item.key === `decision/${actionKey}`);
  if (parsed[3]) {
    const nested = decision?.sources[Number(parsed[3].slice(1)) - 1];
    return nested ? { source: nested, decision: null } : null;
  }
  return { source, decision: prefix === 'D' ? (decision ?? null) : null };
}
