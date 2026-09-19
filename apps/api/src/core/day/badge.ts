import type { ActionProvider, BadgeDecision } from '../actions';
import type { GameState } from '../state';

/**
 * 警长出局时处理警徽：移交给一名存活玩家，或撕掉。
 * 两个调用点：公布死讯后（警长是今晨的死者）和放逐执行后；
 * 都在确认出局后立刻处理，排在遗言之前（裁决 5）。
 */
export async function handOverBadge(
  state: GameState,
  actions: ActionProvider,
  sheriffId: string,
): Promise<GameState> {
  const candidates = state.players.filter((player) => player.isAlive).map((player) => player.id);

  const decision: BadgeDecision = await actions.decideBadge(sheriffId, candidates);
  if (decision.kind === 'tear') return { ...state, sheriffId: null };
  if (!candidates.includes(decision.toId)) {
    throw new Error(`警徽只能移交给存活玩家：${decision.toId}`);
  }

  return { ...state, sheriffId: decision.toId };
}

/**
 * 警长在今晨的死者里时处理警徽，必须在发言和放逐之前调用：
 * 否则发言顺序会把出局的他排进去，1.5 票的加权也落在一个不投票的人身上。
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
