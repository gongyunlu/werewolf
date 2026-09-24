import type { GameState } from './state';

/** 法官播报与技能结果；同一阶段内的 key 固定，恢复时不会重复发布。 */
export interface FlowEvent {
  key: string;
  text: string;
  /** 不指定时全员可见，技能结果只交给对应玩家。 */
  audience?: readonly string[];
  kind?: 'sheriff';
  /** 天亮竞选与死讯公布使用独立节点，但展示都属于白天。 */
  phase?: 'night' | 'day';
}

export type FlowObserver = (state: GameState, event: FlowEvent) => Promise<void>;

export function seatNames(state: GameState, ids: readonly string[]): string {
  return ids
    .map((id) => `${state.players.find((player) => player.id === id)!.seatNo} 号`)
    .join('、');
}
