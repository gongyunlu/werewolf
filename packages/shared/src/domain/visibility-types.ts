/**
 * 可见性取值域：一条事实对谁可见，只讲有没有资格知道，判据见 apps/api/src/core/visibility.ts。
 */
export const VISIBILITY_TYPES = {
  /** 公开：不设门槛，所有人可见。 */
  PUBLIC: 'public',

  /** 狼队可见：狼队频道内的事实，不是狼人阵营——隐狼属狼阵营却不进频道。 */
  WOLF: 'wolf',

  /**
   * 狼队刀口：狼队频道 + 还没用掉解药的女巫可见。跟 WOLF 分开，是因为女巫该知道刀口，
   * 不该看到狼队内部的商议。
   */
  WOLF_KILL: 'wolf_kill',

  /** 预言家可见：仅本人。 */
  SEER: 'seer',

  /** 女巫可见：仅本人。 */
  WITCH: 'witch',

  /** 系统内部：不对任何玩家可见。 */
  SYSTEM: 'system',
} as const;

export type VisibilityType = (typeof VISIBILITY_TYPES)[keyof typeof VISIBILITY_TYPES];
