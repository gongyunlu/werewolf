import type { ActionProvider } from '../actions';
import { inWolfChannel } from '../roles';
import { alivePlayers, type GameState, type PlayerState } from '../state';

/**
 * 白狼王自爆带人。只有自爆这一条路：他被刀、被毒、被放逐、被枪打死都不带人。
 *
 * 他已经是最后一狼时不问——带走谁狼队都没了。他此刻还活着（自爆正在发生），
 * 判「最后一狼」得先把他的名字自己排掉。返回 null 为不带人。
 */
export async function decideWhiteWolfTake(
  whiteWolf: PlayerState,
  state: GameState,
  actions: ActionProvider,
): Promise<string | null> {
  const alive = alivePlayers(state);
  const packLeft = alive.some((player) => player.id !== whiteWolf.id && inWolfChannel(player.role));
  if (!packLeft) return null;

  const candidates = alive.filter((player) => player.id !== whiteWolf.id);
  const targetId = await actions.whiteWolfTake(
    whiteWolf.id,
    candidates.map((player) => player.id),
  );
  if (targetId === null) return null;
  if (!candidates.some((player) => player.id === targetId)) {
    throw new Error(`白狼王只能带走其他存活玩家：${targetId}`);
  }

  return targetId;
}
