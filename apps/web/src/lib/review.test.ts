import { describe, expect, it } from 'vitest';
import { reviewReport } from '@/test/review-fixture';
import { citationLabels, decisionTitle, resolveCitation } from './review';

describe('复盘证据定位', () => {
  it('同名 E 编号只在所属决策中解析，显式 sourceId 优先于数组下标', () => {
    const report = reviewReport();
    const original = report.units[0];
    const other = {
      ...original,
      key: 'decision/other',
      sources: [{ id: 'other-source', origin: { path: 'reasoning' }, value: '另一位玩家的理由' }],
      result: { text: '[E2]', references: [{ label: 'E2', sourceId: 'other-source' }] },
    };
    report.units.push(other);
    expect(resolveCitation(report, original, 'E2')?.source.value).toBe('这是当时记录的原始理由。');
    expect(resolveCitation(report, other, 'E2')?.source.value).toBe('另一位玩家的理由');
    expect(resolveCitation(report, original, 'O1')).toBeNull();
    expect(resolveCitation(report, original, 'E99')).toBeNull();
  });

  it('玩家嵌套引用定位对应行动的原始证据，历史 D 引用仍可逐层查看', () => {
    const report = reviewReport();
    const player = report.units[1];
    expect(resolveCitation(report, player, 'D1')?.decision).toBe(report.units[0]);
    expect(resolveCitation(report, player, 'D1-E2')?.source.value).toBe('这是当时记录的原始理由。');
    expect(resolveCitation(report, player, 'D1-E99')).toBeNull();
  });

  it('范围引用逐项展开，越界或倒序不创建错误定位', () => {
    const unit = reviewReport().units[0];
    expect(citationLabels(unit, 'E1-E2')).toEqual(['E1', 'E2']);
    expect(citationLabels(unit, 'E2-E1')).toEqual([]);
    expect(citationLabels(unit, 'E1-E99')).toEqual([]);
  });

  it('天数使用冻结 context/day，不把内部节点编号解释成天数', () => {
    const target = reviewReport().evidence.targets[0];
    target.actionKey = '["node/8/day"]';
    expect(decisionTitle(target)).toBe('第 1 天 · 投票');
  });
});
