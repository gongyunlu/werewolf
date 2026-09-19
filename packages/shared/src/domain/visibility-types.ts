/**
 * 可见性取值域：一条事实对谁可见。
 *
 * 可见性只描述「有没有资格知道」，不描述「此刻能不能拿到」。
 * 判断某条事实对某名玩家是否可见的完整口径见 `apps/api/src/core/visibility.ts`。
 */
export const VISIBILITY_TYPES = {
  /** 公开：不设门槛，所有人可见。出局者不再参与对局，但仍能看到此后的公开事实。 */
  PUBLIC: 'public',

  /** 狼队可见：狼人阵营内部的事实。 */
  WOLF: 'wolf',

  /**
   * 狼队刀口：狼人阵营 + 尚未用掉解药的女巫可见。
   *
   * 与 WOLF 分开是因为女巫能知道刀口，但不该看到狼队内部的商议过程。
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
