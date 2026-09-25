import type { ActionProvider } from '../actions';
import type { NightDeath } from '../day/announce';
import { alivePlayers, type GameState, type PlayerState } from '../state';

/**
 * 白狼王自爆带人。只有自爆这一条路：他被刀、被毒、被放逐、被枪打死都不带人。
 *
 * 传进来的局面是自爆已经落地之后的：他自己已经出局。
 * 「他是不是最后一狼」不在这儿判——自爆落地后调用方先判过胜负，狼队全灭就走不到这一步，
 * 见 day/self-destruct.ts。返回 null 为不带人。
 *
 * 候选名单照 alivePlayers 给，不剔除夜里已死、死讯还没公布的人——那是白狼王看得见的世界，
 * 提前摘掉等于把「这人昨晚没了」告诉他。选到这样的人这一枪空放：技能目标是实际存活的人，
 * 夜里结算完成时他就已经出局，公布与否不改变这件事。空放按不带人处理。
 */
export async function decideWhiteWolfTake(
  whiteWolf: PlayerState,
  state: GameState,
  actions: ActionProvider,
  nightDeaths: readonly NightDeath[],
): Promise<string | null> {
  const candidates = alivePlayers(state);
  const targetId = await actions.whiteWolfTake(
    whiteWolf.id,
    candidates.map((player) => player.id),
  );
  if (targetId === null) return null;
  if (!candidates.some((player) => player.id === targetId)) {
    throw new Error(`白狼王只能带走其他存活玩家：${targetId}`);
  }
  if (nightDeaths.some((death) => death.playerId === targetId)) return null;

  return targetId;
}
