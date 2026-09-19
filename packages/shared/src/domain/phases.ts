/**
 * 对局阶段取值域：局内时间轴上的位置。
 *
 * 只登记流程会停留的阶段。对局的开始与结束是发生过的**事件**（见 action-types.ts），
 * 不是玩家所处的阶段，因此不在这里。
 */
export const PHASES = {
  NIGHT: 'night', // 夜晚
  DAY_ANNOUNCE: 'day_announce', // 天亮公布死讯
  SPEECH: 'speech', // 发言
  VOTE: 'vote', // 投票
  TIE_BREAK: 'tie_break', // 平票 PK 发言与再投票
  EXECUTE: 'execute', // 执行放逐
  CHECK_WIN: 'check_win', // 胜负判定
} as const;

export type Phase = (typeof PHASES)[keyof typeof PHASES];
