import { FACTIONS, ROLES } from '@werewolf/shared';
import { makeState, withRoles } from '../testing/fixtures';
import { patchPlayer } from './state';
import { checkWin } from './win';

/** 六人局：一狼、预言家、女巫，其余平民。 */
function sixPlayerBoard() {
  return withRoles(makeState(6, false), {
    p1: ROLES.WEREWOLF,
    p2: ROLES.SEER,
    p3: ROLES.WITCH,
  });
}

/** 让这批人出局。 */
function killAll(state: ReturnType<typeof sixPlayerBoard>, playerIds: readonly string[]) {
  return playerIds.reduce(
    (next, playerId) => patchPlayer(next, playerId, { isAlive: false }),
    state,
  );
}

describe('胜负判定', () => {
  it('都还活着就没分出胜负', () => {
    expect(checkWin(sixPlayerBoard())).toBeNull();
  });

  it('狼人全灭好人胜', () => {
    expect(checkWin(killAll(sixPlayerBoard(), ['p1']))).toBe(FACTIONS.GOOD);
  });

  it('神职全灭狼人胜', () => {
    expect(checkWin(killAll(sixPlayerBoard(), ['p2', 'p3']))).toBe(FACTIONS.WEREWOLF);
  });

  it('平民全灭狼人胜', () => {
    expect(checkWin(killAll(sixPlayerBoard(), ['p4', 'p5', 'p6']))).toBe(FACTIONS.WEREWOLF);
  });

  it('还剩一名神职时，屠民屠神哪边都还没凑齐', () => {
    // 剩一狼、一神、一民：两条屠边都没达成。
    expect(checkWin(killAll(sixPlayerBoard(), ['p3', 'p4', 'p5']))).toBeNull();
  });

  it('狼全灭与屠边同时达成时按好人胜', () => {
    // 神职全灭也成立，两条都中；判定的先后顺序决定谁赢。
    const state = killAll(sixPlayerBoard(), ['p1', 'p2', 'p3']);
    expect(checkWin(state)).toBe(FACTIONS.GOOD);
  });

  it('分神职还是平民读的是底牌，两边的阵营都是好人', () => {
    // 只剩一只狼和一个平民：平民没了就是屠民，跟还剩几个神职无关。
    const state = killAll(sixPlayerBoard(), ['p2', 'p3', 'p4', 'p5']);
    expect(checkWin(state)).toBe(FACTIONS.WEREWOLF);
  });
});
