import { FACTIONS, ROLES, type Faction } from '@werewolf/shared';

/**
 * 角色到发牌时阵营的初值，给 PlayerState.faction 用。阵营可以是动态的（丘比特绑定后情侣换边），
 * 判胜负看 PlayerState.faction，不是这张表。
 * 例外是预言家查验：验的是底牌，读的还是这张表，牌没换只是人换了边。
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

/** 上面那张表的键集，运行期展开牌要用，顺序同表里的书写顺序。哪几张牌还没有技能见 boards.ts。 */
export const DEALABLE_ROLES = Object.keys(ROLE_FACTIONS) as readonly DealableRole[];

export function factionOf(role: DealableRole): Faction {
  return ROLE_FACTIONS[role];
}

/**
 * 该角色是否与狼人共处狼队频道，狼队商议和刀口对它可见的依据。
 * 别并回 factionOf，也别拿 PlayerState.faction：阵营答的是和谁一起赢，这里答的是和谁通气，
 * 两者会分叉（隐狼属狼人阵营却不进狼队群，情侣换了阵营却不退群）。
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
