import { DEATH_CAUSES, type DeathCause } from '@werewolf/shared';
import type { ActionProvider } from '../actions';
import { alivePlayers, type GameState, type PlayerState } from '../state';

/**
 * 狼王能带人的死因：被狼刀、被放逐、被猎人打死、被白狼王带走、同守同救。
 * 被毒、自爆出局，都带不了。
 *
 * 同守同救与猎人不同：猎人那一侧开不了枪（旧项目 spec 原文），这里能带。
 */
const TAKEABLE_CAUSES: readonly DeathCause[] = [
  DEATH_CAUSES.NIGHT_KILL,
  DEATH_CAUSES.EXECUTION,
  DEATH_CAUSES.HUNTER_SHOT,
  DEATH_CAUSES.WHITE_WOLF_TAKE,
  DEATH_CAUSES.DOUBLE_SAVE,
];

export function wolfKingCanTake(cause: DeathCause): boolean {
  return TAKEABLE_CAUSES.includes(cause);
}

/**
 * 问狼王朝谁带人。候选是全体存活玩家——他此刻已经出局，名单里本来就没有他自己。
 * 场上没别人可带走就不问，这一枪作罢。
 */
export async function decideWolfKingTake(
  wolfKing: PlayerState,
  state: GameState,
  actions: ActionProvider,
): Promise<string | null> {
  const candidates = alivePlayers(state);
  if (candidates.length === 0) return null;

  const targetId = await actions.wolfKingShot(
    wolfKing.id,
    candidates.map((player) => player.id),
  );
  if (targetId === null) return null;
  if (!candidates.some((player) => player.id === targetId)) {
    throw new Error(`狼王只能带走其他存活玩家：${targetId}`);
  }

  return targetId;
}
