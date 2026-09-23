/** 随机源：返回 [0, 1) 的实数，值域与 Math.random 一致。换算成下标由调用方负责。 */
export type RandomSource = () => number;

/**
 * Fisher-Yates 洗牌，不改入参；座次、角色牌与发言顺序共用这一份抽法。
 * 随机源必填，不给 Math.random 兜底——忘了注入会静默变成不可复现。
 */
export function shuffled<T>(items: readonly T[], random: RandomSource): T[] {
  const dealt = [...items];

  for (let i = dealt.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [dealt[i], dealt[j]] = [dealt[j], dealt[i]];
  }

  return dealt;
}
