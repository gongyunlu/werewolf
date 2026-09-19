import type { ActionProvider, BadgeDecision } from '../actions';
import type { GameState } from '../state';

/**
 * 警长出局时处理警徽：移交给一名存活玩家，或撕掉。排在遗言之前。
 *
 * 凡是能让警长出局的路径，都在死后技能结算完的那一刻收尾，不往后拖——候选名单是调用那一刻
 * 现算的存活者，拖过一晚就少掉夜里死的那批人，早一步又要多算上还没被技能带走的人。三个入口：
 *   1. 天亮：runDay 里，管今晨的死者与天亮技能连锁带走的人；
 *   2. 放逐：loop.settleExile，被放逐者本人与他技能连锁带走的人；
 *   3. 自爆：day/self-destruct.runBlastWindow，白狼王带走的人跟他同一批落地。
 * 对局在放逐那一刻就终结的不在此列：警徽给谁都不影响胜负，不值得为它多问一次。这条只管放逐——
 * 判胜负的地方在 loop，才排得出「先判后结」；自爆的收尾埋在 runDay 里，看不见胜负，终局后照问。
 * 新加一条死法时回来把这份清单对一遍。
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
