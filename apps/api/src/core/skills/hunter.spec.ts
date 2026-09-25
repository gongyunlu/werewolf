import { DEATH_CAUSES, ROLES } from '@werewolf/shared';
import { makeState, playerOf, stubActions, withRoles } from '../../testing/fixtures';
import { patchPlayer } from '../state';
import { decideHunterShot, hunterCanShoot } from './hunter';

/** 六人局，p1 是猎人，已经出局。 */
function deadHunter() {
  return patchPlayer(withRoles(makeState(6), { p1: ROLES.HUNTER }), 'p1', { isAlive: false });
}

describe('猎人开枪', () => {
  it('被狼刀、被放逐、被狼王带走、被白狼王带走，都能开枪', () => {
    expect(hunterCanShoot(DEATH_CAUSES.NIGHT_KILL)).toBe(true);
    expect(hunterCanShoot(DEATH_CAUSES.EXECUTION)).toBe(true);
    expect(hunterCanShoot(DEATH_CAUSES.WOLF_KING_SHOT)).toBe(true);
    expect(hunterCanShoot(DEATH_CAUSES.WHITE_WOLF_TAKE)).toBe(true);
  });

  it('被毒、同守同救、被另一个猎人打死、自爆，都开不了枪', () => {
    expect(hunterCanShoot(DEATH_CAUSES.WITCH_POISON)).toBe(false);
    expect(hunterCanShoot(DEATH_CAUSES.DOUBLE_SAVE)).toBe(false);
    expect(hunterCanShoot(DEATH_CAUSES.HUNTER_SHOT)).toBe(false);
    expect(hunterCanShoot(DEATH_CAUSES.SELF_DESTRUCT)).toBe(false);
  });

  it('候选是其他存活玩家，已经出局的他自己不在里面', async () => {
    const state = deadHunter();
    let offered: readonly string[] = [];
    const actions = stubActions({
      hunterShot: async (_hunterId, candidates) => {
        offered = candidates;
        return 'p3';
      },
    });

    expect(await decideHunterShot(playerOf(state, 'p1'), state, actions)).toBe('p3');
    expect(offered).toEqual(['p2', 'p3', 'p4', 'p5', 'p6']);
  });

  it('他可以放弃开枪', async () => {
    const state = deadHunter();

    expect(
      await decideHunterShot(
        playerOf(state, 'p1'),
        state,
        stubActions({ hunterShot: async () => null }),
      ),
    ).toBeNull();
  });

  it('场上没别人可带走就不问，这一枪作罢', async () => {
    // 除他以外全出局了；stubActions 没配 hunterShot，真问到就会失败。
    const state = ['p2', 'p3', 'p4', 'p5', 'p6'].reduce(
      (next, playerId) => patchPlayer(next, playerId, { isAlive: false }),
      deadHunter(),
    );

    expect(await decideHunterShot(playerOf(state, 'p1'), state, stubActions())).toBeNull();
  });

  it('打到一个候选外的人身上就抛错', async () => {
    const state = deadHunter();
    const actions = stubActions({ hunterShot: async () => 'p1' });

    await expect(decideHunterShot(playerOf(state, 'p1'), state, actions)).rejects.toThrow(
      '猎人只能带走其他存活玩家：p1',
    );
  });
});
