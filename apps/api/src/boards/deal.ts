import type { DealableRole } from '../core/roles';

/** 随机源：返回 [0, 1) 的实数，值域与 Math.random 一致。换算成下标由调用方负责。 */
export type RandomSource = () => number;

/**
 * 把角色逐张发出：Fisher-Yates 洗牌，返回洗好的序列，不修改入参。
 *
 * 板子的角色列表是模块级共享常量，就地洗会污染下一局。座位号不在这里发，
 * 它就是下标 + 1，由建局快照配对。
 *
 * 随机源必填，不给 Math.random 当默认值：忘了注入会静默退化成不可复现，
 * 而发牌是整局唯一一次不可复现的输入，这种错要在编译期发生。
 */
export function dealRoles(roles: readonly DealableRole[], random: RandomSource): DealableRole[] {
  const dealt = [...roles];

  for (let i = dealt.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [dealt[i], dealt[j]] = [dealt[j], dealt[i]];
  }

  return dealt;
}
