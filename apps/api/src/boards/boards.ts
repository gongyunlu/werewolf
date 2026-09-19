import { ROLES } from '@werewolf/shared';
import { DEALABLE_ROLES, type DealableRole } from '../core/roles';

export const BOARD_IDS = ['12p_wolf_king', '12p_white_wolf'] as const;

export type BoardId = (typeof BOARD_IDS)[number];

export interface BoardConfig {
  name: string;
  /** 角色 → 张数 */
  roles: Partial<Record<DealableRole, number>>;
  hasSheriff: boolean; // 是否有警长
}

/** 把角色张数展开成逐张的牌，顺序按 DEALABLE_ROLES 定，跟配置里键的书写顺序无关。 */
export function handOf(board: BoardConfig): DealableRole[] {
  return DEALABLE_ROLES.flatMap((role) => Array<DealableRole>(board.roles[role] ?? 0).fill(role));
}

/**
 * 全部板子。猎人、狼王、白狼王的技能还没做，技能落地前别把带它们的板子开放给玩家。
 */
export const ALL_BOARDS: Record<BoardId, BoardConfig> = {
  '12p_wolf_king': {
    name: '标准 12 人局 · 预女猎守狼王',
    roles: {
      [ROLES.SEER]: 1,
      [ROLES.WITCH]: 1,
      [ROLES.HUNTER]: 1,
      [ROLES.GUARD]: 1,
      [ROLES.VILLAGER]: 4,
      [ROLES.WEREWOLF]: 3,
      [ROLES.WOLF_KING]: 1,
    },
    hasSheriff: true,
  },
  '12p_white_wolf': {
    name: '标准 12 人局 · 预女猎守白狼王',
    roles: {
      [ROLES.SEER]: 1,
      [ROLES.WITCH]: 1,
      [ROLES.HUNTER]: 1,
      [ROLES.GUARD]: 1,
      [ROLES.VILLAGER]: 4,
      [ROLES.WEREWOLF]: 3,
      [ROLES.WHITE_WOLF]: 1,
    },
    hasSheriff: true,
  },
};
