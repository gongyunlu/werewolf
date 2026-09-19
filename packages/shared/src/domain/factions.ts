/**
 * 阵营取值域：判胜负按阵营，所以要覆盖角色表里的全部分组，某阵营暂时没角色也不代表能删。
 * 好人叫 GOOD 不叫 VILLAGER：它还含神职，而 villager 已经是平民这个角色的取值，
 * 同名容易把角色和阵营读混。
 */
export const FACTIONS = {
  GOOD: 'good', // 好人阵营
  WEREWOLF: 'werewolf', // 狼人阵营
  THIRD_PARTY: 'third_party', // 第三方阵营
} as const;

export type Faction = (typeof FACTIONS)[keyof typeof FACTIONS];
