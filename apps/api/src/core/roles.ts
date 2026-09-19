import { FACTIONS, ROLES, type Faction } from '@werewolf/shared';

/**
 * 角色到**发牌时**阵营的归属，给 PlayerState.faction 一个初值。
 *
 * 部分板子中阵营是动态的，如丘比特绑定后情侣改换阵营；这张表只是发牌时的初值，
 * 真实阵营记在 PlayerState.faction 上，判胜负用的是它而不是这张表。
 *
 * 这张表的键就是能进板子的角色，板子里写这以外的角色编译不过。加角色只改这张表
 * 和下面的 WOLF_CHANNEL，后者的 Record<DealableRole, …> 会强制写全，漏不掉。
 */
const ROLE_FACTIONS = {
  [ROLES.WEREWOLF]: FACTIONS.WEREWOLF,
  [ROLES.SEER]: FACTIONS.GOOD,
  [ROLES.WITCH]: FACTIONS.GOOD,
  [ROLES.GUARD]: FACTIONS.GOOD,
  [ROLES.VILLAGER]: FACTIONS.GOOD,
  [ROLES.HUNTER]: FACTIONS.GOOD,
  [ROLES.WHITE_WOLF]: FACTIONS.WEREWOLF,
  [ROLES.WOLF_KING]: FACTIONS.WEREWOLF,
} as const satisfies Record<string, Faction>;

export type DealableRole = keyof typeof ROLE_FACTIONS;

/**
 * 上面那张表的键集，运行期展开牌要用，顺序就是表里的书写顺序。
 *
 * 发得出去不代表技能会结算，哪几张牌还没有技能见 boards.ts。
 */
export const DEALABLE_ROLES = Object.keys(ROLE_FACTIONS) as readonly DealableRole[];

export function factionOf(role: DealableRole): Faction {
  return ROLE_FACTIONS[role];
}

/**
 * 该角色是否与狼人共处狼队频道——狼队商议与刀口对它可见的依据。
 *
 * 判可见性只走这里，不要并回 factionOf，也不要拿 PlayerState.faction：
 * 阵营回答「和谁一起赢」，这里回答「和谁通气」，两者会分叉（隐狼属狼人
 * 阵营却不进狼队群，情侣改换阵营却不退群）。
 */
const WOLF_CHANNEL: Record<DealableRole, boolean> = {
  [ROLES.WEREWOLF]: true,
  [ROLES.WHITE_WOLF]: true,
  [ROLES.WOLF_KING]: true,
  [ROLES.SEER]: false,
  [ROLES.WITCH]: false,
  [ROLES.GUARD]: false,
  [ROLES.VILLAGER]: false,
  [ROLES.HUNTER]: false,
};

export function inWolfChannel(role: DealableRole): boolean {
  return WOLF_CHANNEL[role];
}
