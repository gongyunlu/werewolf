import type { RandomSource } from '../../boards/deal';
import { WOLF_DISCUSSION_ROUNDS, type ActionProvider } from '../actions';
import { inWolfChannel } from '../roles';
import { alivePlayers, type GameState } from '../state';

/**
 * 狼队今夜刀谁：先商议，再各提各的取众数，并列最高就随机挑一个。
 *
 * 商议只是让各狼听见别人的想法：发言顺序整夜只抽一次，两轮用同一个顺序、第二轮仍从首位起，
 * 后说的那些人在上下文里看得到前面说了什么。定案照旧是各提各的——商议出来的共识不算数，
 * 刀口仍是众数。只剩一只狼没人可商量，跳过商议直接问。
 *
 * 空刀在计票里和座位平权——不刀也是一次提名，空刀是投票的结果，不是开关。
 * 候选是全部存活玩家，自刀、刀狼都合法；判据是 inWolfChannel，白狼王、狼王一样有份。
 */
export async function decideWolfKill(
  state: GameState,
  actions: ActionProvider,
  random: RandomSource,
): Promise<string | null> {
  const alive = alivePlayers(state);
  const wolves = alive.filter((player) => inWolfChannel(player.role));
  // 狼全出局就没人提刀，刀口为空。
  if (wolves.length === 0) return null;

  if (wolves.length > 1) {
    const order = shuffled(
      wolves.map((wolf) => wolf.id),
      random,
    );
    for (const round of WOLF_DISCUSSION_ROUNDS) {
      for (const wolfId of order) {
        await actions.wolfSpeech(wolfId, round, order);
      }
    }
  }

  const candidates = alive.map((player) => player.id);
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

/** 抽一份发言顺序。抽法写死，同一格重进抽出来的是同一份，恢复才接得下去。 */
function shuffled(ids: readonly string[], random: RandomSource): string[] {
  const order = [...ids];
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [order[index], order[swap]] = [order[swap], order[index]];
  }

  return order;
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
