import { DEATH_CAUSES, type DeathCause } from '@werewolf/shared';
import type { ActionProvider } from '../actions';
import { alivePlayers, type GameState, type PlayerState } from '../state';

/**
 * 猎人能开枪的死因：被狼刀、被放逐、被狼王带走、被白狼王带走。
 * 被毒、同守同救、被另一个猎人打死，都开不了。
 *
 * 狼王那一侧不同：他被同守同救照样带人，见 wolf-king.ts。
 */
const SHOOTABLE_CAUSES: readonly DeathCause[] = [
  DEATH_CAUSES.NIGHT_KILL,
  DEATH_CAUSES.EXECUTION,
  DEATH_CAUSES.WOLF_KING_SHOT,
  DEATH_CAUSES.WHITE_WOLF_TAKE,
];

export function hunterCanShoot(cause: DeathCause): boolean {
  return SHOOTABLE_CAUSES.includes(cause);
}

/**
 * 问猎人朝谁开枪。目标是全体非猎人的存活玩家。
 * 场上没别人可带走就不问，这一枪作罢。
 */
export async function decideHunterShot(
  hunter: PlayerState,
  state: GameState,
  actions: ActionProvider,
): Promise<string | null> {
  const candidates = alivePlayers(state);
  if (candidates.length === 0) return null;

  const targetId = await actions.hunterShot(
    hunter.id,
    candidates.map((player) => player.id),
  );
  if (targetId === null) return null;
  if (!candidates.some((player) => player.id === targetId)) {
    throw new Error(`猎人只能带走其他存活玩家：${targetId}`);
  }

  return targetId;
}
