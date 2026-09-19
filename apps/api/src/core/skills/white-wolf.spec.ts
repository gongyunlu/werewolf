import { ROLES } from '@werewolf/shared';
import { makeState, playerOf, stubActions, withRoles } from '../../testing/fixtures';
import { decideWhiteWolfTake } from './white-wolf';

describe('白狼王自爆带人', () => {
  it('候选是其他存活玩家，他自己不在里面', async () => {
    const state = withRoles(makeState(6), { p1: ROLES.WHITE_WOLF, p2: ROLES.WEREWOLF });
    let offered: readonly string[] = [];
    const actions = stubActions({
      whiteWolfTake: async (_whiteWolfId, candidates) => {
        offered = candidates;
        return 'p3';
      },
    });

    expect(await decideWhiteWolfTake(playerOf(state, 'p1'), state, actions)).toBe('p3');
    expect(offered).toEqual(['p2', 'p3', 'p4', 'p5', 'p6']);
  });

  it('他可以不带人', async () => {
    const state = withRoles(makeState(6), { p1: ROLES.WHITE_WOLF, p2: ROLES.WEREWOLF });

    expect(
      await decideWhiteWolfTake(
        playerOf(state, 'p1'),
        state,
        stubActions({ whiteWolfTake: async () => null }),
      ),
    ).toBeNull();
  });

  it('已经是最后一狼就不问，也不带人', async () => {
    // 场上没有第二只狼；stubActions 没配 whiteWolfTake，真问到就会失败。
    const state = withRoles(makeState(6), { p1: ROLES.WHITE_WOLF });

    expect(await decideWhiteWolfTake(playerOf(state, 'p1'), state, stubActions())).toBeNull();
  });

  it('狼队友全出局了也算最后一狼', async () => {
    const state = withRoles(makeState(6), { p1: ROLES.WHITE_WOLF, p2: ROLES.WEREWOLF });
    const lone = {
      ...state,
      players: state.players.map((p) => (p.id === 'p2' ? { ...p, isAlive: false } : p)),
    };

    expect(await decideWhiteWolfTake(playerOf(lone, 'p1'), lone, stubActions())).toBeNull();
  });

  it('带到一个候选外的人身上就抛错', async () => {
    const state = withRoles(makeState(6), { p1: ROLES.WHITE_WOLF, p2: ROLES.WEREWOLF });
    const actions = stubActions({ whiteWolfTake: async () => 'p1' });

    await expect(decideWhiteWolfTake(playerOf(state, 'p1'), state, actions)).rejects.toThrow(
      '白狼王只能带走其他存活玩家：p1',
    );
  });
});
