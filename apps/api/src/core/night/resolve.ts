import { DEATH_CAUSES } from '@werewolf/shared';
import type { NightDeath } from '../day/announce';

/** 夜间行动的落点，按玩家 id 记，null 表示没做这个行动。 */
export interface NightActions {
  wolfTargetId: string | null;
  guardTargetId: string | null;
  /** 解药落点，只可能等于刀口，不会是别人。 */
  antidoteTargetId: string | null;
  poisonTargetId: string | null;
}

/**
 * 夜间结算：四个落点合成今晨的死者名单。
 *
 * 守与救在刀口上互相抵消：只中一个才活，两个一起中反而死，记 double_save。
 * 毒药独立生效，盾挡不住毒；既被刀又被毒的取毒，NightDeath 只装得下一个死因。
 */
export function resolveNight(actions: NightActions): NightDeath[] {
  const { wolfTargetId, guardTargetId, antidoteTargetId, poisonTargetId } = actions;
  const deaths: NightDeath[] = [];

  if (wolfTargetId !== null) {
    const guarded = guardTargetId === wolfTargetId;
    const saved = antidoteTargetId === wolfTargetId;
    // 只命中一个时人活着，不记死讯。
    if (guarded && saved) {
      deaths.push({ playerId: wolfTargetId, cause: DEATH_CAUSES.DOUBLE_SAVE });
    } else if (!guarded && !saved) {
      deaths.push({ playerId: wolfTargetId, cause: DEATH_CAUSES.NIGHT_KILL });
    }
  }

  if (poisonTargetId !== null) {
    const alreadyDead = deaths.find((death) => death.playerId === poisonTargetId);
    if (alreadyDead) alreadyDead.cause = DEATH_CAUSES.WITCH_POISON;
    else deaths.push({ playerId: poisonTargetId, cause: DEATH_CAUSES.WITCH_POISON });
  }

  return deaths;
}
