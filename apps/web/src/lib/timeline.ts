import type { ActionSummary, GameEvent } from '@werewolf/shared';
import { actionTypeName, eventKindName } from './labels';

export interface TimelineRow {
  id: string;
  day: number;
  phase: string;
  activity: string;
  order: number;
  event: GameEvent | null;
  action: ActionSummary | null;
}

function activityOf(action: ActionSummary): string {
  if (['sheriff_candidacy', 'sheriff_withdraw', 'wolf_explode'].includes(action.actionType)) {
    return `${actionTypeName(action.actionType)} · 同时决策`;
  }
  if (action.actionType === 'speech') {
    if (action.phase === 'night') return action.task.match(/^狼队商议第 \d+ 轮/)?.[0] ?? '狼队商议';
    return action.task.includes('上警') ? '警长竞选发言' : '公开发言';
  }
  if (action.actionType === 'vote') return action.task.includes('警长') ? '警长投票' : '放逐投票';
  return actionTypeName(action.actionType);
}

/** 过程与它产生的事实合为一条；没有产生事实的判断按原台账位置保留。 */
export function timelineRows(events: GameEvent[], actions: ActionSummary[]): TimelineRow[] {
  const eventSeqs = new Set(events.map((event) => event.seq));
  const byEvent = new Map(
    actions.filter((action) => action.eventSeq !== null).map((action) => [action.eventSeq, action]),
  );
  // 摘要是后补的模型上下文，原始发言已完整展示，不重复插入动态。
  const rows: TimelineRow[] = events
    .filter((event) => event.kind !== 'public_summary' && event.kind !== 'wolf_summary')
    .map((event) => {
      const action = byEvent.get(event.seq) ?? null;
      return {
        id: `event-${event.seq}`,
        day: event.day,
        order: event.seq,
        event,
        action,
        phase: event.phase ?? action?.phase ?? (event.kind.startsWith('wolf_') ? 'night' : 'day'),
        activity: action ? activityOf(action) : eventKindName(event.kind),
      };
    });
  for (const action of actions) {
    if (action.eventSeq !== null && eventSeqs.has(action.eventSeq)) continue;
    rows.push({
      id: action.actionKey,
      day: action.day,
      phase: action.phase,
      activity: activityOf(action),
      order: action.ledgerSeq + 0.5,
      event: null,
      action,
    });
  }
  return rows.toSorted((a, b) => a.order - b.order);
}

export function phaseName(phase: string): string {
  return (
    (
      {
        night: '夜晚',
        day: '白天',
        deathSkills: '天亮结算',
        exileSkills: '放逐结算',
        vote: '投票',
      } as Record<string, string>
    )[phase] ?? '对局过程'
  );
}
