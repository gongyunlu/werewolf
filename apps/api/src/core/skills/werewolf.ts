import type { RandomSource } from '../../boards/deal';
import type { ActionProvider } from '../actions';
import { inWolfChannel } from '../roles';
import { alivePlayers, type GameState } from '../state';

/**
 * 狼队今夜刀谁：每只狼提一次，取众数，并列最高就随机挑一个。
 *
 * 空刀在计票里和座位平权——不刀也是一次提名，空刀是投票的结果，不是开关。
 * 候选是全部存活玩家，自刀、刀狼都合法；判据是 inWolfChannel，白狼王、狼王一样有份。
 */
export async function decideWolfKill(
  state: GameState,
  actions: ActionProvider,
  random: RandomSource,
): Promise<string | null> {
  const wolves = alivePlayers(state).filter((player) => inWolfChannel(player.role));
  // 狼全出局就没人提刀，刀口为空。
  if (wolves.length === 0) return null;

  const candidates = alivePlayers(state).map((player) => player.id);
  const proposals = await Promise.all(
    wolves.map(async (wolf) => {
      const target = await actions.wolfProposal(wolf.id, candidates);
      if (target !== null && !candidates.includes(target)) {
        throw new Error(`狼刀只能落在存活玩家身上：${target}`);
      }
      return target;
    }),
  );

  return mostProposed(proposals, random);
}

/** 取得票最多的提法；并列时随机取一个，空刀也是被抽的候选之一。 */
function mostProposed(proposals: readonly (string | null)[], random: RandomSource): string | null {
  const counts = new Map<string | null, number>();
  for (const proposal of proposals) {
    counts.set(proposal, (counts.get(proposal) ?? 0) + 1);
  }

  const most = Math.max(...counts.values());
  const tied = [...counts.entries()]
    .filter(([, count]) => count === most)
    .map(([target]) => target);

  // 没并列就不抽签，白耗随机源会让对局重放对不上。
  if (tied.length === 1) return tied[0];
  return tied[Math.floor(random() * tied.length)];
}
