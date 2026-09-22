import { ROLES } from '@werewolf/shared';
import type { DealableRole } from '../core/roles';
import { ALL_BOARDS, BOARD_IDS, handOf, type BoardId } from './boards';

function sortedHand(boardId: BoardId): DealableRole[] {
  return handOf(ALL_BOARDS[boardId]).toSorted();
}

describe('板子定义', () => {
  it('每个板子身份都注册了一份板子', () => {
    expect(Object.keys(ALL_BOARDS).toSorted()).toEqual([...BOARD_IDS].toSorted());
  });

  it('狼王局是 3 狼 + 狼王 + 预言家/女巫/猎人/守卫 + 4 平民', () => {
    // 逐张列出整副牌，改漏一张这里就红，不用另设人数字段来核对。
    expect(sortedHand('12p_wolf_king')).toEqual([
      ROLES.GUARD,
      ROLES.HUNTER,
      ROLES.SEER,
      ROLES.VILLAGER,
      ROLES.VILLAGER,
      ROLES.VILLAGER,
      ROLES.VILLAGER,
      ROLES.WEREWOLF,
      ROLES.WEREWOLF,
      ROLES.WEREWOLF,
      ROLES.WITCH,
      ROLES.WOLF_KING,
    ]);
  });

  it('白狼王局与狼王局只差狼侧那一张', () => {
    // 把狼王换成白狼王再比整份牌。别改成集合相减，那样看不出张数差异。
    const swapped = [
      ...sortedHand('12p_wolf_king').filter((role) => role !== ROLES.WOLF_KING),
      ROLES.WHITE_WOLF,
    ].toSorted();

    expect(swapped).toEqual(sortedHand('12p_white_wolf'));
  });

  it('6 人板是预言家/守卫 + 2 平民 + 狼人/白狼王', () => {
    // 同上，逐张列出整副牌；人数由这张表管着，不另设人数字段。
    expect(sortedHand('6p_white_wolf')).toEqual([
      ROLES.GUARD,
      ROLES.SEER,
      ROLES.VILLAGER,
      ROLES.VILLAGER,
      ROLES.WEREWOLF,
      ROLES.WHITE_WOLF,
    ]);
  });

  it('每块板子都带警长', () => {
    for (const boardId of BOARD_IDS) {
      expect(ALL_BOARDS[boardId].hasSheriff).toBe(true);
    }
  });
});
