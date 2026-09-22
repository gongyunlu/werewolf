import { DEATH_CAUSES, ROLES } from '@werewolf/shared';
import { makeState, playerOf, stubActions, withRoles } from '../../testing/fixtures';
import { announceDay } from '../day/announce';
import { decideWhiteWolfTake } from './white-wolf';

/** 自爆已经落地的局面：他自己出局、其余人还活着——调用方传进来的就是这一份。 */
function blastedState() {
  const state = withRoles(makeState(6), { p1: ROLES.WHITE_WOLF, p2: ROLES.WEREWOLF });
  return announceDay(state, [{ playerId: 'p1', cause: DEATH_CAUSES.SELF_DESTRUCT }]).state;
}

describe('白狼王自爆带人', () => {
  it('候选是其他存活玩家，他自己不在里面', async () => {
    const state = blastedState();
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
    const state = blastedState();

    expect(
      await decideWhiteWolfTake(
        playerOf(state, 'p1'),
        state,
        stubActions({ whiteWolfTake: async () => null }),
      ),
    ).toBeNull();
  });

  it('带到一个候选外的人身上就抛错', async () => {
    const state = blastedState();
    const actions = stubActions({ whiteWolfTake: async () => 'p1' });

    await expect(decideWhiteWolfTake(playerOf(state, 'p1'), state, actions)).rejects.toThrow(
      '白狼王只能带走其他存活玩家：p1',
    );
  });
});
