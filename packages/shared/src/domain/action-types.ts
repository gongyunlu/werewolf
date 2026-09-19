/**
 * 事件（行动）类型取值域：对局里发生过的一件事实属于哪一类。
 *
 * 一个类型的取值同时表达「谁做了什么事」和「这事对谁可见」——可见范围由事件的
 * visibility 字段单独标注，取值见 visibility-types.ts。
 * 例如狼队夜间商议与白天的公开发言是同一个类型 speech，区别只在 visibility。
 *
 * 只登记当前规则真的会产生的事件。添加角色时再追加它自己的技能类型。
 *
 * 约束：只可追加，不可重命名或删除已用取值（历史记录仍持有旧字符串）。
 */
export const ACTION_TYPES = {
  // —— 生命周期 ——
  GAME_STARTED: 'game_started', // 对局开始
  PHASE_CHANGED: 'phase_changed', // 阶段切换
  GAME_ENDED: 'game_ended', // 对局结束

  // —— 通用行动 ——
  JUDGE_ANNOUNCE: 'judge_announce', // 法官公开播报
  SPEECH: 'speech', // 发言（狼队商议为 visibility 为 wolf 的同类事件）
  SPEECH_ORDER_DETERMINED: 'speech_order_determined', // 发言顺序确定
  VOTE: 'vote', // 投票
  PLAYER_EXECUTED: 'player_executed', // 投票放逐结算

  // —— 死亡与结算 ——
  NIGHT_RESOLVED: 'night_resolved', // 夜间结算，仅内部记录
  PLAYER_DIED: 'player_died', // 次日公布的死讯
  PEACEFUL_NIGHT: 'peaceful_night', // 平安夜公告，当晚无人死亡

  // —— 狼人 ——
  WOLF_PROPOSAL: 'wolf_proposal', // 狼队内部提刀
  WOLF_KILL: 'wolf_kill', // 狼队最终刀口
  WOLF_EXPLODE: 'wolf_explode', // 狼人自爆

  // —— 预言家 ——
  SEER_CHECK: 'seer_check', // 查验

  // —— 女巫 ——
  WITCH_SAVE: 'witch_save', // 使用解药
  WITCH_POISON: 'witch_poison', // 使用毒药
} as const;

export type ActionType = (typeof ACTION_TYPES)[keyof typeof ACTION_TYPES];
