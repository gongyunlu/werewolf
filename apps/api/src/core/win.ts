import { FACTIONS, ROLES, type Faction } from '@werewolf/shared';
import { alivePlayers, type GameState } from './state';

/**
 * 胜负判定：屠边。狼人全灭好人胜；神职全灭或平民全灭，狼人胜；都没达成返回 null。
 *
 * 阵营读 PlayerState.faction，只有分「神职还是平民」时才读 role——两者阵营都是好人，
 * 光看阵营分不出边。这两条口径别并成一个。第三方阵营判不出来：丘比特还发不出牌。
 */
export function checkWin(state: GameState): Faction | null {
  const alive = alivePlayers(state);
  // 狼人全灭优先于屠边：两边同时达成时按好人胜（旧项目 checkWinCondition 同序）。
  if (alive.every((player) => player.faction !== FACTIONS.WEREWOLF)) return FACTIONS.GOOD;

  const godCount = alive.filter(
    (player) => player.faction === FACTIONS.GOOD && player.role !== ROLES.VILLAGER,
  ).length;
  const villagerCount = alive.filter(
    (player) => player.faction === FACTIONS.GOOD && player.role === ROLES.VILLAGER,
  ).length;
  if (godCount === 0 || villagerCount === 0) return FACTIONS.WEREWOLF;

  return null;
}
