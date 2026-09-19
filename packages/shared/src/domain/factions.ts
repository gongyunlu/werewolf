/**
 * 阵营取值域。
 *
 * 胜负判定按阵营而非按角色进行，因此阵营必须覆盖角色表里出现的全部分组：
 * 好人、狼人，以及丘比特这类自成一方、既不算好人也不算狼人的角色。
 * 某个阵营暂时没有已实现的角色，不代表它可以被删掉——那是词汇空缺，不是规则空缺。
 *
 * 好人阵营叫 GOOD 而不是 VILLAGER：它包含预言家、女巫等神职，不只是村民，
 * 而 villager 已经是平民这个**角色**的取值，同名会让「角色」和「阵营」读混。
 */
export const FACTIONS = {
  GOOD: 'good', // 好人阵营
  WEREWOLF: 'werewolf', // 狼人阵营
  THIRD_PARTY: 'third_party', // 第三方阵营
} as const;

export type Faction = (typeof FACTIONS)[keyof typeof FACTIONS];
