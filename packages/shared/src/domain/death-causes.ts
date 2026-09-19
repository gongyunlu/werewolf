/** 死亡原因取值域。每种致死途径各自一个值，结算优先级要靠它区分，不能合并。 */
export const DEATH_CAUSES = {
  NIGHT_KILL: 'night_kill', // 狼人夜刀
  WITCH_POISON: 'witch_poison', // 女巫毒杀
  DOUBLE_SAVE: 'double_save', // 同守同救：守卫与解药同时命中，两种保护互相抵消
  EXECUTION: 'execution', // 白天投票放逐
  SELF_DESTRUCT: 'self_destruct', // 狼人自爆
} as const;

export type DeathCause = (typeof DEATH_CAUSES)[keyof typeof DEATH_CAUSES];
