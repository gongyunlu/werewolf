import { FACTIONS, ROLES, type Faction } from '@werewolf/shared';

/**
 * 引擎支持的角色：能被发牌、能参与对局的那部分。
 *
 * shared 的 ROLES 是完整的角色词汇表，这里才是其中引擎支持的子集。发牌只会
 * 分配这些角色；板子配置里出现其余角色说明引擎还不支持，应当被拒绝而不是发出去。
 *
 * 清单里加进一个角色，就意味着它的规则要跟着落地——否则发出去的牌没人管。
 */
export const SUPPORTED_ROLES = [
  ROLES.WEREWOLF,
  ROLES.SEER,
  ROLES.WITCH,
  ROLES.VILLAGER,
  ROLES.HUNTER,
  ROLES.WHITE_WOLF,
  ROLES.WOLF_KING,
] as const;

export type SupportedRole = (typeof SUPPORTED_ROLES)[number];

/**
 * 角色到**基础**阵营的归属。
 *
 * 只登记引擎支持的角色：胜负判定按阵营进行，给不支持的角色编一个阵营
 * 等于假装它能参与判定。未登记的取值在类型上就进不来。
 *
 * 「基础」——对局内阵营可能被改写：丘比特绑定后两人与他同属第三方。那时的
 * 当前阵营记在 PlayerState.faction 上，这张表只负责发牌时的初值。
 */
const ROLE_FACTIONS: Record<SupportedRole, Faction> = {
  [ROLES.WEREWOLF]: FACTIONS.WEREWOLF,
  [ROLES.SEER]: FACTIONS.GOOD,
  [ROLES.WITCH]: FACTIONS.GOOD,
  [ROLES.VILLAGER]: FACTIONS.GOOD,
  [ROLES.HUNTER]: FACTIONS.GOOD,
  [ROLES.WHITE_WOLF]: FACTIONS.WEREWOLF,
  [ROLES.WOLF_KING]: FACTIONS.WEREWOLF,
};

export function factionOf(role: SupportedRole): Faction {
  return ROLE_FACTIONS[role];
}

/**
 * 该角色是否与狼人共处狼队频道——狼队商议与刀口对它可见的依据。
 *
 * 与 factionOf 回答的不是同一个问题：阵营回答「和谁一起赢」，这里回答
 * 「和谁通气」。当前角色里两者恰好重合，但角色词汇表里两个方向都有反例：
 * 隐狼与石像鬼属狼人阵营却不进狼队群（与普通狼人互不可见），情侣改换阵营
 * 却仍留在狼队群。判可见性只走这里，不要并回 factionOf，也不要拿
 * PlayerState.faction。
 *
 * 独立登记成表，不从 ROLE_FACTIONS 派生：派生会把「进不进狼队群」悄悄绑死
 * 在阵营上——加隐狼、石像鬼时阵营填 werewolf，狼队频道就被自动推导出来，
 * 而类型检查不拦（它只强制你回答阵营）。登记成表，Record 的穷尽性才会逼你
 * 回答这个问题本身。
 */
const WOLF_CHANNEL: Record<SupportedRole, boolean> = {
  [ROLES.WEREWOLF]: true,
  [ROLES.WHITE_WOLF]: true,
  [ROLES.WOLF_KING]: true,
  [ROLES.SEER]: false,
  [ROLES.WITCH]: false,
  [ROLES.VILLAGER]: false,
  [ROLES.HUNTER]: false,
};

export function inWolfChannel(role: SupportedRole): boolean {
  return WOLF_CHANNEL[role];
}
