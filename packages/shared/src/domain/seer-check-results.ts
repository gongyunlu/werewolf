/**
 * 预言家查验结果取值域。只问是不是狼人阵营、不问角色，所以狼王、白狼王和普通狼人验出来一样。
 * 判据是底牌阵营（被丘比特绑过改了阵营的也按原阵营验），跟判胜负看此刻阵营的口径不同。
 */
export const SEER_CHECK_RESULTS = {
  GOOD: 'good', // 好人阵营
  WEREWOLF: 'werewolf', // 狼人阵营
} as const;

export type SeerCheckResult = (typeof SEER_CHECK_RESULTS)[keyof typeof SEER_CHECK_RESULTS];
