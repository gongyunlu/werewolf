/**
 * 事件（行动）类型取值域。取值只说谁做了什么事，对谁可见由事件的 visibility 另标
 * （见 visibility-types.ts）：狼队商议和白天发言都是 speech，区别只在 visibility。
 * 只可追加，删改取值等于让历史记录失去含义。
 *
 * 引擎向玩家提问时也拿它标「问的是哪件事」，而「问」与「做成」未必是同一个取值：
 * 女巫一次睁眼问的是 witch_decision，真用了药才记 witch_save / witch_poison。
 */
export const ACTION_TYPES = {
  // —— 生命周期 ——
  GAME_STARTED: 'game_started', // 对局开始
  PHASE_CHANGED: 'phase_changed', // 阶段切换
  GAME_ENDED: 'game_ended', // 对局结束

  // —— 通用行动 ——
  JUDGE_ANNOUNCE: 'judge_announce', // 法官公开播报
  SPEECH: 'speech', // 发言
  SPEECH_ORDER_DETERMINED: 'speech_order_determined', // 发言顺序确定
  VOTE: 'vote', // 投票
  PLAYER_EXECUTED: 'player_executed', // 投票放逐结算

  // —— 死亡与结算 ——
  NIGHT_RESOLVED: 'night_resolved', // 夜间结算，仅内部记录
  PLAYER_DIED: 'player_died', // 次日公布的死讯
  PEACEFUL_NIGHT: 'peaceful_night', // 平安夜公告，当晚无人死亡

  // —— 狼人 ——
  WOLF_PROPOSAL: 'wolf_proposal', // 狼队内部提刀
  WOLF_DISCUSSION_CONTINUE: 'wolf_discussion_continue', // 是否继续狼队商议
  WOLF_KILL: 'wolf_kill', // 狼队最终刀口
  WOLF_EXPLODE: 'wolf_explode', // 狼人自爆

  // —— 预言家 ——
  SEER_CHECK: 'seer_check', // 查验

  // —— 女巫 ——
  WITCH_DECISION: 'witch_decision', // 睁眼后的取舍，问的是决定本身
  WITCH_SAVE: 'witch_save', // 使用解药
  WITCH_POISON: 'witch_poison', // 使用毒药

  // —— 守卫 ——
  GUARD_PROTECT: 'guard_protect', // 守护

  // —— 出局时触发的技能 ——
  HUNTER_SHOT: 'hunter_shot', // 猎人开枪
  WOLF_KING_SHOT: 'wolf_king_shot', // 狼王带人
  WHITE_WOLF_TAKE: 'white_wolf_take', // 白狼王自爆带人

  // —— 警长流程 ——
  SHERIFF_CANDIDACY: 'sheriff_candidacy', // 上警报名
  SHERIFF_WITHDRAW: 'sheriff_withdraw', // 退水
  SHERIFF_TRANSFER: 'sheriff_transfer', // 警徽移交或撕毁
  SHERIFF_DECIDE_ORDER: 'sheriff_decide_order', // 警长定发言方向
} as const;

export type ActionType = (typeof ACTION_TYPES)[keyof typeof ACTION_TYPES];
