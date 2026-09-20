import { DEATH_CAUSES, ROLES, type DeathCause } from '@werewolf/shared';
import type { ActionProvider } from './actions';
import { announceDay, type NightDeath } from './day/announce';
import { decideHunterShot, hunterCanShoot } from './skills/hunter';
import { decideWolfKingTake, wolfKingCanTake } from './skills/wolf-king';
import type { GameState, PlayerState } from './state';

/**
 * 结算出局技能：把这一批死者挨个问一遍，能带走人的就带走，被带走的人接着也要问。
 * 队列驱动，连锁不设深度上限——规则允许就一直传下去，一人只出局一次。
 *
 * 白狼王不在这儿：他只在自爆时带人，见 day/self-destruct.ts。
 * 传进来的这批人已经出局了（公布死讯、放逐执行都落过地），这里只管技能新带出来的人。
 */
export async function triggerDeathSkills(
  state: GameState,
  deaths: readonly NightDeath[],
  actions: ActionProvider,
  observe?: (state: GameState) => void,
): Promise<GameState> {
  let current = state;
  // 边遍历边往尾巴上追加，连锁就自动排进了同一轮。
  const pending = [...deaths];

  for (let index = 0; index < pending.length; index += 1) {
    const death = pending[index];
    const player = current.players.find((candidate) => candidate.id === death.playerId);
    if (!player) throw new Error(`死讯里的玩家不在局内：${death.playerId}`);

    const shot = await takeBySkill(player, current, death.cause, actions);
    if (shot === null) continue;

    // 带走的人先落地再入队；撞上已经出局的人会在这里抛错，一人只公布一次死讯。
    current = announceDay(current, [shot]).state;
    // 下一个要问的人该看到他已经出局，见 GameLoopInput.observe。
    observe?.(current);
    pending.push(shot);
  }

  return current;
}

/** 按角色问这一条死因下的出局技能；带不走人返回 null。 */
async function takeBySkill(
  player: PlayerState,
  state: GameState,
  cause: DeathCause,
  actions: ActionProvider,
): Promise<NightDeath | null> {
  switch (player.role) {
    case ROLES.HUNTER:
      if (!hunterCanShoot(cause)) return null;
      return toDeath(await decideHunterShot(player, state, actions), DEATH_CAUSES.HUNTER_SHOT);
    case ROLES.WOLF_KING:
      if (!wolfKingCanTake(cause)) return null;
      return toDeath(await decideWolfKingTake(player, state, actions), DEATH_CAUSES.WOLF_KING_SHOT);
    default:
      return null;
  }
}

function toDeath(playerId: string | null, cause: DeathCause): NightDeath | null {
  return playerId === null ? null : { playerId, cause };
}
