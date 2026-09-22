import type { RandomSource } from '../boards/deal';
import type { ActionScope } from './identity';

/**
 * 某一格的随机流：由对局标识与节点实例现算，而不是接着调用方手里那一串往下抽。
 *
 * 用得上它的都在狼队那一格（见 skills/werewolf.ts）：先用它把商议顺序洗一遍，提刀并列时再抽一个。
 * 但恢复会重进同一格：抽出来的数变了，顺序和刀口就跟着变，同一局重跑一遍得到的就不是同一场对局。
 * 按格现算之后，同一局同一格进多少次都是同一串，整局与进程、与谁先跑过无关地可复现。
 *
 * 调用方那个随机源只剩发牌用（见 boards/deal.ts）：发牌在开局之前，不进任何一格。
 */
export function stageRandom(scope: ActionScope): RandomSource {
  let state = seedOf(`${scope.gameId}|${scope.phaseInstanceId}`);

  return () => {
    // mulberry32：一个 32 位状态的短生成器，洗一次顺序、抽一次并列够用了。
    state = (state + 0x6d2b79f5) | 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a：把两个标识揉成一个 32 位数当种子，同样的输入必得同样的种子。 */
function seedOf(text: string): number {
  let seed = 0x811c9dc5;

  for (let index = 0; index < text.length; index += 1) {
    seed ^= text.charCodeAt(index);
    seed = Math.imul(seed, 0x01000193);
  }

  return seed >>> 0;
}
