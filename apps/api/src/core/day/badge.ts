import type { ActionProvider, BadgeDecision } from '../actions';
import type { GameState } from '../state';

/**
 * 警长出局时处理警徽：移交给一名存活玩家，或撕掉。
 *
 * 两个调用点：公布死讯后（警长是今晨的死者）与放逐执行后。时机都按裁决 5 定在
 * 遗言之前，也就是确认出局之后立刻处理。
 */
export async function handOverBadge(
  state: GameState,
  actions: ActionProvider,
  sheriffId: string,
): Promise<GameState> {
  // 警长本人已经出局，可移交的只有还活着的玩家。
  const candidates = state.players.filter((player) => player.isAlive).map((player) => player.id);

  const decision: BadgeDecision = await actions.decideBadge(sheriffId, candidates);
  if (decision.kind === 'tear') return { ...state, sheriffId: null };
  if (!candidates.includes(decision.toId)) {
    throw new Error(`警徽只能移交给存活玩家：${decision.toId}`);
  }

  return { ...state, sheriffId: decision.toId };
}

/**
 * 警长在今晨的死者里时处理警徽。
 *
 * 必须在白天发言与放逐之前调用：警徽留在出局者身上，当天的发言顺序会把他排进队列，
 * 放逐投票的加权也会落在一个不投票的人身上，1.5 票就静默消失了。
 */
export async function settleBadgeAfterDeaths(
  state: GameState,
  actions: ActionProvider,
): Promise<GameState> {
  const { sheriffId } = state;
  if (sheriffId === null) return state;

  const sheriff = state.players.find((player) => player.id === sheriffId);
  if (!sheriff) throw new Error(`警长不在局内：${sheriffId}`);

  return sheriff.isAlive ? state : handOverBadge(state, actions, sheriffId);
}
