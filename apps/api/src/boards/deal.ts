import type { DealableRole } from '../core/roles';

/** 随机源：返回 [0, 1) 的实数，值域与 Math.random 一致。换算成下标由调用方负责。 */
export type RandomSource = () => number;

/**
 * Fisher-Yates 洗牌，不改入参：板子的角色列表是共享常量，就地洗会污染下一局。
 * 随机源必填，不给 Math.random 兜底——忘了注入会静默变成不可复现。
 * 座位号不在这里发，由建局快照按下标 + 1 配。
 */
export function dealRoles(roles: readonly DealableRole[], random: RandomSource): DealableRole[] {
  const dealt = [...roles];

  for (let i = dealt.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [dealt[i], dealt[j]] = [dealt[j], dealt[i]];
  }

  return dealt;
}
