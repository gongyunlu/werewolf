import { FACTIONS, SEER_CHECK_RESULTS, type SeerCheckResult } from '@werewolf/shared';
import type { ActionProvider } from '../actions';
import { factionOf } from '../roles';
import { alivePlayers, type GameState, type PlayerState } from '../state';

/** 一次查验：查了谁、查到什么。 */
export interface SeerCheck {
  targetId: string;
  result: SeerCheckResult;
}

/**
 * 预言家今夜验谁：存活玩家去掉他自己和已验过的人，同一个人不能查两次，没得验就不验。
 *
 * 判据是底牌阵营 factionOf(role)，不是运行时的 PlayerState.faction——绑成情侣只改此刻阵营，
 * 底牌没变。查验结果这一夜不公开，预言家只能白天自己说出去。
 */
export async function decideSeerCheck(
  seer: PlayerState | null,
  state: GameState,
  actions: ActionProvider,
): Promise<SeerCheck | null> {
  if (seer === null) return null;

  const checked = new Set(seer.checkedIds);
  const candidates = alivePlayers(state).filter(
    (player) => player.id !== seer.id && !checked.has(player.id),
  );
  // 场上只剩他自己就没人可验，这一夜作罢。
  if (candidates.length === 0) return null;

  const targetId = await actions.seerCheck(
    seer.id,
    candidates.map((player) => player.id),
  );
  const target = candidates.find((player) => player.id === targetId);
  if (!target) throw new Error(`查验目标必须是没查过的其他存活玩家：${targetId}`);

  return { targetId, result: checkResultOf(target) };
}

/** 底牌属狼人阵营的一律回 werewolf，其余回 good；狼王、白狼王也不例外。 */
export function checkResultOf(target: PlayerState): SeerCheckResult {
  return factionOf(target.role) === FACTIONS.WEREWOLF
    ? SEER_CHECK_RESULTS.WEREWOLF
    : SEER_CHECK_RESULTS.GOOD;
}
