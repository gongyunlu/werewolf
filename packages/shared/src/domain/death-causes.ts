/**
 * 死亡原因取值域。
 *
 * 只登记当前规则真的能造成的死因。死因参与复盘与展示，也是「同守同救」这类
 * 结算优先级的判定依据，所以每种致死途径要有各自的取值，不能合并成一种。
 */
export const DEATH_CAUSES = {
  NIGHT_KILL: 'night_kill', // 狼人夜刀
  WITCH_POISON: 'witch_poison', // 女巫毒杀
  EXECUTION: 'execution', // 白天投票放逐
  SELF_DESTRUCT: 'self_destruct', // 狼人自爆
} as const;

export type DeathCause = (typeof DEATH_CAUSES)[keyof typeof DEATH_CAUSES];
