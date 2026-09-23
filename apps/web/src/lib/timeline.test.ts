import type { ActionSummary, GameEvent } from '@werewolf/shared';
import { describe, expect, it } from 'vitest';
import { timelineRows } from './timeline';

const action = (fields: Partial<ActionSummary>): ActionSummary => ({
  actionKey: 'a1',
  actionType: 'seer_check',
  day: 1,
  seatNo: 3,
  role: '预言家',
  task: '查验',
  decision: 2,
  ledgerSeq: 4,
  hasReasoning: false,
  phase: 'night',
  eventSeq: null,
  ...fields,
});
const event = (seq: number, kind: string): GameEvent => ({
  seq,
  kind,
  day: 1,
  text: '记录',
  audience: [],
});

describe('观战时间线', () => {
  it('后补的模型上下文摘要不重复插入观战动态，也不把日期退回过去', () => {
    const rows = timelineRows(
      [
        event(1, 'public_speech'),
        { ...event(2, 'wolf_speech'), day: 3 },
        event(3, 'public_summary'),
        event(4, 'wolf_summary'),
        { ...event(5, 'wolf_speech'), day: 3 },
      ],
      [],
    );
    expect(rows.map((row) => [row.event?.seq, row.day])).toEqual([
      [1, 1],
      [2, 3],
      [5, 3],
    ]);
  });

  it('共用台账水位的夜晚和白天仍有各自的阶段，发言过程只挂在对应消息下', () => {
    const actions = [
      action({ actionKey: 'night' }),
      action({ actionKey: 'signup', actionType: 'sheriff_candidacy', phase: 'day', eventSeq: 5 }),
      action({
        actionKey: 'decline',
        actionType: 'sheriff_candidacy',
        phase: 'day',
        decision: false,
        ledgerSeq: 5,
      }),
      action({
        actionKey: 'explode',
        actionType: 'wolf_explode',
        phase: 'day',
        decision: false,
        ledgerSeq: 5,
      }),
      action({
        actionKey: 'speech',
        actionType: 'speech',
        task: '轮到你上警发言。',
        phase: 'day',
        ledgerSeq: 5,
        eventSeq: 6,
      }),
    ];
    const rows = timelineRows([event(5, 'sheriff'), event(6, 'public_speech')], actions);
    expect(rows.map((row) => [row.action?.actionKey, row.phase, row.event?.seq])).toEqual([
      ['night', 'night', undefined],
      ['signup', 'day', 5],
      ['decline', 'day', undefined],
      ['explode', 'day', undefined],
      ['speech', 'day', 6],
    ]);
    expect(rows.at(-1)?.activity).toBe('警长竞选发言');
    expect(rows.filter((row) => row.action?.actionKey === 'speech')).toHaveLength(1);
  });

  it('事实尚未推到时先显示行动，抵达后合并，夜晚第二轮不会挪到第一轮', () => {
    const actions = [
      action({
        actionKey: 'round1',
        actionType: 'speech',
        task: '狼队商议第 1 轮，轮到你说话。',
        ledgerSeq: 0,
        eventSeq: 1,
      }),
      action({
        actionKey: 'round2',
        actionType: 'speech',
        task: '狼队商议第 2 轮，轮到你说话。',
        ledgerSeq: 1,
        eventSeq: 2,
      }),
    ];
    expect(timelineRows([], actions).map((row) => row.activity)).toEqual([
      '狼队商议第 1 轮',
      '狼队商议第 2 轮',
    ]);
    const rows = timelineRows([event(1, 'wolf_speech'), event(2, 'wolf_speech')], actions);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.action && row.event)).toBe(true);
  });
});
